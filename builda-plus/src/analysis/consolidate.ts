import { STAGE_IDS, type Role, type StageId } from '../domain/journey';
import type { EvidenceSource } from '../domain/schemas';
import { assessConfidence, type ConfidenceAssessment } from '../engine/confidence';
import { aggregateEstimate } from '../engine/impact';
import type { Playbook } from '../knowledge/playbook';

// Cross-role comparison (brief §4 step 6). Pure and deterministic.

export interface AnalysisEvidence {
  id: string; participantRef: string; role: Role; source: EvidenceSource;
  painPointKey: string; stageId: StageId; taskDescription: string;
  monthlyVolume: number | null; minutesPerOccurrence: number | null;
  systems: string[]; reportedCause: string | null; potentialImprovement: string | null;
  supportingQuote: string; outstandingQuestions: string[]; conversionAssumptions: string[];
  createdAt: Date;
}
export interface KeyMerge { canonicalKey: string; mergedKeys: string[]; reason: string }
export interface Estimate { value: number | null; min: number | null; max: number | null; n: number }
export interface RoleValue { role: Role; value: number }
export type Measurement = 'monthlyVolume' | 'minutesPerOccurrence';

export interface ConsolidatedPainPoint {
  key: string; title: string; stageId: StageId;
  roles: Role[]; participantRefs: string[]; evidenceIds: string[];
  volume: Estimate; minutes: Estimate;
  confidence: ConfidenceAssessment;
  disagreementsByRole: { field: Measurement; values: RoleValue[] }[];
  systems: string[]; causes: string[]; improvements: string[]; outstandingQuestions: string[];
  quotesByRole: { role: Role; quote: string }[];
  conversionAssumptions: string[];
  missingMeasurements: Measurement[];
  reportedByFirmLead: boolean;
}

export interface CrossRoleFindings {
  painPoints: ConsolidatedPainPoint[];
  agreements: string[];        // reported consistently by 2+ participants
  disagreements: string[];     // materially different figures, preserved for review
  blindSpots: string[];        // reported by staff, not mentioned by the firm lead
  unreportedStages: StageId[]; // no evidence at all
  missingMeasurements: string[];
}

// Applies model-suggested merges, but only ones that are valid: every key must exist,
// no key may appear twice, and a playbook key always wins as the canonical name.
export function applyKeyMerges(evidence: AnalysisEvidence[], proposed: KeyMerge[], playbook: Playbook): { evidence: AnalysisEvidence[]; applied: KeyMerge[] } {
  const existing = new Set(evidence.map((e) => e.painPointKey));
  const playbookKeys = new Set(playbook.cards.map((c) => c.id));
  const used = new Set<string>();
  const rename = new Map<string, string>();
  const applied: KeyMerge[] = [];
  for (const m of proposed) {
    const group = [...new Set([m.canonicalKey, ...m.mergedKeys])].filter((k) => existing.has(k));
    if (group.length < 2 || group.some((k) => used.has(k))) continue;
    const pb = group.filter((k) => playbookKeys.has(k));
    if (pb.length > 1) continue; // never merge two distinct playbook pain points
    const canonical = pb[0] ?? (group.includes(m.canonicalKey) ? m.canonicalKey : group[0]!);
    group.forEach((k) => { used.add(k); if (k !== canonical) rename.set(k, canonical); });
    applied.push({ canonicalKey: canonical, mergedKeys: group.filter((k) => k !== canonical), reason: m.reason });
  }
  return { evidence: evidence.map((e) => (rename.has(e.painPointKey) ? { ...e, painPointKey: rename.get(e.painPointKey)! } : e)), applied };
}

function latestByParticipant(rs: AnalysisEvidence[], field: Measurement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of [...rs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const v = r[field];
    if (v !== null && r.source === 'firm_said') out[r.participantRef] = v;
  }
  return out;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const mode = <T,>(xs: T[]): T => {
  const counts = new Map<T, number>();
  xs.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
};

export function consolidate(evidence: AnalysisEvidence[], opts: { playbook: Playbook; firmLeadInterviewed: boolean }): CrossRoleFindings {
  const byKey = new Map<string, AnalysisEvidence[]>();
  evidence.forEach((e) => byKey.set(e.painPointKey, [...(byKey.get(e.painPointKey) ?? []), e]));
  const roleOf = new Map(evidence.map((e) => [e.participantRef, e.role]));

  const painPoints: ConsolidatedPainPoint[] = [...byKey.entries()].map(([key, rs]) => {
    const card = opts.playbook.cards.find((c) => c.id === key);
    const vol = latestByParticipant(rs, 'monthlyVolume');
    const mins = latestByParticipant(rs, 'minutesPerOccurrence');
    const confidence = assessConfidence(rs.map((r) => ({ participantRef: r.participantRef, source: r.source, monthlyVolume: r.monthlyVolume, minutesPerOccurrence: r.minutesPerOccurrence })));
    const volume = aggregateEstimate(vol), minutes = aggregateEstimate(mins);
    return {
      key,
      title: card?.title ?? rs[0]!.taskDescription,
      stageId: card?.stageId ?? mode(rs.map((r) => r.stageId)),
      roles: uniq(rs.map((r) => r.role)),
      participantRefs: uniq(rs.map((r) => r.participantRef)),
      evidenceIds: rs.map((r) => r.id).sort(),
      volume, minutes, confidence,
      // Shown to the firm lead by role, never by participant.
      disagreementsByRole: confidence.disagreements.map((d) => ({
        field: d.field,
        values: Object.entries(d.byParticipant).map(([ref, value]) => ({ role: roleOf.get(ref)!, value })).sort((a, b) => a.value - b.value),
      })),
      systems: uniq(rs.flatMap((r) => r.systems)),
      causes: uniq(rs.map((r) => r.reportedCause).filter((x): x is string => !!x)),
      improvements: uniq(rs.map((r) => r.potentialImprovement).filter((x): x is string => !!x)),
      outstandingQuestions: uniq(rs.flatMap((r) => r.outstandingQuestions)),
      quotesByRole: rs.map((r) => ({ role: r.role, quote: r.supportingQuote })),
      conversionAssumptions: uniq(rs.flatMap((r) => r.conversionAssumptions)),
      missingMeasurements: [volume.n === 0 ? 'monthlyVolume' : null, minutes.n === 0 ? 'minutesPerOccurrence' : null].filter((x): x is Measurement => !!x),
      reportedByFirmLead: rs.some((r) => r.role === 'firm_lead'),
    };
  }).sort((a, b) => STAGE_IDS.indexOf(a.stageId) - STAGE_IDS.indexOf(b.stageId) || a.key.localeCompare(b.key));

  const covered = new Set(evidence.map((e) => e.stageId));
  return {
    painPoints,
    agreements: painPoints.filter((p) => p.participantRefs.length >= 2 && p.confidence.disagreements.length === 0).map((p) => p.key),
    disagreements: painPoints.filter((p) => p.confidence.disagreements.length > 0).map((p) => p.key),
    blindSpots: opts.firmLeadInterviewed ? painPoints.filter((p) => !p.reportedByFirmLead && p.roles.some((r) => r !== 'firm_lead')).map((p) => p.key) : [],
    unreportedStages: STAGE_IDS.filter((s) => !covered.has(s)),
    missingMeasurements: painPoints.filter((p) => p.missingMeasurements.length > 0).map((p) => p.key),
  };
}

// Targeted follow-ups (brief §4 step 6). Written by code, so wording never reveals who said what.
export interface PlannedFollowUp { participantRef: string; painPointKey: string; stageId: StageId; question: string; reason: 'disagreement' | 'missing_measurement' }

export function planFollowUps(findings: CrossRoleFindings, evidence: AnalysisEvidence[], opts: { maxPerParticipant?: number; exclude?: Set<string> } = {}): PlannedFollowUp[] {
  const max = opts.maxPerParticipant ?? 3;
  const plan: PlannedFollowUp[] = [];
  const count = new Map<string, number>();
  const add = (f: PlannedFollowUp) => {
    if (opts.exclude?.has(f.participantRef)) return;
    if ((count.get(f.participantRef) ?? 0) >= max) return;
    if (plan.some((p) => p.participantRef === f.participantRef && p.painPointKey === f.painPointKey)) return;
    count.set(f.participantRef, (count.get(f.participantRef) ?? 0) + 1);
    plan.push(f);
  };
  const fmt = (field: Measurement, v: number) => field === 'minutesPerOccurrence' ? `${v} minutes` : `${v} a month`;

  for (const p of findings.painPoints) {
    for (const d of p.confidence.disagreements) {
      for (const ref of Object.keys(d.byParticipant)) {
        add({ participantRef: ref, painPointKey: p.key, stageId: p.stageId, reason: 'disagreement',
          question: `Estimates for “${p.title.toLowerCase()}” varied across the team, from about ${fmt(d.field, d.min)} to ${fmt(d.field, d.max)}. Could you walk me through a typical case, so we can understand what makes it quicker or slower?` });
      }
    }
  }
  for (const p of findings.painPoints) {
    if (p.missingMeasurements.length === 0) continue;
    const ask = p.missingMeasurements.length === 2 ? 'roughly how often does it happen in a month, and how long does each one take'
      : p.missingMeasurements[0] === 'monthlyVolume' ? 'roughly how often does it happen in a month' : 'roughly how long does each one take';
    for (const ref of p.participantRefs) {
      add({ participantRef: ref, painPointKey: p.key, stageId: p.stageId, reason: 'missing_measurement',
        question: `Earlier you mentioned ${p.title.charAt(0).toLowerCase() + p.title.slice(1)}. ${ask.charAt(0).toUpperCase() + ask.slice(1)}?` });
    }
  }
  return plan;
}
