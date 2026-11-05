import { describe, expect, it } from 'vitest';
import { startInterview, handleParticipantMessage, quoteAppearsIn } from '../src/interview/orchestrator';
import { ScriptedProvider } from '../src/llm/mock';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';

const noFlags = { clientInformation: false, complaintOrCompliance: false, employmentIssue: false, adviceRequest: false, outOfScope: false };
const draft = (quote: string, over: Record<string, unknown> = {}) => ({
  painPointKey: 'document_chasing', stageId: 'documents', taskDescription: 'Chasing payslips and bank statements', responsibleRole: 'case_manager',
  volume: { value: 35, per: 'week' }, timePerOccurrence: { value: 20, unit: 'minutes' }, peopleInvolved: 2, systems: ['Email', 'CRM'],
  operationalImpact: null, reportedCause: null, potentialImprovement: null, supportingQuote: quote, outstandingQuestions: [], ...over,
});

describe('interview orchestrator', () => {
  const msg = "I mostly do documents. We chase about 35 a week and each chase takes 20 minutes. I don't do anything with enquiries.";

  it('keeps verified evidence, drops fabricated quotes, converts units in code, and moves focus', async () => {
    const llm = new ScriptedProvider({
      'interview.interpret': [{
        evidence: [draft('We chase about 35 a week and each chase takes 20 minutes'), draft('we chase 200 a month', { painPointKey: 'invented' })],
        stagesConfirmedNotInvolved: ['disclosure_id'], flags: noFlags, wantsToPause: false, answerWasVague: false,
      }],
      'interview.next_question': [{ question: 'How do you keep track of which documents are still outstanding?' }],
    });
    const { state } = startInterview({ discoveryId: 'd1', participantRef: 'P1', role: 'case_manager' });
    const out = await handleParticipantMessage(state, msg, { llm, playbook: SEED_PLAYBOOK });

    expect(out.state.evidence).toHaveLength(1);
    expect(out.state.droppedEvidenceCount).toBe(1);
    expect(out.state.evidence[0]!.monthlyVolume).toBe(151.7);  // 35 × 52 ÷ 12, in code
    expect(out.state.evidence[0]!.minutesPerOccurrence).toBe(20);
    expect(out.state.coverage.disclosure_id.notInvolved).toBe(true);
    expect(out.state.focusStage).toBe('documents'); // first in-scope stage still needing evidence
    expect(out.reply).toMatch(/outstanding/);
    // The participant pseudonym is sent; no name exists in state at all.
    expect(llm.calls[0]!.system).toContain('P1');
  });

  it('stops before the LLM when client data appears', async () => {
    const llm = new ScriptedProvider({});
    const { state } = startInterview({ discoveryId: 'd1', participantRef: 'P1', role: 'case_manager' });
    const out = await handleParticipantMessage(state, 'Mr Jones still owes us his P60', { llm, playbook: SEED_PLAYBOOK });
    expect(llm.calls).toHaveLength(0);
    expect(out.state.status).toBe('escalated');
    expect(out.state.transcript.at(-2)!.content).not.toContain('Jones');
  });

  it('escalates on model flags such as advice requests', async () => {
    const llm = new ScriptedProvider({ 'interview.interpret': [{ evidence: [], stagesConfirmedNotInvolved: [], flags: { ...noFlags, adviceRequest: true }, wantsToPause: false, answerWasVague: false }] });
    const { state } = startInterview({ discoveryId: 'd1', participantRef: 'P1', role: 'adviser' });
    const out = await handleParticipantMessage(state, 'Should my client go for a 5 year fix?', { llm, playbook: SEED_PLAYBOOK });
    expect(out.state.status).toBe('escalated');
    expect(out.state.escalation?.reason).toBe('advice_request');
  });

  it('pauses and resumes', async () => {
    const llm = new ScriptedProvider({
      'interview.interpret': [
        { evidence: [], stagesConfirmedNotInvolved: [], flags: noFlags, wantsToPause: true, answerWasVague: false },
        { evidence: [], stagesConfirmedNotInvolved: [], flags: noFlags, wantsToPause: false, answerWasVague: true },
      ],
      'interview.next_question': [{ question: 'Which stages do you usually handle?' }],
    });
    const { state } = startInterview({ discoveryId: 'd1', participantRef: 'P1', role: 'administrator' });
    const paused = await handleParticipantMessage(state, "Can we finish this later?", { llm, playbook: SEED_PLAYBOOK });
    expect(paused.state.status).toBe('paused');
    const resumed = await handleParticipantMessage(paused.state, "OK I'm back", { llm, playbook: SEED_PLAYBOOK });
    expect(resumed.state.status).toBe('in_progress');
    expect(resumed.events[0]).toEqual({ type: 'resumed' });
  });

  it('matches quotes despite punctuation differences', () => {
    expect(quoteAppearsIn('chase takes 20 minutes', 'Each chase takes 20 minutes!')).toBe(true);
    expect(quoteAppearsIn('chase takes 30 minutes', 'Each chase takes 20 minutes!')).toBe(false);
  });
});
