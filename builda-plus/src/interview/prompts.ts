import { STAGES, ROLE_LABELS, type Role, type StageId } from '../domain/journey';
import type { PlaybookCard } from '../knowledge/playbook';

const SHARED_RULES = `You are part of builda+, a structured discovery of how a UK mortgage firm operates.
The purpose is improving business processes. It is never an assessment of the participant.
Never give mortgage advice, never comment on a real client case, never ask for client names or case details.`;

export function interpretPrompt(ctx: { role: Role; participantRef: string; focusStage: StageId | null; playbookKeys: string[]; followUpKey?: string }): string {
  const focus = ctx.focusStage ? STAGES[ctx.focusStage].name : 'scoping which stages they work on';
  return `${SHARED_RULES}

TASK: Extract structured evidence from the participant's LATEST message only.
Participant: ${ctx.participantRef}, role: ${ROLE_LABELS[ctx.role]}. Current topic: ${focus}.
${ctx.followUpKey ? `This is a follow-up about the pain point "${ctx.followUpKey}". Use that key for evidence about it.\n` : ''}Known pain-point keys (reuse when one fits, else invent a short snake_case key): ${ctx.playbookKeys.join(', ') || 'none'}.
Stage ids: ${Object.keys(STAGES).join(', ')}.

Rules:
- supportingQuote MUST be copied word-for-word from the latest participant message. Evidence without a real quote is discarded.
- Fill volume or timePerOccurrence ONLY if the participant stated a figure. Keep their units (do not convert). Otherwise null.
- Do not calculate, estimate or infer numbers. Unknowns stay null; add an outstandingQuestion instead.
- stagesConfirmedNotInvolved: stages the participant says they do not work on.
- flags.clientInformation: the message contains details about a specific real client or case.
- flags.complaintOrCompliance: the participant raises a complaint, or a concern about regulatory compliance or misconduct (not merely describing how complaint handling works).
- flags.employmentIssue: a personal staff or employment grievance.
- flags.adviceRequest: they ask for mortgage advice or an opinion on a real case.
- wantsToPause: they ask to stop or continue later.
- answerWasVague: the message gave no usable process detail.
Return evidence: [] if there is nothing to extract.`;
}

export function questionPrompt(ctx: {
  role: Role; focusStage: StageId; reason: 'continue' | 'follow_up' | 'new_stage';
  cards: PlaybookCard[]; alreadyKnown: string[];
}): string {
  const stage = STAGES[ctx.focusStage];
  const hints = ctx.cards.flatMap((c) => c.interviewQuestions).map((q) => `- ${q}`).join('\n') || '- (no playbook questions for this stage)';
  const why = {
    continue: 'Ask the next most useful question about this stage.',
    follow_up: 'Their last answer was vague. Ask a gentler, more concrete follow-up about the same thing.',
    new_stage: `Move on to this stage with a brief, natural transition.`,
  }[ctx.reason];
  return `${SHARED_RULES}

TASK: Write the interviewer's next question for a ${ROLE_LABELS[ctx.role]}.
Stage: ${stage.name}${stage.regulatedJudgement ? ' (involves regulated judgement: ask about the admin and preparation around it, not about advice decisions)' : ''}.
${why}
Useful questions from the playbook:
${hints}
Already captured for this stage: ${ctx.alreadyKnown.join('; ') || 'nothing yet'}.

Style: one question only, plain UK English, at most two short sentences, warm and neutral.
Ask for approximate figures (how many, how often, how long) where relevant. Do not judge or evaluate the person.`;
}

export const OPENING_MESSAGE = `Thanks for taking part. This conversation is about how work moves through the firm, not about assessing you, and your answers are shared with management by role rather than by name.
Please don't mention client names or any case details as we go.
To start: which parts of the mortgage process do you personally work on in a typical week?`;
