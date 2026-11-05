import { withFirmContext, type Db, type FirmContext } from '../db/pool';
import {
  findLatestSession, findLiveSession, insertAudit, insertEscalation, insertEvidence, insertSession, loadParticipant,
  loadSession, saveSession, type AuditRow,
} from '../db/repositories';
import type { LLMProvider } from '../llm/provider';
import type { Playbook } from '../knowledge/playbook';
import { handleParticipantMessage, pauseInterview, startInterview, type InterviewEvent, type InterviewState, type SessionStatus } from './orchestrator';
import { STAGES } from '../domain/journey';

export class ConsentRequiredError extends Error {}
export class SessionClosedError extends Error {}
export class MessageTooLongError extends Error {}
export class InterviewTurnFailedError extends Error {
  constructor(public cause: unknown) { super('The interview could not process this message. Nothing was saved; please try again.'); }
}

export interface InterviewServiceDeps {
  // The release the discovery pinned. Falls back to the static playbook (tests, development).
  playbookFor?: (ctx: FirmContext, discoveryId: string) => Promise<Playbook>;
  // A provider per discovery, so the token budget and usage ledger are scoped correctly.
  providerFor: (ctx: { orgId: string; discoveryId: string }) => LLMProvider;
  playbook: Playbook;
}

export interface SessionView {
  sessionId: string;
  status: SessionStatus;
  mode: 'main' | 'follow_up';
  stages: { id: string; name: string; state: 'done' | 'current' | 'upcoming' | 'skipped' }[];
  lastInterviewerMessage: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

const stageStrip = (s: InterviewState): SessionView['stages'] => {
  if (s.mode === 'follow_up') return [];
  const currentIdx = s.focusStage ? s.stagesInScope.indexOf(s.focusStage) : -1;
  return s.stagesInScope.map((id, i) => ({
    id, name: STAGES[id].name,
    state: s.coverage[id].notInvolved ? 'skipped' : id === s.focusStage && s.status !== 'completed' ? 'current'
      : s.status === 'completed' || (currentIdx >= 0 && i < currentIdx) ? 'done' : 'upcoming',
  }));
};

const view = (s: InterviewState): SessionView => ({
  sessionId: s.sessionId,
  status: s.status,
  mode: s.mode ?? 'main',
  stages: stageStrip(s),
  lastInterviewerMessage: [...s.transcript].reverse().find((m) => m.role === 'assistant')?.content ?? '',
  messages: s.transcript,
});

export class InterviewService {
  constructor(private db: Db, private deps: InterviewServiceDeps) {}

  // Starts an interview, or returns the participant's existing one so a reopened link resumes it.
  async startOrResume(ctx: FirmContext, participantId: string): Promise<SessionView & { resumed: boolean }> {
    return withFirmContext(this.db, ctx, async (tx) => {
      const p = await loadParticipant(tx, participantId);
      if (!p.consentedAt) throw new ConsentRequiredError('Participant must give consent before the interview starts');

      const live = await findLiveSession(tx, participantId);
      if (live) {
        await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId: p.discoveryId, actor: `participant:${p.pseudonym}`,
          action: 'interview.reopened', entityType: 'interview_session', entityId: live.id }]);
        return { ...view(live.state), resumed: true };
      }
      // A finished interview is shown as finished; it is never silently restarted.
      const latest = await findLatestSession(tx, participantId);
      if (latest) return { ...view(latest.state), resumed: true };
      const { state } = startInterview({ discoveryId: p.discoveryId, participantRef: p.pseudonym, role: p.role });
      await insertSession(tx, { orgId: ctx.orgId, participantId, state });
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId: p.discoveryId, actor: `participant:${p.pseudonym}`,
        action: 'interview.started', entityType: 'interview_session', entityId: state.sessionId, metadata: { role: p.role } }]);
      return { ...view(state), resumed: false };
    });
  }

  async getSession(ctx: FirmContext, sessionId: string): Promise<SessionView> {
    return withFirmContext(this.db, ctx, async (tx) => view((await loadSession(tx, sessionId)).state));
  }

  // Participant-facing entry point: the session is found from the participant, never taken from
  // the request, so one participant can't post into another's interview.
  async submitForParticipant(ctx: FirmContext, participantId: string, text: string): Promise<SessionView & { reply: string }> {
    const live = await withFirmContext(this.db, ctx, (tx) => findLiveSession(tx, participantId));
    if (!live) throw new SessionClosedError('There is no interview in progress');
    return this.submitMessage(ctx, live.id, text);
  }

  async pauseForParticipant(ctx: FirmContext, participantId: string): Promise<SessionView> {
    const live = await withFirmContext(this.db, ctx, (tx) => findLiveSession(tx, participantId));
    if (!live) throw new SessionClosedError('There is no interview in progress');
    return this.pause(ctx, live.id);
  }

  async submitMessage(ctx: FirmContext, sessionId: string, text: string): Promise<SessionView & { reply: string }> {
    if (text.length > 4000) throw new MessageTooLongError('Please keep each answer under 4,000 characters');
    // 1. Load (short transaction).
    const loaded = await withFirmContext(this.db, ctx, (tx) => loadSession(tx, sessionId));
    if (loaded.state.status === 'completed' || loaded.state.status === 'escalated') {
      throw new SessionClosedError(`This interview is ${loaded.state.status}`);
    }

    // 2. Run the turn with no transaction open (AI calls can take seconds).
    let outcome;
    try {
      outcome = await handleParticipantMessage(loaded.state, text, {
        llm: this.deps.providerFor({ orgId: ctx.orgId, discoveryId: loaded.discoveryId }),
        playbook: this.deps.playbookFor ? await this.deps.playbookFor(ctx, loaded.discoveryId) : this.deps.playbook,
      });
    } catch (err) {
      await withFirmContext(this.db, ctx, (tx) => insertAudit(tx, [{
        orgId: ctx.orgId, discoveryId: loaded.discoveryId, actor: 'system', action: 'interview.turn_failed',
        entityType: 'interview_session', entityId: sessionId,
        metadata: { error: err instanceof Error ? err.name : 'unknown' }, // never the message text
      }]));
      throw new InterviewTurnFailedError(err);
    }

    // 3. Save everything from this turn atomically, guarded by the version check.
    const { state: next, reply, events } = outcome;
    const newEvidenceIds = new Set(events.flatMap((e) => (e.type === 'evidence_added' ? e.ids : [])));
    await withFirmContext(this.db, ctx, async (tx) => {
      await saveSession(tx, sessionId, loaded.version, next);
      await insertEvidence(tx, ctx.orgId, loaded.discoveryId, next.evidence.filter((e) => newEvidenceIds.has(e.id)));

      if (next.status === 'escalated' && loaded.state.status !== 'escalated' && next.escalation) {
        const focus = loaded.state.focusStage ? STAGES[loaded.state.focusStage].name : 'scoping';
        // Context for the JADA contact without copying what the participant wrote.
        const detail = `Participant ${next.participantRef} (${next.role}); topic at the time: ${focus}; turn ${next.turnCount + 1}. Open the session for the redacted transcript.`;
        const escalationId = await insertEscalation(tx, { orgId: ctx.orgId, discoveryId: loaded.discoveryId, sessionId, reason: next.escalation.reason, detail });
        await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId: loaded.discoveryId, actor: 'system', action: 'escalation.created',
          entityType: 'escalation', entityId: escalationId, metadata: { reason: next.escalation.reason } }]);
      }
      await insertAudit(tx, events.map((e) => this.auditFor(e, ctx.orgId, loaded.discoveryId, sessionId, next.participantRef)));
    });
    return { ...view(next), reply };
  }

  async pause(ctx: FirmContext, sessionId: string): Promise<SessionView> {
    return withFirmContext(this.db, ctx, async (tx) => {
      const s = await loadSession(tx, sessionId, { forUpdate: true });
      const paused = pauseInterview(s.state);
      if (paused !== s.state) {
        await saveSession(tx, sessionId, s.version, paused);
        await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId: s.discoveryId, actor: `participant:${s.state.participantRef}`,
          action: 'interview.paused', entityType: 'interview_session', entityId: sessionId }]);
      }
      return view(paused);
    });
  }

  // Firm lead asks for a person (brief §11).
  async requestHumanHelp(ctx: FirmContext & { userId: string }, discoveryId: string, note: string): Promise<string> {
    return withFirmContext(this.db, ctx, async (tx) => {
      const id = await insertEscalation(tx, { orgId: ctx.orgId, discoveryId, sessionId: null, reason: 'firm_lead_requested', detail: note.slice(0, 1000) });
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: `user:${ctx.userId}`, action: 'escalation.created',
        entityType: 'escalation', entityId: id, metadata: { reason: 'firm_lead_requested' } }]);
      return id;
    });
  }

  private auditFor(e: InterviewEvent, orgId: string, discoveryId: string, sessionId: string, pseudonym: string): AuditRow {
    const { type, ...metadata } = e;
    const actor = type === 'paused' || type === 'resumed' ? `participant:${pseudonym}` : 'system';
    return { orgId, discoveryId, actor, action: `interview.${type}`, entityType: 'interview_session', entityId: sessionId, metadata };
  }
}
