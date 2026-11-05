import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { InterviewService, ConsentRequiredError, SessionClosedError, InterviewTurnFailedError } from '../src/interview/service';
import { ConcurrencyError, NotFoundError, loadSession, saveSession } from '../src/db/repositories';
import { withFirmContext } from '../src/db/pool';
import { PgUsageLedger } from '../src/db/usageLedger';
import { BudgetedProvider, BudgetExceededError } from '../src/llm/budget';
import { ScriptedProvider } from '../src/llm/mock';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';

// Requires: TEST_DATABASE_URL (role builda_app) and TEST_ADMIN_DATABASE_URL (superuser, for seeding).
const APP = process.env.TEST_DATABASE_URL, ADMIN = process.env.TEST_ADMIN_DATABASE_URL;

const ORG_A = '00000000-0000-0000-0000-00000000000a', ORG_B = '00000000-0000-0000-0000-00000000000b';
const DISC_A = '10000000-0000-0000-0000-00000000000a', DISC_B = '10000000-0000-0000-0000-00000000000b';
const P1 = '20000000-0000-0000-0000-000000000001', P2 = '20000000-0000-0000-0000-000000000002', PB = '20000000-0000-0000-0000-0000000000b1';
const A = { orgId: ORG_A }, B = { orgId: ORG_B };

const noFlags = { clientInformation: false, complaintOrCompliance: false, employmentIssue: false, adviceRequest: false, outOfScope: false };
const interp = (over: Record<string, unknown> = {}) => ({ evidence: [], stagesConfirmedNotInvolved: [], flags: noFlags, wantsToPause: false, answerWasVague: false, ...over });
const chasingEvidence = {
  painPointKey: 'document_chasing', stageId: 'documents', taskDescription: 'Chasing payslips', responsibleRole: 'case_manager',
  volume: { value: 150, per: 'month' }, timePerOccurrence: { value: 20, unit: 'minutes' }, peopleInvolved: 2, systems: ['Email'],
  operationalImpact: null, reportedCause: null, potentialImprovement: null, supportingQuote: 'about 150 a month, 20 minutes each', outstandingQuestions: [],
};

describe.skipIf(!APP || !ADMIN)('persistence (Postgres, RLS enforced)', () => {
  const app = new pg.Pool({ connectionString: APP });
  const admin = new pg.Pool({ connectionString: ADMIN });
  afterAll(async () => { await app.end(); await admin.end(); });

  let llm: ScriptedProvider;
  const service = () => new InterviewService(app, { providerFor: () => llm, playbook: SEED_PLAYBOOK });

  beforeEach(async () => {
    await admin.query(`truncate organisations, org_members, discoveries, jada_assignments, participants, interview_sessions,
      evidence_records, pain_points, opportunities, corrections, escalations, ai_usage, audit_log cascade`);
    await admin.query(`insert into organisations (id, name) values ($1,'Firm A'), ($2,'Firm B')`, [ORG_A, ORG_B]);
    await admin.query(`insert into discoveries (id, org_id, playbook_version, scoring_config_version, created_by)
      values ($1,$2,'0.1.0','v1',gen_random_uuid()), ($3,$4,'0.1.0','v1',gen_random_uuid())`, [DISC_A, ORG_A, DISC_B, ORG_B]);
    await admin.query(`insert into participants (id, org_id, discovery_id, display_name, pseudonym, role, consent_version, consented_at) values
      ($1,$4,$5,'Sam Example','P1','case_manager','v1',now()),
      ($2,$4,$5,'Alex Example','P2','adviser',null,null),
      ($3,$6,$7,'Other Firm Person','P1','administrator','v1',now())`, [P1, P2, PB, ORG_A, DISC_A, ORG_B, DISC_B]);
  });

  it('starts once and resumes the same session when the link is reopened', async () => {
    const first = await service().startOrResume(A, P1);
    const again = await service().startOrResume(A, P1);
    expect(first.resumed).toBe(false);
    expect(again.resumed).toBe(true);
    expect(again.sessionId).toBe(first.sessionId);
    const audit = await admin.query('select action from audit_log order by id');
    expect(audit.rows.map((r) => r.action)).toEqual(['interview.started', 'interview.reopened']);
  });

  it('refuses to start without consent', async () => {
    await expect(service().startOrResume(A, P2)).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('persists a turn: state, evidence and audit together', async () => {
    llm = new ScriptedProvider({ 'interview.interpret': [interp({ evidence: [chasingEvidence] })], 'interview.next_question': [{ question: 'How do you track what is outstanding?' }] });
    const s = await service().startOrResume(A, P1);
    const out = await service().submitMessage(A, s.sessionId, 'Documents mostly — about 150 a month, 20 minutes each.');
    expect(out.reply).toMatch(/track/);

    const ev = await admin.query('select pain_point_key, monthly_volume, minutes_per_occurrence, participant_pseudonym, org_id from evidence_records');
    expect(ev.rows).toEqual([{ pain_point_key: 'document_chasing', monthly_volume: '150', minutes_per_occurrence: '20', participant_pseudonym: 'P1', org_id: ORG_A }]);
    const sess = await admin.query('select version, status from interview_sessions');
    expect(sess.rows[0]).toEqual({ version: 1, status: 'in_progress' });
    const audit = await admin.query("select action from audit_log where action like 'interview.%' order by id");
    expect(audit.rows.map((r) => r.action)).toEqual(['interview.started', 'interview.evidence_added', 'interview.focus_changed']);
  });

  it('client details: escalates, records it, and stores no raw identifiers anywhere', async () => {
    llm = new ScriptedProvider({});
    const s = await service().startOrResume(A, P1);
    const out = await service().submitMessage(A, s.sessionId, 'Mrs Henderson-Blake keeps sending the wrong payslips, email her at hb@example.com');
    expect(out.status).toBe('escalated');
    expect(llm.calls).toHaveLength(0);

    const esc = await admin.query('select reason, details_redacted, status from escalations');
    expect(esc.rows[0]).toMatchObject({ reason: 'client_information', status: 'open' });
    for (const [table, col] of [['interview_sessions', 'state'], ['audit_log', 'metadata'], ['escalations', 'details_redacted']]) {
      const dump = await admin.query(`select string_agg(${col}::text, ' ') as t from ${table}`);
      expect(dump.rows[0].t ?? '').not.toMatch(/Henderson|hb@example/);
    }
    await expect(service().submitMessage(A, s.sessionId, 'hello?')).rejects.toBeInstanceOf(SessionClosedError);
  });

  it('another firm cannot see or write to the session', async () => {
    const s = await service().startOrResume(A, P1);
    await expect(service().getSession(B, s.sessionId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service().submitMessage(B, s.sessionId, 'hi')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service().startOrResume(B, P1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a stale save instead of overwriting', async () => {
    const s = await service().startOrResume(A, P1);
    const row = await withFirmContext(app, A, (tx) => loadSession(tx, s.sessionId));
    await withFirmContext(app, A, (tx) => saveSession(tx, s.sessionId, row.version, row.state));
    await expect(withFirmContext(app, A, (tx) => saveSession(tx, s.sessionId, row.version, row.state))).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it('pause, then a new message resumes', async () => {
    llm = new ScriptedProvider({ 'interview.interpret': [interp({ answerWasVague: true })], 'interview.next_question': [{ question: 'Which stages do you handle?' }] });
    const s = await service().startOrResume(A, P1);
    expect((await service().pause(A, s.sessionId)).status).toBe('paused');
    expect((await service().startOrResume(A, P1)).resumed).toBe(true);
    const out = await service().submitMessage(A, s.sessionId, "I'm back now");
    expect(out.status).toBe('in_progress');
  });

  it('a failed AI turn saves nothing but is audited', async () => {
    llm = new ScriptedProvider({}); // no scripted answer -> provider throws
    const s = await service().startOrResume(A, P1);
    await expect(service().submitMessage(A, s.sessionId, 'We do around 150 a month')).rejects.toBeInstanceOf(InterviewTurnFailedError);
    const sess = await admin.query('select version from interview_sessions');
    expect(sess.rows[0].version).toBe(0);
    const audit = await admin.query("select metadata from audit_log where action = 'interview.turn_failed'");
    expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/150/);
  });

  it('records AI usage per discovery and enforces the budget', async () => {
    const ledger = new PgUsageLedger(app, ORG_A);
    const scripted = new ScriptedProvider({ 'interview.interpret': [interp(), interp()], 'interview.next_question': [{ question: 'Next question?' }] }, 600);
    const svc = new InterviewService(app, {
      providerFor: ({ discoveryId }) => new BudgetedProvider(scripted, ledger, { discoveryId, maxTokensPerDiscovery: 1000 }),
      playbook: SEED_PLAYBOOK,
    });
    const s = await svc.startOrResume(A, P1);
    await svc.submitMessage(A, s.sessionId, 'I handle documents and offers');      // 2 calls x 600 = 1200 tokens
    expect(await ledger.spentTokens(DISC_A)).toBe(1200);
    const err = await svc.submitMessage(A, s.sessionId, 'Anything else?').catch((e) => e);
    expect(err).toBeInstanceOf(InterviewTurnFailedError);
    expect(err.cause).toBeInstanceOf(BudgetExceededError);
    expect(await new PgUsageLedger(app, ORG_B).spentTokens(DISC_A)).toBe(0); // Firm B can't see Firm A's usage
  });

  it('firm lead can request a person', async () => {
    const id = await service().requestHumanHelp({ orgId: ORG_A, userId: '30000000-0000-0000-0000-000000000001' }, DISC_A, 'Please call me about the findings');
    const esc = await admin.query('select reason from escalations where id = $1', [id]);
    expect(esc.rows[0].reason).toBe('firm_lead_requested');
  });
});
