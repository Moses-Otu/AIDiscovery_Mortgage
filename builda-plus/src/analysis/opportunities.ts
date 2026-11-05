import { STAGES, type Classification, type StageId } from '../domain/journey';
import type { ConfidenceOrInsufficient } from '../engine/confidence';
import { calculateImpact, type ImpactResult } from '../engine/impact';
import { DEFAULT_SCORING_CONFIG, explainRanking, rankOpportunities, type OpportunityInput, type ScoringConfig } from '../engine/scoring';
import { templateFor, type AutomationTemplate } from '../knowledge/templates';
import type { FirmProfile } from '../firm/profile';

// Opportunity building (brief §6, §7). Deterministic: re-runs after every correction without the model.

export interface PainPointForScoring {
  id: string; key: string; title: string; stageId: StageId;
  classification: Classification | null;
  confidence: ConfidenceOrInsufficient;
  volume: number | null; minutes: number | null;                       // consolidated medians
  overrides: { monthlyVolume?: number | null; minutesPerOccurrence?: number | null; reductionPct?: number | null };
  conversionAssumptions: string[];
  requiresComplianceReview: boolean;
}

export interface TwoWeekPrecheck { status: 'blocked' | 'provisional'; blockers: string[]; toConfirmInEngineeringReview: string[] }

export interface BuiltOpportunity {
  painPointId: string;
  impact: ImpactResult;
  assumptions: string[];
  score: number | null;
  rank: number | null;
  breakdown: unknown;
  explanation: string[];
  twoWeek: TwoWeekPrecheck;
  excludedReason: string | null;
}

const ENGINEERING_CHECKS = [
  'One workflow with a clear start and finish',
  "No changes to the firm's core systems",
  'Access and test data ready on day one',
  'No unresolved dependencies',
];

export function precheckTwoWeek(pp: PainPointForScoring, template: AutomationTemplate | null): TwoWeekPrecheck {
  const blockers: string[] = [];
  if (pp.classification !== 'automate') blockers.push(pp.classification ? `Classified "${pp.classification}", not "automate"` : 'Not yet classified');
  if (!template) blockers.push('No JADA automation template');
  else if (!template.tested) blockers.push(`Template "${template.name}" is not yet tested`);
  if (pp.requiresComplianceReview) blockers.push('Compliance questions must be resolved first (regulated stage)');
  if (template && !template.humanApprovalBuiltIn) blockers.push('Template lacks a human approval step');
  return { status: blockers.length ? 'blocked' : 'provisional', blockers, toConfirmInEngineeringReview: ENGINEERING_CHECKS };
}

export function buildOpportunities(pps: PainPointForScoring[], profile: FirmProfile | null, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG, templates?: AutomationTemplate[]): BuiltOpportunity[] {
  const prepared = pps.map((pp) => {
    const template = pp.classification === 'automate' ? templateFor(pp.key, templates) : null;
    const assumptions: string[] = [...pp.conversionAssumptions];
    const volume = pp.overrides.monthlyVolume !== undefined ? pp.overrides.monthlyVolume : pp.volume;
    const minutes = pp.overrides.minutesPerOccurrence !== undefined ? pp.overrides.minutesPerOccurrence : pp.minutes;
    if (pp.overrides.monthlyVolume !== undefined) assumptions.push('Monthly volume corrected by the firm lead');
    if (pp.overrides.minutesPerOccurrence !== undefined) assumptions.push('Time per occurrence corrected by the firm lead');
    let reductionPct: number | null = null;
    if (pp.overrides.reductionPct !== undefined && pp.overrides.reductionPct !== null) {
      reductionPct = pp.overrides.reductionPct; assumptions.push(`Reduction of ${Math.round(reductionPct * 100)}% set by the firm lead`);
    } else if (template) {
      reductionPct = template.expectedReductionPct; assumptions.push(`Reduction of ${Math.round(reductionPct * 100)}%: ${template.reductionBasis}`);
    }
    const hourly = profile?.loadedHourlyCostGBP ?? null;
    if (hourly !== null) assumptions.push(`Labour cost of £${hourly}/hour supplied by the firm`);
    const impact = calculateImpact({ monthlyVolume: volume, minutesPerOccurrence: minutes, reductionPct, loadedHourlyCostGBP: hourly, implementationCostGBP: null });
    const input: OpportunityInput | null = pp.classification ? {
      id: pp.id, title: pp.title, stageId: pp.stageId, classification: pp.classification, impact, monthlyVolume: volume,
      confidence: pp.confidence, templateAvailable: !!template?.tested, complexity: template?.typicalComplexity ?? null,
    } : null;
    return { pp, template, assumptions, impact, input };
  });

  const { ranked, excluded } = rankOpportunities(prepared.flatMap((p) => (p.input ? [p.input] : [])), cfg);
  return prepared.map((p) => {
    const idx = ranked.findIndex((r) => r.input.id === p.pp.id);
    const r = ranked[idx];
    return {
      painPointId: p.pp.id,
      impact: p.impact,
      assumptions: p.assumptions,
      score: r?.total ?? null,
      rank: r?.rank ?? null,
      breakdown: r?.dimensions ?? null,
      explanation: r && ranked[idx + 1] ? explainRanking(r, ranked[idx + 1]!, cfg) : [],
      twoWeek: precheckTwoWeek(p.pp, p.template),
      excludedReason: r ? null : (excluded.find((e) => e.id === p.pp.id)?.reason ?? 'Not yet classified'),
    };
  });
}

export { STAGES };
