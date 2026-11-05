// Operational impact (brief §6.1). Unknown inputs produce unknown outputs — never invented.
export interface ImpactInputs {
  monthlyVolume: number | null;
  minutesPerOccurrence: number | null;
  reductionPct: number | null;           // 0..1, the share of the time that can be removed
  loadedHourlyCostGBP: number | null;    // firm-supplied labour cost assumption
  implementationCostGBP: number | null;
}
export interface ImpactResult {
  monthlyHoursSpent: number | null;
  monthlyHoursRecovered: number | null;
  monthlyCapacityValueGBP: number | null;
  paybackMonths: number | null;
  unknowns: string[];
  caveats: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function calculateImpact(i: ImpactInputs): ImpactResult {
  const unknowns: string[] = [];
  if (i.monthlyVolume === null) unknowns.push('Monthly volume');
  if (i.minutesPerOccurrence === null) unknowns.push('Time per occurrence');
  if (i.reductionPct === null) unknowns.push('Proportion of work that can be reduced');
  if (i.loadedHourlyCostGBP === null) unknowns.push('Labour cost per hour');
  if (i.implementationCostGBP === null) unknowns.push('Implementation cost');
  if (i.reductionPct !== null && (i.reductionPct < 0 || i.reductionPct > 1)) throw new Error('reductionPct must be between 0 and 1');

  const spent = i.monthlyVolume !== null && i.minutesPerOccurrence !== null ? (i.monthlyVolume * i.minutesPerOccurrence) / 60 : null;
  const recovered = spent !== null && i.reductionPct !== null ? spent * i.reductionPct : null;
  const value = recovered !== null && i.loadedHourlyCostGBP !== null ? recovered * i.loadedHourlyCostGBP : null;
  const payback = value !== null && value > 0 && i.implementationCostGBP !== null ? i.implementationCostGBP / value : null;

  return {
    monthlyHoursSpent: spent === null ? null : r1(spent),
    monthlyHoursRecovered: recovered === null ? null : r1(recovered),
    monthlyCapacityValueGBP: value === null ? null : Math.round(value),
    paybackMonths: payback === null ? null : r1(payback),
    unknowns,
    caveats: ['Recovered hours are operational capacity, not a guaranteed payroll saving.'],
  };
}

// One figure per participant (their latest), then the median, with the range kept visible.
export function aggregateEstimate(byParticipant: Record<string, number>): { value: number | null; min: number | null; max: number | null; n: number } {
  const v = Object.values(byParticipant).sort((a, b) => a - b);
  if (!v.length) return { value: null, min: null, max: null, n: 0 };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { value: median, min: v[0]!, max: v[v.length - 1]!, n: v.length };
}
