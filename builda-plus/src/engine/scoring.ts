import { STAGES, type Classification, type StageId } from '../domain/journey';
import type { ConfidenceOrInsufficient } from './confidence';
import type { ImpactResult } from './impact';

// Deterministic opportunity scoring (brief §6.2). Every dimension is 1–5 with a documented band.
export const DIMENSIONS = ['impact', 'volume', 'feasibility', 'complexity', 'risk', 'confidence'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface ScoringConfig { version: string; weights: Record<Dimension, number> }
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  version: 'scoring-2026-11-v1',
  weights: { impact: 0.3, volume: 0.15, feasibility: 0.2, complexity: 0.1, risk: 0.1, confidence: 0.15 },
};

export interface OpportunityInput {
  id: string;
  title: string;
  stageId: StageId;
  classification: Classification;
  impact: ImpactResult;
  monthlyVolume: number | null;
  confidence: ConfidenceOrInsufficient;
  templateAvailable: boolean;
  complexity: 'low' | 'medium' | 'high' | null;
}
export interface DimensionScore { score: number; rationale: string }
export interface ScoredOpportunity { input: OpportunityInput; total: number; dimensions: Record<Dimension, DimensionScore>; configVersion: string }
export interface RankedOpportunity extends ScoredOpportunity { rank: number }

const band = (v: number, limits: number[]) => 1 + limits.filter((l) => v >= l).length; // limits ascending, 4 limits -> 1..5

export function scoreDimensions(o: OpportunityInput): Record<Dimension, DimensionScore> {
  const hrs = o.impact.monthlyHoursRecovered;
  const reg = STAGES[o.stageId].regulatedJudgement;
  return {
    impact: hrs === null
      ? { score: 1, rationale: 'Hours recovered unknown' }
      : { score: band(hrs, [5, 15, 30, 60]), rationale: `${hrs} hours/month recovered (bands: 5/15/30/60)` },
    volume: o.monthlyVolume === null
      ? { score: 1, rationale: 'Volume unknown' }
      : { score: band(o.monthlyVolume, [20, 50, 100, 200]), rationale: `${o.monthlyVolume}/month (bands: 20/50/100/200)` },
    feasibility: o.templateAvailable
      ? { score: 5, rationale: 'Tested JADA template exists' }
      : { score: { fix: 4, automate: 3, overhaul: 2, keep_human: 1 }[o.classification], rationale: `No template; classified "${o.classification}"` },
    complexity: o.complexity === null
      ? { score: 2, rationale: 'Complexity not yet assessed' }
      : { score: { low: 5, medium: 3, high: 1 }[o.complexity], rationale: `${o.complexity} technical complexity` },
    risk: reg
      ? { score: 2, rationale: 'Regulated-judgement stage: support and preparation only, adviser decides' }
      : { score: 5, rationale: 'No regulated judgement at this stage' },
    confidence: {
      score: { very_high: 5, high: 4, medium: 3, low: 2, insufficient: 0 }[o.confidence],
      rationale: `Evidence confidence: ${o.confidence}`,
    },
  };
}

export function validateConfig(cfg: ScoringConfig): void {
  const sum = DIMENSIONS.reduce((n, d) => n + cfg.weights[d], 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`Scoring weights must sum to 1 (got ${sum})`);
  if (DIMENSIONS.some((d) => cfg.weights[d] < 0)) throw new Error('Scoring weights must be non-negative');
}

export function scoreOpportunity(o: OpportunityInput, cfg = DEFAULT_SCORING_CONFIG): ScoredOpportunity {
  validateConfig(cfg);
  const dimensions = scoreDimensions(o);
  const total = DIMENSIONS.reduce((n, d) => n + cfg.weights[d] * (dimensions[d].score / 5) * 100, 0);
  return { input: o, total: Math.round(total * 10) / 10, dimensions, configVersion: cfg.version };
}

export function rankOpportunities(list: OpportunityInput[], cfg = DEFAULT_SCORING_CONFIG) {
  const excluded: { id: string; reason: string }[] = [];
  const eligible: ScoredOpportunity[] = [];
  for (const o of list) {
    if (o.classification === 'keep_human') { excluded.push({ id: o.id, reason: 'Classified keep human — not ranked as an improvement opportunity' }); continue; }
    if (o.confidence === 'insufficient') { excluded.push({ id: o.id, reason: 'Insufficient evidence — more information needed before ranking' }); continue; }
    eligible.push(scoreOpportunity(o, cfg));
  }
  eligible.sort((a, b) =>
    b.total - a.total ||
    (b.input.impact.monthlyHoursRecovered ?? -1) - (a.input.impact.monthlyHoursRecovered ?? -1) ||
    a.input.id.localeCompare(b.input.id));
  const ranked: RankedOpportunity[] = eligible.map((s, i) => ({ ...s, rank: i + 1 }));
  return { ranked, excluded, configVersion: cfg.version };
}

// "Why does A rank above B?" — weighted contribution differences, largest first.
export function explainRanking(a: ScoredOpportunity, b: ScoredOpportunity, cfg = DEFAULT_SCORING_CONFIG): string[] {
  return DIMENSIONS
    .map((d) => ({ d, delta: cfg.weights[d] * ((a.dimensions[d].score - b.dimensions[d].score) / 5) * 100 }))
    .filter((x) => Math.abs(x.delta) >= 0.05)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .map(({ d, delta }) => `${d}: ${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts (${a.dimensions[d].rationale} vs ${b.dimensions[d].rationale})`);
}
