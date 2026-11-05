import { describe, expect, it } from 'vitest';
import { applyKeyMerges, consolidate, planFollowUps, type AnalysisEvidence } from '../src/analysis/consolidate';
import { classifyPainPoint } from '../src/analysis/classify';
import { buildOpportunities, type PainPointForScoring } from '../src/analysis/opportunities';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';
import { ScriptedProvider } from '../src/llm/mock';
import { startFollowUp, handleParticipantMessage } from '../src/interview/orchestrator';

let n = 0;
const ev = (over: Partial<AnalysisEvidence>): AnalysisEvidence => ({
  id: `e${++n}`, participantRef: 'P1', role: 'case_manager', source: 'firm_said', painPointKey: 'document_chasing', stageId: 'documents',
  taskDescription: 'Chasing documents', monthlyVolume: 150, minutesPerOccurrence: 20, systems: ['Email'], reportedCause: null,
  potentialImprovement: null, supportingQuote: 'we chase about 150 a month', outstandingQuestions: [], conversionAssumptions: [],
  createdAt: new Date(2026, 10, 1, 9, n), ...over,
});

describe('cross-role comparison', () => {
  it('merges only valid keys and keeps the playbook key as canonical', () => {
    const evidence = [ev({ painPointKey: 'chasing_docs' }), ev({ painPointKey: 'document_chasing', participantRef: 'P2' }), ev({ painPointKey: 'status_calls' })];
    const { evidence: out, applied } = applyKeyMerges(evidence, [
      { canonicalKey: 'chasing_docs', mergedKeys: ['document_chasing'], reason: 'same task' },
      { canonicalKey: 'status_calls', mergedKeys: ['does_not_exist'], reason: 'bogus' },
    ], SEED_PLAYBOOK);
    expect(applied).toEqual([{ canonicalKey: 'document_chasing', mergedKeys: ['chasing_docs'], reason: 'same task' }]);
    expect(out.map((e) => e.painPointKey)).toEqual(['document_chasing', 'document_chasing', 'status_calls']);
  });

  it('finds agreements, disagreements by role, blind spots, gaps and missing figures', () => {
    const f = consolidate([
      ev({ participantRef: 'P1', minutesPerOccurrence: 10 }),
      ev({ participantRef: 'P2', role: 'adviser', minutesPerOccurrence: 45 }),
      ev({ participantRef: 'P1', painPointKey: 'case_status_updates', stageId: 'offer', monthlyVolume: 120, minutesPerOccurrence: 5 }),
      ev({ participantRef: 'P3', role: 'administrator', painPointKey: 'case_status_updates', stageId: 'offer', monthlyVolume: 100, minutesPerOccurrence: 6 }),
      ev({ participantRef: 'P4', role: 'firm_lead', painPointKey: 'case_status_updates', stageId: 'offer', monthlyVolume: 110, minutesPerOccurrence: 5 }),
      ev({ participantRef: 'P3', role: 'administrator', painPointKey: 'diary_management', stageId: 'enquiry', monthlyVolume: null, minutesPerOccurrence: null }),
    ], { playbook: SEED_PLAYBOOK, firmLeadInterviewed: true });

    expect(f.disagreements).toEqual(['document_chasing']);
    const dc = f.painPoints.find((p) => p.key === 'document_chasing')!;
    expect(dc.disagreementsByRole[0]!.values).toEqual([{ role: 'case_manager', value: 10 }, { role: 'adviser', value: 45 }]);
    expect(JSON.stringify(dc.disagreementsByRole)).not.toMatch(/P1|P2/);
    expect(f.agreements).toEqual(['case_status_updates']);
    expect(f.blindSpots.sort()).toEqual(['diary_management', 'document_chasing']);
    expect(f.missingMeasurements).toEqual(['diary_management']);
    expect(f.unreportedStages).toContain('completion');
  });

  it('plans follow-ups that never reveal who said what, capped per person', () => {
    const evidence = [ev({ participantRef: 'P1', minutesPerOccurrence: 10 }), ev({ participantRef: 'P2', role: 'adviser', minutesPerOccurrence: 45 })];
    const plan = planFollowUps(consolidate(evidence, { playbook: SEED_PLAYBOOK, firmLeadInterviewed: false }), evidence);
    expect(plan.map((p) => p.participantRef).sort()).toEqual(['P1', 'P2']);
    expect(plan[0]!.question).toMatch(/from about 10 minutes to 45 minutes/);
    expect(plan[0]!.question).not.toMatch(/you said|adviser|case manager/i);
  });
});

describe('follow-up interview mode', () => {
  it('asks queued questions without calling the model for wording, and forces the key', async () => {
    const llm = new ScriptedProvider({
      'interview.interpret': [{ evidence: [{ painPointKey: 'something_else', stageId: 'documents', taskDescription: 'Chasing', responsibleRole: 'case_manager',
        volume: null, timePerOccurrence: { value: 15, unit: 'minutes' }, peopleInvolved: null, systems: [], operationalImpact: null, reportedCause: 'Clients send partial packs',
        potentialImprovement: null, supportingQuote: 'usually 15 minutes', outstandingQuestions: [] }],
        stagesConfirmedNotInvolved: [], flags: { clientInformation: false, complaintOrCompliance: false, employmentIssue: false, adviceRequest: false, outOfScope: false },
        wantsToPause: false, answerWasVague: false }],
    });
    const { state, reply } = startFollowUp({ discoveryId: 'd', participantRef: 'P1', role: 'case_manager',
      items: [{ id: 'f1', painPointKey: 'document_chasing', stageId: 'documents', question: 'Could you walk me through a typical case?' }] });
    expect(reply).toMatch(/one short question/);
    const out = await handleParticipantMessage(state, 'It is usually 15 minutes unless the pack is partial', { llm, playbook: SEED_PLAYBOOK });
    expect(out.state.status).toBe('completed');
    expect(out.state.evidence[0]!.painPointKey).toBe('document_chasing');
    expect(llm.calls.map((c) => c.task)).toEqual(['interview.interpret']);
  });
});

describe('classification guardrails', () => {
  const pp = consolidate([ev({}), ev({ participantRef: 'P2', minutesPerOccurrence: 25 })], { playbook: SEED_PLAYBOOK, firmLeadInterviewed: false }).painPoints[0]!;
  it('accepts a proposal whose quotes are real', async () => {
    const llm = new ScriptedProvider({ 'analysis.classify': [{ classification: 'automate', rationale: 'Repetitive structured follow-ups.', supportingQuotes: ['we chase about 150 a month'], humanElements: [] }] });
    expect(await classifyPainPoint(llm, pp, SEED_PLAYBOOK.cards[0]!)).toMatchObject({ classification: 'automate', source: 'ai_proposed', requiresComplianceReview: false });
  });
  it('falls back to the playbook when the model invents a quote', async () => {
    const llm = new ScriptedProvider({ 'analysis.classify': [{ classification: 'overhaul', rationale: 'The whole process is broken.', supportingQuotes: ['everything is broken'], humanElements: [] }] });
    expect(await classifyPainPoint(llm, pp, SEED_PLAYBOOK.cards[0]!)).toMatchObject({ classification: 'automate', source: 'playbook' });
  });
  it('flags compliance review for regulated stages', async () => {
    const reg = { ...pp, key: 'suitability_letter_drafting', stageId: 'recommendation' as const };
    const llm = new ScriptedProvider({ 'analysis.classify': [{ classification: 'automate', rationale: 'Template drafting of the letter.', supportingQuotes: ['we chase about 150 a month'], humanElements: ['Adviser decides'] }] });
    expect((await classifyPainPoint(llm, reg, null)).requiresComplianceReview).toBe(true);
  });
});

describe('opportunity building', () => {
  const base: PainPointForScoring = { id: 'pp1', key: 'document_chasing', title: 'Document chasing', stageId: 'documents', classification: 'automate',
    confidence: 'medium', volume: 150, minutes: 20, overrides: {}, conversionAssumptions: [], requiresComplianceReview: false };
  it('uses the template reduction as a labelled assumption and pre-checks two-week eligibility', () => {
    const [o] = buildOpportunities([base], null);
    expect(o!.impact.monthlyHoursRecovered).toBe(25);
    expect(o!.assumptions[0]).toMatch(/50%.*not yet measured/);
    expect(o!.twoWeek.status).toBe('blocked');
    expect(o!.twoWeek.blockers).toEqual(['Template "Document chasing with staff-approved reminders" is not yet tested']);
  });
  it('applies firm-lead overrides and leaves recovery unknown without a template or reduction', () => {
    const [a, b] = buildOpportunities([
      { ...base, overrides: { minutesPerOccurrence: 30 } },
      { ...base, id: 'pp2', key: 'diary', classification: 'fix', confidence: 'low' },
    ], { loadedHourlyCostGBP: 20 } as any);
    expect(a!.impact.monthlyHoursRecovered).toBe(37.5);
    expect(a!.impact.monthlyCapacityValueGBP).toBe(750);
    expect(a!.assumptions).toContain('Time per occurrence corrected by the firm lead');
    expect(b!.impact.monthlyHoursRecovered).toBeNull();
    expect(a!.rank).toBe(1);
    expect(a!.explanation.length).toBeGreaterThan(0);
  });
  it('excludes unclassified pain points with a reason', () => {
    const [o] = buildOpportunities([{ ...base, classification: null }], null);
    expect(o!.rank).toBeNull();
    expect(o!.excludedReason).toBe('Not yet classified');
  });
});
