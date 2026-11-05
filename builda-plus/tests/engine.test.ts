import { describe, expect, it } from 'vitest';
import { calculateImpact, aggregateEstimate } from '../src/engine/impact';
import { assessConfidence } from '../src/engine/confidence';
import { rankOpportunities, explainRanking, validateConfig, DEFAULT_SCORING_CONFIG, type OpportunityInput } from '../src/engine/scoring';
import { assessTwoWeekFeasibility } from '../src/engine/feasibility';

describe('impact', () => {
  it('reproduces the brief §6.1 example', () => {
    const r = calculateImpact({ monthlyVolume: 150, minutesPerOccurrence: 20, reductionPct: 0.6, loadedHourlyCostGBP: null, implementationCostGBP: null });
    expect(r.monthlyHoursSpent).toBe(50);
    expect(r.monthlyHoursRecovered).toBe(30);
    expect(r.monthlyCapacityValueGBP).toBeNull();
    expect(r.unknowns).toEqual(['Labour cost per hour', 'Implementation cost']);
  });
  it('never invents figures when inputs are missing', () => {
    const r = calculateImpact({ monthlyVolume: null, minutesPerOccurrence: 20, reductionPct: 0.6, loadedHourlyCostGBP: 25, implementationCostGBP: 5000 });
    expect([r.monthlyHoursSpent, r.monthlyHoursRecovered, r.monthlyCapacityValueGBP, r.paybackMonths]).toEqual([null, null, null, null]);
  });
  it('computes payback only when costs are known', () => {
    const r = calculateImpact({ monthlyVolume: 150, minutesPerOccurrence: 20, reductionPct: 0.6, loadedHourlyCostGBP: 25, implementationCostGBP: 4500 });
    expect(r.monthlyCapacityValueGBP).toBe(750);
    expect(r.paybackMonths).toBe(6);
  });
  it('takes the median and keeps the range', () => {
    expect(aggregateEstimate({ P1: 10, P2: 20, P3: 60 })).toEqual({ value: 20, min: 10, max: 60, n: 3 });
  });
});

describe('confidence', () => {
  const said = (p: string, v: number | null, m: number | null) => ({ participantRef: p, source: 'firm_said' as const, monthlyVolume: v, minutesPerOccurrence: m });
  it('single participant is low', () => expect(assessConfidence([said('P1', 150, 20)]).level).toBe('low'));
  it('consistent multiple accounts are medium', () => expect(assessConfidence([said('P1', 150, 20), said('P2', 140, 30)]).level).toBe('medium'));
  it('adds records -> high', () => expect(assessConfidence([said('P1', 150, 20), said('P2', 140, 30), { participantRef: 'firm', source: 'operational_record', monthlyVolume: 148, minutesPerOccurrence: null }]).level).toBe('high'));
  it('disagreement stays low and is preserved', () => {
    const a = assessConfidence([said('P1', 150, 10), said('P2', 150, 45)]);
    expect(a.level).toBe('low');
    expect(a.disagreements[0]).toMatchObject({ field: 'minutesPerOccurrence', min: 10, max: 45 });
  });
  it('assumptions alone are insufficient', () => expect(assessConfidence([{ participantRef: 'x', source: 'assumption', monthlyVolume: 100, minutesPerOccurrence: 10 }]).level).toBe('insufficient'));
});

describe('scoring', () => {
  const base = (over: Partial<OpportunityInput>): OpportunityInput => ({
    id: 'x', title: 'x', stageId: 'documents', classification: 'automate', monthlyVolume: 150,
    impact: calculateImpact({ monthlyVolume: 150, minutesPerOccurrence: 20, reductionPct: 0.6, loadedHourlyCostGBP: null, implementationCostGBP: null }),
    confidence: 'medium', templateAvailable: true, complexity: 'low', ...over,
  });
  it('ranks document chasing above a low-volume regulated-stage task, and explains why', () => {
    const chasing = base({ id: 'document_chasing' });
    const letters = base({ id: 'suitability_admin', stageId: 'recommendation', monthlyVolume: 30, templateAvailable: false, complexity: 'medium', confidence: 'low',
      impact: calculateImpact({ monthlyVolume: 30, minutesPerOccurrence: 20, reductionPct: 0.3, loadedHourlyCostGBP: null, implementationCostGBP: null }) });
    const { ranked } = rankOpportunities([letters, chasing]);
    expect(ranked.map((r) => r.input.id)).toEqual(['document_chasing', 'suitability_admin']);
    const why = explainRanking(ranked[0]!, ranked[1]!);
    expect(why[0]).toMatch(/^impact/);
    expect(why.some((w) => w.startsWith('risk'))).toBe(true);
  });
  it('excludes keep-human and insufficient-evidence items', () => {
    const { ranked, excluded } = rankOpportunities([base({ id: 'a', classification: 'keep_human' }), base({ id: 'b', confidence: 'insufficient' }), base({ id: 'c' })]);
    expect(ranked.map((r) => r.input.id)).toEqual(['c']);
    expect(excluded.map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('rejects weights that do not sum to 1', () => {
    expect(() => validateConfig({ ...DEFAULT_SCORING_CONFIG, weights: { ...DEFAULT_SCORING_CONFIG.weights, impact: 0.9 } })).toThrow();
  });
});

describe('two-week feasibility', () => {
  const ok = { classification: 'automate' as const, singleWorkflowWithStartAndFinish: true, templateId: 'document_chasing_v1', templateTested: true, changesCoreSystems: false,
    accessAndTestDataReadyDayOne: true, humanApprovalForCommsAndRecordChanges: true, complianceQuestionsResolved: true, unresolvedDependencies: [] };
  it('qualifies when every condition holds', () => expect(assessTwoWeekFeasibility(ok).qualifies).toBe(true));
  it('lists every failure', () => {
    const r = assessTwoWeekFeasibility({ ...ok, templateTested: false, changesCoreSystems: true, unresolvedDependencies: ['Lender portal API access'] });
    expect(r.qualifies).toBe(false);
    expect(r.failures).toHaveLength(3);
  });
});
