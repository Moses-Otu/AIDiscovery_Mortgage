import { z } from 'zod';
import type { Playback } from '../analysis/service';
import type { FirmProfile } from '../firm/profile';
import type { Playbook } from '../knowledge/playbook';
import { templateFor, type AutomationTemplate } from '../knowledge/templates';
import { assessTwoWeekFeasibility, type FeasibilityResult } from '../engine/feasibility';
import { checksFor } from '../knowledge/model';
import { STAGES } from '../domain/journey';

// JADA implementation pack (brief §12.2): enough for an engineer who wasn't in the discovery to start.
export interface ImplementationPack {
  schemaVersion: 1;
  generatedAt: string;
  painPoint: { id: string; key: string; title: string; stage: string; classification: string | null; confidence: string };
  template: { id: string; name: string; tested: boolean } | null;
  scope: { workflow: string; outOfScope: string[] };
  currentProcess: { facts: string[]; quotes: { role: string; quote: string }[] };
  baseline: { monthlyVolume: number | null; minutesPerOccurrence: number | null; monthlyHoursSpent: number | null; monthlyHoursRecovered: number | null; evidence: string };
  targetProcess: string[];
  systems: string[];
  accessRequirements: string[];
  firmRules: string[];
  automationRequirements: string[];
  humanApprovalPoints: string[];
  keepWithPeople: string[];
  testCases: { name: string; given: string; when: string; then: string }[];
  definitionOfDone: string[];
  risks: string[];
  dependencies: string[];
  openQuestions: string[];
  assumptions: string[];
  knowledge: { version: string; reviewed: boolean };
  regulatoryChecks: { title: string; statement: string; requiredAction: string; citations: string[] }[];
}

export class PackNotPossibleError extends Error {}

export function buildImplementationPack(p: { playback: Playback; painPointId: string; profile: FirmProfile | null; playbook: Playbook; templates?: AutomationTemplate[]; now?: Date }): ImplementationPack {
  const pp = p.playback.painPoints.find((x) => x.id === p.painPointId);
  if (!pp) throw new PackNotPossibleError('Pain point not found');
  if (pp.classification !== 'automate') throw new PackNotPossibleError('Only items classified “automate” get an implementation pack');
  const template = templateFor(pp.key, p.templates);
  const card = p.playbook.cards.find((c) => c.id === pp.key) ?? null;
  const spec = template?.spec;
  const firmSystems = p.profile?.systems ?? [];
  const systems = [...new Set([...pp.systems, ...firmSystems])];

  const applied = checksFor(p.playbook, pp.stageId, pp.classification);
  const regulatedUncovered = STAGES[pp.stageId as keyof typeof STAGES].regulatedJudgement && applied.length === 0;
  const gap = (what: string) => `No template covers ${what} — JADA engineering to define.`;
  const openQuestions = [
    ...pp.outstandingQuestions,
    ...pp.missingMeasurements.map((m: string) => m === 'monthlyVolume' ? 'How many times a month does this happen?' : 'How long does each occurrence take?'),
    ...(systems.length ? [] : ['Which system holds the information this workflow needs?']),
    ...(!template ? ['Which existing automation pattern is closest, and what would a new template need?'] : []),
    ...(regulatedUncovered ? ['This stage involves regulated judgement and no approved regulatory check covers it — get a compliance reviewer’s view before scoping.'] : []),
    ...(p.playbook.reviewed ? [] : ['This pack was built from the unreviewed development playbook — re-check against an approved release.']),
    ...(pp.disagreements.length ? ['Staff gave different figures for this task — confirm the baseline before go-live so the before/after comparison is fair.'] : []),
  ];

  return {
    schemaVersion: 1,
    generatedAt: (p.now ?? new Date()).toISOString(),
    painPoint: { id: pp.id, key: pp.key, title: pp.title, stage: pp.stageName, classification: pp.classification, confidence: pp.confidence },
    template: template ? { id: template.id, name: template.name, tested: template.tested } : null,
    scope: { workflow: spec?.workflow ?? gap('the start and finish of this workflow'), outOfScope: spec?.outOfScope ?? ['Changes to the firm’s core systems'] },
    currentProcess: {
      facts: [
        `Reported by ${pp.roles.join(', ')} (${pp.participantCount} ${pp.participantCount === 1 ? 'person' : 'people'}).`,
        ...pp.causes.map((c: string) => `Cause reported: ${c}`),
        ...pp.improvements.map((c: string) => `Improvement suggested by staff: ${c}`),
        ...pp.disagreements.map((d: any) => `Figures differ by role — ${d.field === 'minutesPerOccurrence' ? 'minutes each time' : 'monthly volume'}: ${d.values.map((v: any) => `${v.role} ${v.value}`).join('; ')}`),
      ],
      quotes: pp.quotes.slice(0, 6),
    },
    baseline: {
      monthlyVolume: pp.overrides.monthlyVolume ?? pp.volume?.value ?? null,
      minutesPerOccurrence: pp.overrides.minutesPerOccurrence ?? pp.minutes?.value ?? null,
      monthlyHoursSpent: pp.impact?.monthlyHoursSpent ?? null,
      monthlyHoursRecovered: pp.impact?.monthlyHoursRecovered ?? null,
      evidence: pp.confidence,
    },
    targetProcess: spec?.targetProcess ?? [gap('the target process')],
    systems,
    accessRequirements: spec?.accessRequirements ?? [gap('access requirements')],
    firmRules: [
      ...(p.profile ? [`Firm is ${p.profile.authorisation === 'directly_authorised' ? 'directly authorised' : p.profile.authorisation === 'network_appointed_representative' ? 'an appointed representative of a network — check whether network rules apply to client communications' : 'of unconfirmed authorisation status — confirm before build'}.`] : ['Firm profile not completed — confirm authorisation status before build.']),
      ...(card?.regulatoryLimits ?? []),
    ],
    automationRequirements: spec?.automationRequirements ?? [gap('automation requirements')],
    // A tested-or-not template is more specific than the generic playbook card, so it wins when present.
    humanApprovalPoints: spec?.humanApprovalPoints ?? card?.humanApproval ?? ['Human approval points to be defined by JADA engineering.'],
    keepWithPeople: spec?.keepWithPeople ?? ['Any professional judgement, advice or suitability decision.'],
    testCases: spec?.testCases ?? [],
    definitionOfDone: spec?.definitionOfDone ?? [gap('the definition of done')],
    risks: [...(spec?.standardRisks ?? []), ...(pp.requiresComplianceReview ? ['Regulated stage: compliance sign-off required before build.'] : [])],
    dependencies: systems.map((s) => `Access to ${s}`),
    openQuestions: [...new Set(openQuestions)],
    assumptions: pp.assumptions,
    knowledge: { version: p.playbook.version, reviewed: p.playbook.reviewed === true },
    regulatoryChecks: applied.map((a) => ({ title: a.check.title, statement: a.check.statement, requiredAction: a.check.requiredAction, citations: a.citations })),
  };
}

export function packToMarkdown(pack: ImplementationPack, firmName: string): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- None');
  const b = pack.baseline;
  return `# Implementation pack: ${pack.painPoint.title}

${firmName} — ${pack.painPoint.stage}. Evidence: ${pack.painPoint.confidence}. Template: ${pack.template ? `${pack.template.name} (${pack.template.tested ? 'tested' : 'NOT YET TESTED'})` : 'none'}.

## Scope
${pack.scope.workflow}

Out of scope:
${list(pack.scope.outOfScope)}

## Current process
${list(pack.currentProcess.facts)}

${pack.currentProcess.quotes.map((q) => `> “${q.quote}” — ${q.role}`).join('\n')}

## Baseline (measure again after go-live)
- Monthly volume: ${b.monthlyVolume ?? 'unknown'}
- Minutes each time: ${b.minutesPerOccurrence ?? 'unknown'}
- Staff hours per month: ${b.monthlyHoursSpent ?? 'unknown'}
- Expected hours recovered per month: ${b.monthlyHoursRecovered ?? 'unknown'}

## Target process
${pack.targetProcess.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Systems
${list(pack.systems)}

## Access requirements
${list(pack.accessRequirements)}

## Firm rules
${list(pack.firmRules)}

## Automation requirements
${list(pack.automationRequirements)}

## Human approval points
${list(pack.humanApprovalPoints)}

## Regulatory checks (knowledge release ${pack.knowledge?.version ?? 'unknown'}${pack.knowledge?.reviewed ? '' : ' — UNREVIEWED'})
${(pack.regulatoryChecks ?? []).length ? pack.regulatoryChecks.map((c) => `- **${c.title}** — ${c.requiredAction}${c.citations.map((x) => `\n  - Source: ${x}`).join('')}`).join('\n') : '- None apply from the approved knowledge base'}

## Stays with people
${list(pack.keepWithPeople)}

## Test cases
${pack.testCases.length ? pack.testCases.map((t) => `- **${t.name}** — Given ${t.given.toLowerCase()}, when ${t.when.toLowerCase()}, then ${t.then.toLowerCase()}.`).join('\n') : '- To be written by JADA engineering'}

## Definition of done
${list(pack.definitionOfDone)}

## Risks
${list(pack.risks)}

## Dependencies
${list(pack.dependencies)}

## Open questions
${list(pack.openQuestions)}

## Assumptions
${list(pack.assumptions)}
`;
}

// JADA engineering review (brief §4 step 11). The two-week build is confirmed only if every check passes.
export const ReviewSchema = z.object({
  checks: z.object({
    singleWorkflowWithStartAndFinish: z.boolean(),
    changesCoreSystems: z.boolean(),
    accessAndTestDataReadyDayOne: z.boolean(),
    humanApprovalForCommsAndRecordChanges: z.boolean(),
    complianceQuestionsResolved: z.boolean(),
  }),
  unresolvedDependencies: z.array(z.string().min(1).max(300)).max(30),
  notes: z.string().max(4000).default(''),
});
export type Review = z.infer<typeof ReviewSchema>;

export function assessReview(pack: ImplementationPack, review: Review): FeasibilityResult {
  return assessTwoWeekFeasibility({
    classification: (pack.painPoint.classification ?? 'fix') as any,
    templateId: pack.template?.id ?? null,
    templateTested: pack.template?.tested ?? false,
    ...review.checks,
    unresolvedDependencies: review.unresolvedDependencies,
  });
}
