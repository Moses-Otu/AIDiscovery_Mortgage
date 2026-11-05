import { z } from 'zod';
import { withFirmContext, type Db, type FirmContext, type Tx } from '../db/pool';
import { insertAudit, insertSession, NotFoundError } from '../db/repositories';
import { CLASSIFICATIONS, ROLE_LABELS, STAGE_IDS, STAGES, type Classification, type Role, type StageId } from '../domain/journey';
import { StageIdSchema } from '../domain/schemas';
import type { LLMProvider } from '../llm/provider';
import type { Playbook } from '../knowledge/playbook';
import { applyKeyMerges, consolidate, planFollowUps, type AnalysisEvidence, type ConsolidatedPainPoint, type CrossRoleFindings } from './consolidate';
import { classifyPainPoint, proposeKeyMerges } from './classify';
import { buildOpportunities, type PainPointForScoring } from './opportunities';
import { FirmProfileSchema } from '../firm/profile';
import { DEFAULT_SCORING_CONFIG } from '../engine/scoring';
import type { ConfidenceOrInsufficient } from '../engine/confidence';
import { startFollowUp } from '../interview/orchestrator';
import type { Mailer } from '../firm/mailer';
import { hashToken, newInvitationToken } from '../http/tokens';

type Actor = FirmContext & { userId: string };

export interface PainPointSummary {
  evidenceIds: string[]; roles: Role[]; participantCount: number;
  volume: ConsolidatedPainPoint['volume']; minutes: ConsolidatedPainPoint['minutes'];
  disagreementsByRole: ConsolidatedPainPoint['disagreementsByRole'];
  quotesByRole: ConsolidatedPainPoint['quotesByRole'];
  systems: string[]; causes: string[]; improvements: string[]; outstandingQuestions: string[];
  conversionAssumptions: string[]; missingMeasurements: string[]; classificationRationale?: string;
}

export const CorrectionSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('classification'), value: z.enum(CLASSIFICATIONS), reason: z.string().min(3).max(1000) }),
  z.object({ field: z.literal('title'), value: z.string().min(3).max(300), reason: z.string().min(3).max(1000) }),
  z.object({ field: z.literal('stageId'), value: StageIdSchema, reason: z.string().min(3).max(1000) }),
  z.object({ field: z.literal('monthlyVolume'), value: z.number().min(0).max(100000).nullable(), reason: z.string().min(3).max(1000) }),
  z.object({ field: z.literal('minutesPerOccurrence'), value: z.number().min(0).max(10000).nullable(), reason: z.string().min(3).max(1000) }),
  z.object({ field: z.literal('reductionPct'), value: z.number().min(0).max(1).nullable(), reason: z.string().min(3).max(1000) }),
  z.object({ field: z.literal('validated'), value: z.boolean(), reason: z.string().max(1000).default('') }),
]);
export type Correction = z.infer<typeof CorrectionSchema>;

export type Playback = Awaited<ReturnType<AnalysisService["playback"]>>;

export class AnalysisService {
  constructor(private db: Db, private deps: { providerFor: (ctx: { orgId: string; discoveryId: string }) => LLMProvider; playbook: Playbook; playbookFor?: (ctx: FirmContext, discoveryId: string) => Promise<Playbook>; mailer?: Mailer | null; appBaseUrl: string }) {}

  playbookFor(ctx: FirmContext, discoveryId: string): Promise<Playbook> {
    return this.deps.playbookFor ? this.deps.playbookFor(ctx, discoveryId) : Promise.resolve(this.deps.playbook);
  }

  private async loadEvidence(tx: Tx, discoveryId: string): Promise<AnalysisEvidence[]> {
    const r = await tx.query(
      `select e.*, p.role as participant_role from evidence_records e
         left join participants p on p.discovery_id = e.discovery_id and p.pseudonym = e.participant_pseudonym
        where e.discovery_id = $1 order by e.created_at`, [discoveryId]);
    return r.rows.map((x) => ({
      id: x.id, participantRef: x.participant_pseudonym ?? 'firm', role: (x.participant_role ?? x.responsible_role) as Role,
      source: x.source, painPointKey: x.pain_point_key, stageId: x.stage_id, taskDescription: x.task_description,
      monthlyVolume: x.monthly_volume === null ? null : Number(x.monthly_volume),
      minutesPerOccurrence: x.minutes_per_occurrence === null ? null : Number(x.minutes_per_occurrence),
      systems: x.systems, reportedCause: x.reported_cause, potentialImprovement: x.potential_improvement,
      supportingQuote: x.supporting_quote, outstandingQuestions: x.outstanding_questions, conversionAssumptions: x.conversion_assumptions,
      createdAt: x.created_at,
    }));
  }

  // Milestones 5–6: consolidate across roles, classify, then score. Uses the model only for
  // key merging and classification proposals; everything else is deterministic.
  async analyse(ctx: Actor, discoveryId: string): Promise<CrossRoleFindings> {
    const llm = this.deps.providerFor({ orgId: ctx.orgId, discoveryId });
    const { evidence, firmLeadInterviewed, existing } = await withFirmContext(this.db, ctx, async (tx) => {
      const d = await tx.query('select 1 from discoveries where id = $1', [discoveryId]);
      if (!d.rows[0]) throw new NotFoundError('Discovery not found');
      const lead = await tx.query(
        `select 1 from interview_sessions s join participants p on p.id = s.participant_id
          where s.discovery_id = $1 and p.role = 'firm_lead' and s.kind = 'main' and s.status = 'completed'`, [discoveryId]);
      const ex = await tx.query('select key, classification, classification_source, evidence_summary from pain_points where discovery_id = $1', [discoveryId]);
      return { evidence: await this.loadEvidence(tx, discoveryId), firmLeadInterviewed: (lead.rowCount ?? 0) > 0, existing: new Map(ex.rows.map((r) => [r.key, r])) };
    });

    const playbook = await this.playbookFor(ctx, discoveryId);
    const playbookKeys = playbook.cards.map((c) => c.id);
    const keys = [...new Set(evidence.map((e) => e.painPointKey))];
    const proposed = await proposeKeyMerges(llm, keys.map((k) => ({ key: k, descriptions: evidence.filter((e) => e.painPointKey === k).map((e) => e.taskDescription) })), playbookKeys);
    const merged = applyKeyMerges(evidence, proposed, playbook);
    const findings = consolidate(merged.evidence, { playbook, firmLeadInterviewed });

    // Classify only what changed; firm-lead decisions are never overwritten.
    const classifications = new Map<string, Awaited<ReturnType<typeof classifyPainPoint>> | null>();
    for (const pp of findings.painPoints) {
      const prev = existing.get(pp.key);
      const sameEvidence = prev && JSON.stringify(prev.evidence_summary?.evidenceIds ?? []) === JSON.stringify(pp.evidenceIds);
      if (prev?.classification_source === 'firm_lead' || (sameEvidence && prev.classification)) { classifications.set(pp.key, null); continue; }
      classifications.set(pp.key, await classifyPainPoint(llm, pp, playbook.cards.find((c) => c.id === pp.key) ?? null));
    }

    await withFirmContext(this.db, ctx, async (tx) => {
      for (const pp of findings.painPoints) {
        const summary: PainPointSummary = {
          evidenceIds: pp.evidenceIds, roles: pp.roles, participantCount: pp.participantRefs.length, volume: pp.volume, minutes: pp.minutes,
          disagreementsByRole: pp.disagreementsByRole, quotesByRole: pp.quotesByRole, systems: pp.systems, causes: pp.causes,
          improvements: pp.improvements, outstandingQuestions: pp.outstandingQuestions, conversionAssumptions: pp.conversionAssumptions,
          missingMeasurements: pp.missingMeasurements,
        };
        const c = classifications.get(pp.key);
        await tx.query(
          `insert into pain_points (org_id, discovery_id, key, stage_id, title, classification, classification_rationale, classification_source,
                                    requires_compliance_review, confidence, confidence_detail, evidence_summary)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (discovery_id, key) do update set
             evidence_summary = excluded.evidence_summary, confidence = excluded.confidence, confidence_detail = excluded.confidence_detail,
             classification = case when $13 then excluded.classification else pain_points.classification end,
             classification_rationale = case when $13 then excluded.classification_rationale else pain_points.classification_rationale end,
             classification_source = case when $13 then excluded.classification_source else pain_points.classification_source end,
             requires_compliance_review = case when $13 then excluded.requires_compliance_review else pain_points.requires_compliance_review end,
             updated_at = now()`,
          [ctx.orgId, discoveryId, pp.key, pp.stageId, pp.title, c?.classification ?? null, c?.rationale ?? null, c?.source ?? null,
           c?.requiresComplianceReview ?? STAGES[pp.stageId].regulatedJudgement, pp.confidence.level, { level: pp.confidence.level, reasons: pp.confidence.reasons, participantCount: pp.confidence.participantCount }, summary, c !== null && c !== undefined]);
      }
      await tx.query('insert into analysis_runs (org_id, discovery_id, findings, key_merges, playbook_version) values ($1,$2,$3,$4,$5)',
        [ctx.orgId, discoveryId, JSON.stringify({ ...findingsForStorage(findings), firmLeadInterviewed }), JSON.stringify(merged.applied), playbook.version]);
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: `user:${ctx.userId}`, action: 'analysis.run',
        metadata: { painPoints: findings.painPoints.length, merges: merged.applied.length, classified: [...classifications.values()].filter(Boolean).length } }]);
    });
    await this.rescore(ctx, discoveryId);
    return findings;
  }

  // Deterministic re-scoring from stored pain points. Runs after analysis and after every correction.
  async rescore(ctx: Actor, discoveryId: string): Promise<void> {
    await withFirmContext(this.db, ctx, async (tx) => {
      const d = await tx.query('select firm_profile from discoveries where id = $1', [discoveryId]);
      if (!d.rows[0]) throw new NotFoundError('Discovery not found');
      const profile = FirmProfileSchema.safeParse(d.rows[0].firm_profile);
      const r = await tx.query('select * from pain_points where discovery_id = $1', [discoveryId]);
      const pps: PainPointForScoring[] = r.rows.map((x) => ({
        id: x.id, key: x.key, title: x.title, stageId: x.stage_id, classification: x.classification,
        confidence: x.confidence as ConfidenceOrInsufficient,
        volume: x.evidence_summary?.volume?.value ?? null, minutes: x.evidence_summary?.minutes?.value ?? null,
        overrides: x.overrides ?? {}, conversionAssumptions: x.evidence_summary?.conversionAssumptions ?? [],
        requiresComplianceReview: x.requires_compliance_review,
      }));
      const built = buildOpportunities(pps, profile.success ? profile.data : null, DEFAULT_SCORING_CONFIG);
      await tx.query('delete from opportunities where discovery_id = $1', [discoveryId]);
      for (const o of built) {
        await tx.query(
          `insert into opportunities (org_id, discovery_id, pain_point_id, impact, score, score_breakdown, scoring_config_version, rank, feasibility, assumptions, explanation)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [ctx.orgId, discoveryId, o.painPointId, o.impact, o.score, JSON.stringify(o.breakdown), DEFAULT_SCORING_CONFIG.version, o.rank,
           { ...o.twoWeek, excludedReason: o.excludedReason }, JSON.stringify(o.assumptions), JSON.stringify(o.explanation)]);
      }
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: 'system', action: 'opportunities.rescored', metadata: { configVersion: DEFAULT_SCORING_CONFIG.version, count: built.length } }]);
    });
  }

  // Milestone 5: send targeted follow-ups based on the latest analysis.
  async sendFollowUps(ctx: Actor, discoveryId: string): Promise<{ participants: number; questions: number; links: { name: string; link: string }[] }> {
    const playbook = await this.playbookFor(ctx, discoveryId);
    const plan = await withFirmContext(this.db, ctx, async (tx) => {
      const live = await tx.query("select p.pseudonym from interview_sessions s join participants p on p.id = s.participant_id where s.discovery_id = $1 and s.status in ('in_progress','paused')", [discoveryId]);
      const exclude = new Set<string>(live.rows.map((r) => r.pseudonym));
      const evidence = await this.loadEvidence(tx, discoveryId);
      const merges = await tx.query('select key_merges from analysis_runs where discovery_id = $1 order by created_at desc limit 1', [discoveryId]);
      const merged = applyKeyMerges(evidence, merges.rows[0]?.key_merges ?? [], playbook).evidence;
      return planFollowUps(consolidate(merged, { playbook, firmLeadInterviewed: false }), merged, { exclude });
    });
    const byRef = new Map<string, typeof plan>();
    plan.forEach((f) => byRef.set(f.participantRef, [...(byRef.get(f.participantRef) ?? []), f]));

    const emails: { to: string; name: string; link: string }[] = [];
    await withFirmContext(this.db, ctx, async (tx) => {
      for (const [ref, items] of byRef) {
        const p = await tx.query('select id, role, email, display_name from participants where discovery_id = $1 and pseudonym = $2', [discoveryId, ref]);
        const participant = p.rows[0];
        if (!participant) continue;
        const ids: string[] = [];
        for (const f of items) {
          const r = await tx.query(
            `insert into follow_ups (org_id, discovery_id, participant_id, pain_point_key, stage_id, question, reason, status)
             values ($1,$2,$3,$4,$5,$6,$7,'asked') returning id`,
            [ctx.orgId, discoveryId, participant.id, f.painPointKey, f.stageId, f.question, f.reason]);
          ids.push(r.rows[0].id);
        }
        const { state } = startFollowUp({ discoveryId, participantRef: ref, role: participant.role,
          items: items.map((f, i) => ({ id: ids[i]!, painPointKey: f.painPointKey, stageId: f.stageId as StageId, question: f.question })) });
        await insertSession(tx, { orgId: ctx.orgId, participantId: participant.id, state, kind: 'follow_up' });
        const token = newInvitationToken();
        await tx.query(`insert into invitations (org_id, discovery_id, participant_id, token_hash, expires_at) values ($1,$2,$3,$4, now() + interval '14 days')`,
          [ctx.orgId, discoveryId, participant.id, hashToken(token)]);
        // Any earlier link for this person is switched off; the new one opens the follow-up.
        await tx.query('update invitations set expires_at = now() where participant_id = $1 and token_hash <> $2 and expires_at > now()', [participant.id, hashToken(token)]);
        emails.push({ to: participant.email ?? '', name: participant.display_name, link: `${this.deps.appBaseUrl}/i/${token}` });
      }
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: `user:${ctx.userId}`, action: 'follow_ups.sent', metadata: { participants: byRef.size, questions: plan.length } }]);
    });
    for (const e of emails) {
      if (!this.deps.mailer || !e.to) continue;
      await this.deps.mailer.send({ to: e.to, subject: 'A few short follow-up questions',
        text: `Hi ${e.name},\n\nThanks for taking part in the process review. After comparing answers across the team, there are a few short questions where a little more detail would help. It should take under five minutes.\n\nContinue here: ${e.link}\n\nAs before, please leave out client names and case details.` });
    }
    return { participants: byRef.size, questions: plan.length, links: emails.map((e) => ({ name: e.name, link: e.link })) };
  }

  // Milestone 7: firm playback.
  async playback(ctx: FirmContext, discoveryId: string) {
    return withFirmContext(this.db, ctx, async (tx) => {
      const run = await tx.query('select findings, created_at from analysis_runs where discovery_id = $1 order by created_at desc limit 1', [discoveryId]);
      const rows = await tx.query(
        `select pp.*, o.impact, o.score, o.rank, o.feasibility, o.assumptions, o.explanation, o.score_breakdown
           from pain_points pp left join opportunities o on o.pain_point_id = pp.id where pp.discovery_id = $1`, [discoveryId]);
      const progress = await tx.query(
        `select p.role, coalesce((select s.status::text from interview_sessions s where s.participant_id = p.id and s.kind = 'main' order by s.started_at desc limit 1), 'not started') as status
           from participants p where p.discovery_id = $1`, [discoveryId]);
      const corrections = await tx.query('select entity_id, field, old_value, new_value, reason, created_at from corrections where discovery_id = $1 order by created_at', [discoveryId]);

      const painPoints = rows.rows.map((x) => ({
        id: x.id, key: x.key, title: x.title, stageId: x.stage_id as StageId, stageName: STAGES[x.stage_id as StageId].name,
        classification: x.classification as Classification | null, classificationSource: x.classification_source, classificationRationale: x.classification_rationale,
        requiresComplianceReview: x.requires_compliance_review, validated: x.validated_by_firm_lead,
        confidence: x.confidence, confidenceReasons: x.confidence_detail?.reasons ?? [],
        roles: (x.evidence_summary?.roles ?? []).map((r: Role) => ROLE_LABELS[r]),
        participantCount: x.evidence_summary?.participantCount ?? 0,
        volume: x.evidence_summary?.volume ?? null, minutes: x.evidence_summary?.minutes ?? null, overrides: x.overrides,
        disagreements: (x.evidence_summary?.disagreementsByRole ?? []).map((d: any) => ({ field: d.field, values: d.values.map((v: any) => ({ role: ROLE_LABELS[v.role as Role], value: v.value })) })),
        quotes: (x.evidence_summary?.quotesByRole ?? []).map((q: any) => ({ role: ROLE_LABELS[q.role as Role], quote: q.quote })),
        systems: (x.evidence_summary?.systems ?? []) as string[], causes: x.evidence_summary?.causes ?? [], improvements: x.evidence_summary?.improvements ?? [],
        outstandingQuestions: x.evidence_summary?.outstandingQuestions ?? [], missingMeasurements: x.evidence_summary?.missingMeasurements ?? [],
        impact: x.impact, score: x.score === null ? null : Number(x.score), rank: x.rank, twoWeek: x.feasibility,
        assumptions: x.assumptions ?? [], explanation: x.explanation ?? [],
        corrections: corrections.rows.filter((c) => c.entity_id === x.id),
      }));
      painPoints.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || STAGE_IDS.indexOf(a.stageId) - STAGE_IDS.indexOf(b.stageId));
      const ranked = painPoints.filter((p) => p.rank !== null);
      const findings = run.rows[0]?.findings ?? null;
      return {
        analysedAt: run.rows[0]?.created_at ?? null,
        participation: progress.rows.map((r) => ({ role: ROLE_LABELS[r.role as Role], status: r.status })),
        journey: STAGE_IDS.map((s) => ({ id: s, name: STAGES[s].name, regulatedJudgement: STAGES[s].regulatedJudgement,
          painPoints: painPoints.filter((p) => p.stageId === s).map((p) => p.id) })),
        painPoints,
        topThree: ranked.slice(0, 3).map((p) => p.id),
        crossRole: findings ? {
          agreements: findings.agreements, disagreements: findings.disagreements, blindSpots: findings.blindSpots, firmLeadInterviewed: !!findings.firmLeadInterviewed,
          unreportedStages: (findings.unreportedStages as StageId[]).map((s) => STAGES[s].name), missingMeasurements: findings.missingMeasurements,
        } : null,
        scoringConfigVersion: DEFAULT_SCORING_CONFIG.version,
      };
    });
  }

  async correct(ctx: Actor, discoveryId: string, painPointId: string, input: unknown): Promise<void> {
    const c = CorrectionSchema.parse(input);
    await withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query('select * from pain_points where id = $1 and discovery_id = $2 for update', [painPointId, discoveryId]);
      const pp = r.rows[0];
      if (!pp) throw new NotFoundError('Pain point not found');
      let oldValue: unknown;
      switch (c.field) {
        case 'classification':
          oldValue = pp.classification;
          await tx.query(`update pain_points set classification = $1, classification_source = 'firm_lead', classification_rationale = $2, updated_at = now() where id = $3`, [c.value, `Set by firm lead: ${c.reason}`, painPointId]);
          break;
        case 'title':
          oldValue = pp.title;
          await tx.query('update pain_points set title = $1, updated_at = now() where id = $2', [c.value, painPointId]);
          break;
        case 'stageId':
          oldValue = pp.stage_id;
          await tx.query('update pain_points set stage_id = $1, requires_compliance_review = $2 or requires_compliance_review, updated_at = now() where id = $3', [c.value, STAGES[c.value].regulatedJudgement, painPointId]);
          break;
        case 'validated':
          oldValue = pp.validated_by_firm_lead;
          await tx.query('update pain_points set validated_by_firm_lead = $1, updated_at = now() where id = $2', [c.value, painPointId]);
          break;
        default: {
          oldValue = pp.overrides?.[c.field] ?? null;
          const overrides = { ...(pp.overrides ?? {}) };
          if (c.value === null) delete overrides[c.field]; else overrides[c.field] = c.value;
          await tx.query('update pain_points set overrides = $1, updated_at = now() where id = $2', [overrides, painPointId]);
        }
      }
      await tx.query(
        `insert into corrections (org_id, discovery_id, entity_type, entity_id, field, old_value, new_value, reason, corrected_by)
         values ($1,$2,'pain_point',$3,$4,$5,$6,$7,$8)`,
        [ctx.orgId, discoveryId, painPointId, c.field, JSON.stringify(oldValue ?? null), JSON.stringify(c.value), c.reason, ctx.userId]);
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: `user:${ctx.userId}`, action: 'pain_point.corrected', entityType: 'pain_point', entityId: painPointId, metadata: { field: c.field } }]);
    });
    await this.rescore(ctx, discoveryId);
  }
}

// Stored findings keep keys and role-level detail only — no pseudonyms.
function findingsForStorage(f: CrossRoleFindings) {
  return {
    agreements: f.agreements, disagreements: f.disagreements, blindSpots: f.blindSpots,
    unreportedStages: f.unreportedStages, missingMeasurements: f.missingMeasurements,
    painPoints: f.painPoints.map((p) => ({ key: p.key, roles: p.roles, participantCount: p.participantRefs.length, confidence: p.confidence.level })),
  };
}
