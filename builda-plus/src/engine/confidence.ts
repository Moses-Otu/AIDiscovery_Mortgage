import type { EvidenceSource } from '../domain/schemas';

// Evidence confidence (brief §4 step 7). Describes evidence quality, not statistical certainty.
export type ConfidenceLevel = 'low' | 'medium' | 'high' | 'very_high';
export type ConfidenceOrInsufficient = ConfidenceLevel | 'insufficient';

export interface ConfidenceInput {
  participantRef: string;
  source: EvidenceSource;
  monthlyVolume: number | null;
  minutesPerOccurrence: number | null;
}
export interface Disagreement { field: 'monthlyVolume' | 'minutesPerOccurrence'; min: number; max: number; byParticipant: Record<string, number> }
export interface ConfidenceAssessment { level: ConfidenceOrInsufficient; participantCount: number; disagreements: Disagreement[]; reasons: string[] }

// Two accounts count as "consistent" if the larger figure is at most this multiple of the smaller.
export const CONSISTENCY_RATIO = 2;

export function assessConfidence(records: ConfidenceInput[]): ConfidenceAssessment {
  const said = records.filter((r) => r.source === 'firm_said');
  const participants = [...new Set(said.map((r) => r.participantRef))];
  const disagreements = findDisagreements(said);

  if (records.some((r) => r.source === 'measured_baseline')) {
    return { level: 'very_high', participantCount: participants.length, disagreements, reasons: ['Directly measured operational baseline available'] };
  }
  if (participants.length === 0) {
    return { level: 'insufficient', participantCount: 0, disagreements, reasons: ['No direct participant account — playbook knowledge or assumptions alone cannot support a recommendation'] };
  }
  const consistent = disagreements.length === 0;
  if (participants.length >= 2 && consistent) {
    const hasRecords = records.some((r) => r.source === 'operational_record');
    return hasRecords
      ? { level: 'high', participantCount: participants.length, disagreements, reasons: ['Consistent accounts from multiple participants, supported by operational records'] }
      : { level: 'medium', participantCount: participants.length, disagreements, reasons: ['Consistent accounts from multiple participants'] };
  }
  return {
    level: 'low', participantCount: participants.length, disagreements,
    reasons: [participants.length === 1 ? "Single participant's estimate" : 'Participants gave materially different figures — preserved for firm-lead review'],
  };
}

function findDisagreements(rs: ConfidenceInput[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const field of ['monthlyVolume', 'minutesPerOccurrence'] as const) {
    const byParticipant: Record<string, number> = {};
    for (const r of rs) { const v = r[field]; if (v !== null) byParticipant[r.participantRef] = v; } // latest per participant
    const values = Object.values(byParticipant);
    if (values.length < 2) continue;
    const min = Math.min(...values), max = Math.max(...values);
    const inconsistent = min === 0 ? max > 0 : max / min > CONSISTENCY_RATIO;
    if (inconsistent) out.push({ field, min, max, byParticipant });
  }
  return out;
}
