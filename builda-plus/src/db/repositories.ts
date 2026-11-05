import type { Tx } from './pool';
import type { InterviewState } from '../interview/orchestrator';
import type { VerifiedEvidence } from '../domain/schemas';
import type { Role } from '../domain/journey';

export class NotFoundError extends Error {}
export class ConcurrencyError extends Error {}

export interface ParticipantRow { id: string; discoveryId: string; pseudonym: string; role: Role; consentedAt: Date | null }

export async function loadParticipant(tx: Tx, participantId: string): Promise<ParticipantRow> {
  const r = await tx.query(
    'select id, discovery_id, pseudonym, role, consented_at from participants where id = $1', [participantId]);
  const row = r.rows[0];
  if (!row) throw new NotFoundError('Participant not found');
  return { id: row.id, discoveryId: row.discovery_id, pseudonym: row.pseudonym, role: row.role, consentedAt: row.consented_at };
}

export interface SessionRow { id: string; orgId: string; discoveryId: string; participantId: string; state: InterviewState; version: number }

const toSession = (row: any): SessionRow => ({
  id: row.id, orgId: row.org_id, discoveryId: row.discovery_id, participantId: row.participant_id, state: row.state, version: row.version,
});

export async function findLiveSession(tx: Tx, participantId: string): Promise<SessionRow | null> {
  const r = await tx.query(
    "select * from interview_sessions where participant_id = $1 and status in ('in_progress','paused')", [participantId]);
  return r.rows[0] ? toSession(r.rows[0]) : null;
}

export async function loadSession(tx: Tx, sessionId: string, opts: { forUpdate?: boolean } = {}): Promise<SessionRow> {
  const r = await tx.query(`select * from interview_sessions where id = $1${opts.forUpdate ? ' for update' : ''}`, [sessionId]);
  if (!r.rows[0]) throw new NotFoundError('Interview session not found'); // also what another firm sees, by RLS
  return toSession(r.rows[0]);
}

export async function insertSession(tx: Tx, p: { orgId: string; participantId: string; state: InterviewState; kind?: 'main' | 'follow_up' }): Promise<void> {
  await tx.query(
    `insert into interview_sessions (id, org_id, discovery_id, participant_id, status, state, started_at, version, kind)
     values ($1, $2, $3, $4, $5, $6, now(), 0, $7)`,
    [p.state.sessionId, p.orgId, p.state.discoveryId, p.participantId, p.state.status, p.state, p.kind ?? 'main']);
}

export async function findLatestSession(tx: Tx, participantId: string): Promise<SessionRow | null> {
  const r = await tx.query('select * from interview_sessions where participant_id = $1 order by started_at desc limit 1', [participantId]);
  return r.rows[0] ? toSession(r.rows[0]) : null;
}

// Optimistic concurrency: the save only succeeds if nobody else saved since we loaded.
export async function saveSession(tx: Tx, sessionId: string, expectedVersion: number, state: InterviewState): Promise<number> {
  const r = await tx.query(
    `update interview_sessions
        set state = $1, status = $2::session_status, version = version + 1, updated_at = now(),
            completed_at = case when $2::session_status in ('completed','escalated') then now() else completed_at end
      where id = $3 and version = $4
      returning version`,
    [state, state.status, sessionId, expectedVersion]);
  if (r.rowCount === 0) throw new ConcurrencyError('Session was updated by another request; reload and retry');
  return r.rows[0].version;
}

export async function insertEvidence(tx: Tx, orgId: string, discoveryId: string, items: VerifiedEvidence[]): Promise<void> {
  for (const e of items) {
    await tx.query(
      `insert into evidence_records (id, org_id, discovery_id, session_id, participant_pseudonym, source, pain_point_key,
         stage_id, task_description, responsible_role, monthly_volume, minutes_per_occurrence, people_involved, systems,
         operational_impact, reported_cause, potential_improvement, supporting_quote, outstanding_questions, conversion_assumptions)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [e.id, orgId, discoveryId, e.sessionId, e.participantRef, e.source, e.painPointKey, e.stageId, e.taskDescription,
       e.responsibleRole, e.monthlyVolume, e.minutesPerOccurrence, e.peopleInvolved, e.systems, e.operationalImpact,
       e.reportedCause, e.potentialImprovement, e.supportingQuote, e.outstandingQuestions, e.conversionAssumptions]);
  }
}

export async function insertEscalation(tx: Tx, p: { orgId: string; discoveryId: string; sessionId: string | null; reason: string; detail: string }): Promise<string> {
  const r = await tx.query(
    `insert into escalations (org_id, discovery_id, session_id, reason, details_redacted) values ($1,$2,$3,$4,$5) returning id`,
    [p.orgId, p.discoveryId, p.sessionId, p.reason, p.detail]);
  return r.rows[0].id;
}

export interface AuditRow { orgId: string; discoveryId: string | null; actor: string; action: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> }

export async function insertAudit(tx: Tx, rows: AuditRow[]): Promise<void> {
  for (const a of rows) {
    await tx.query(
      `insert into audit_log (org_id, discovery_id, actor, action, entity_type, entity_id, metadata) values ($1,$2,$3,$4,$5,$6,$7)`,
      [a.orgId, a.discoveryId, a.actor, a.action, a.entityType ?? null, a.entityId ?? null, a.metadata ?? {}]);
  }
}
