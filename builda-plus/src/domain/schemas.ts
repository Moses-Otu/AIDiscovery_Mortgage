import { z } from 'zod';
import { STAGE_IDS, ROLES } from './journey';

export const StageIdSchema = z.enum(STAGE_IDS);
export const RoleSchema = z.enum(ROLES);

// What the LLM may return for one piece of evidence. It reports figures in the
// participant's own units; application code does every conversion (brief §3.5).
export const EvidenceDraftSchema = z.object({
  painPointKey: z.string().min(2).describe('Short snake_case key; reuse a playbook key when one fits'),
  stageId: StageIdSchema,
  taskDescription: z.string().min(3),
  responsibleRole: RoleSchema,
  volume: z.object({ value: z.number().nonnegative(), per: z.enum(['day', 'week', 'month', 'year']) }).nullable()
    .describe('Only if the participant stated how often/how many'),
  timePerOccurrence: z.object({ value: z.number().nonnegative(), unit: z.enum(['minutes', 'hours']) }).nullable()
    .describe('Only if the participant stated how long each occurrence takes'),
  peopleInvolved: z.number().int().nonnegative().nullable(),
  systems: z.array(z.string()),
  operationalImpact: z.string().nullable(),
  reportedCause: z.string().nullable(),
  potentialImprovement: z.string().nullable(),
  supportingQuote: z.string().min(3).describe('Copied word-for-word from the latest participant message'),
  outstandingQuestions: z.array(z.string()),
});
export type EvidenceDraft = z.infer<typeof EvidenceDraftSchema>;

export const TurnInterpretationSchema = z.object({
  evidence: z.array(EvidenceDraftSchema),
  stagesConfirmedNotInvolved: z.array(StageIdSchema),
  flags: z.object({
    clientInformation: z.boolean(),
    complaintOrCompliance: z.boolean(),
    employmentIssue: z.boolean(),
    adviceRequest: z.boolean(),
    outOfScope: z.boolean(),
  }),
  wantsToPause: z.boolean(),
  answerWasVague: z.boolean(),
});
export type TurnInterpretation = z.infer<typeof TurnInterpretationSchema>;

export const NextQuestionSchema = z.object({ question: z.string().min(5).max(600) });

export type EvidenceSource = 'firm_said' | 'operational_record' | 'measured_baseline' | 'playbook' | 'assumption';

export interface VerifiedEvidence {
  id: string;
  sessionId: string;
  participantRef: string; // pseudonym, never a name
  turnIndex: number;
  source: EvidenceSource;
  painPointKey: string;
  stageId: EvidenceDraft['stageId'];
  taskDescription: string;
  responsibleRole: EvidenceDraft['responsibleRole'];
  monthlyVolume: number | null;
  minutesPerOccurrence: number | null;
  peopleInvolved: number | null;
  systems: string[];
  operationalImpact: string | null;
  reportedCause: string | null;
  potentialImprovement: string | null;
  supportingQuote: string;
  outstandingQuestions: string[];
  conversionAssumptions: string[];
}
