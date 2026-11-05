import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp, type App } from '../src/http/app';
import { DevCookieAuth } from '../src/http/auth';
import { InterviewService } from '../src/interview/service';
import { FirmService, ParticipantAccessService } from '../src/firm/service';
import { AnalysisService } from '../src/analysis/service';
import { DevOutboxMailer } from '../src/firm/mailer';
import { ScriptedProvider } from '../src/llm/mock';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';
import { CONSENT_VERSION } from '../src/participant/consent';
import { DecisionService, JadaService } from '../src/implementation/service';
import { KnowledgeService } from '../src/knowledge/service';
import { STAGE_IDS } from '../src/domain/journey';

const APP = process.env.TEST_DATABASE_URL, ADMIN = process.env.TEST_ADMIN_DATABASE_URL;
const SECRET = 'test-secret-test-secret-test-secret-123';
const noFlags = { clientInformation: false, complaintOrCompliance: false, employmentIssue: false, adviceRequest: false, outOfScope: false };

// One turn that covers the documents stage (two evidence items) and rules out every other stage.
const coverDocuments = (key: string, minutes: number, quoteA: string, quoteB: string, role = 'case_manager') => ({
  evidence: [quoteA, quoteB].map((q) => ({ painPointKey: key, stageId: 'documents', taskDescription: 'Chasing documents from clients', responsibleRole: role,
    volume: { value: 150, per: 'month' }, timePerOccurrence: { value: minutes, unit: 'minutes' }, peopleInvolved: null, systems: ['Email'],
    operationalImpact: 'Applications stall', reportedCause: 'Clients send partial packs', potentialImprovement: 'Automatic reminders', supportingQuote: q, outstandingQuestions: [] })),
  stagesConfirmedNotInvolved: STAGE_IDS.filter((s) => s !== 'documents'), flags: noFlags, wantsToPause: false, answerWasVague: false,
});

describe.skipIf(!APP || !ADMIN)('end to end over HTTP', () => {
  const db = new pg.Pool({ connectionString: APP });
  const admin = new pg.Pool({ connectionString: ADMIN });
  const mailer = new DevOutboxMailer();
  let llm = new ScriptedProvider({});
  const providerFor = () => llm;
  const auth = new DevCookieAuth(SECRET);
  const firms = new FirmService(db, mailer, { appBaseUrl: 'http://test', invitationDays: 30, playbookVersion: SEED_PLAYBOOK.version });
  let app: App;
  const orgId = randomUUID(), userId = randomUUID(), otherOrg = randomUUID(), otherUser = randomUUID();
  let discoveryId = '';
  const leadCookie = () => `bp_dev=${auth.cookieFor({ userId, orgId })}`;
  const cookies: Record<string, string> = {};

  const linkFor = (email: string, nth = 0) => mailer.sent.filter((m) => m.to === email)[nth]!.text.match(/http:\/\/test(\/i\/\S+)/)![1]!;
  const open = async (path: string) => {
    const res = await app.inject({ method: 'GET', url: path });
    const c = res.cookies.find((x) => x.name === 'bp_p');
    return { res, cookie: c ? `bp_p=${c.value}` : '' };
  };

  beforeAll(async () => {
    const analysis = new AnalysisService(db, { providerFor, playbook: SEED_PLAYBOOK, mailer, appBaseUrl: 'http://test' });
    app = buildApp({
      db, firms, firmAuth: auth, jadaAuth: auth, sessionSecret: SECRET, secureCookies: false, analysis,
      interviews: new InterviewService(db, { providerFor, playbook: SEED_PLAYBOOK }),
      participants: new ParticipantAccessService(db),
      decisions: new DecisionService(db, { analysis, firms, playbook: SEED_PLAYBOOK }),
      jada: new JadaService(db),
      knowledge: new KnowledgeService(db, { allowUnreviewedSeed: true }),
      consent: { retentionMonths: 12, jadaContact: 'Test Contact' },
    });
    await firms.createFirm({ orgId, name: 'Test Brokers', leadUserId: userId });
    await firms.createFirm({ orgId: otherOrg, name: 'Other Brokers', leadUserId: otherUser });
  });
  afterAll(async () => { await app.close(); await db.end(); await admin.end(); });

  it('firm lead creates a discovery, saves the profile and invites people', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/firm/discoveries', headers: { cookie: leadCookie() } });
    discoveryId = created.json().discoveryId;
    expect(created.statusCode).toBe(200);

    const bad = await app.inject({ method: 'PUT', url: `/api/firm/discoveries/${discoveryId}/profile`, headers: { cookie: leadCookie() }, payload: { advisers: 'lots' } });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({ method: 'PUT', url: `/api/firm/discoveries/${discoveryId}/profile`, headers: { cookie: leadCookie() }, payload: {
      advisers: 12, monthlyApplications: 150, typicalWeeksEnquiryToOffer: 6, businessStructure: 'One office', staffRoles: [{ role: 'adviser', count: 12 }],
      systems: ['CRM'], authorisation: 'directly_authorised', operationalChallenges: 'Slow document collection', loadedHourlyCostGBP: 20 } });
    expect(good.statusCode).toBe(200);

    for (const [name, email, role] of [['Lena Lead', 'lead@t.test', 'firm_lead'], ['Cara Case', 'cara@t.test', 'case_manager'], ['Adam Adviser', 'adam@t.test', 'adviser']]) {
      const r = await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/participants`, headers: { cookie: leadCookie() }, payload: { name, email, role } });
      expect(r.statusCode).toBe(200);
    }
    expect(mailer.sent).toHaveLength(3);
    expect(mailer.sent[1]!.text).toMatch(/not an assessment of you/);
    const tokens = await admin.query('select token_hash from invitations');
    expect(tokens.rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true); // only hashes stored
  });

  it('other firms and participants cannot use the firm-lead API', async () => {
    const otherLead = `bp_dev=${auth.cookieFor({ userId: otherUser, orgId: otherOrg })}`;
    const r = await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/progress`, headers: { cookie: otherLead } });
    expect(r.json().participants).toEqual([]); // RLS: the other firm sees nothing
    const pb = await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/playback`, headers: { cookie: otherLead } });
    expect(pb.json().painPoints).toEqual([]);
    const anon = await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/progress` });
    expect(anon.statusCode).toBe(401);
  });

  it('invalid links show a friendly page; valid links set a session and require consent', async () => {
    const bad = await open('/i/not-a-real-token');
    expect(bad.res.statusCode).toBe(404);
    expect(bad.res.body).toMatch(/isn’t working/);

    const { res, cookie } = await open(linkFor('cara@t.test'));
    expect(res.statusCode).toBe(303);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    cookies.cara = cookie;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ firmName: 'Test Brokers', consentRequired: true, session: null });
    expect(me.json().consent.sections.map((s: any) => s.heading)).toContain('What not to share');
    const blocked = await app.inject({ method: 'POST', url: '/api/interview/message', headers: { cookie }, payload: { text: 'hi' } });
    expect(blocked.statusCode).toBe(409);
    const stale = await app.inject({ method: 'POST', url: '/api/consent', headers: { cookie }, payload: { version: 'old' } });
    expect(stale.statusCode).toBe(409);
  });

  it('three people consent and complete interviews', async () => {
    cookies.lead = (await open(linkFor('lead@t.test'))).cookie;
    cookies.adam = (await open(linkFor('adam@t.test'))).cookie;
    const answers: [string, string, ReturnType<typeof coverDocuments>][] = [
      ['cara', 'We chase about 150 a month. Each chase takes 10 minutes.', coverDocuments('document_chasing', 10, 'chase about 150 a month', 'Each chase takes 10 minutes')],
      ['adam', 'Chasing docs is constant, 150 a month and about 45 minutes each with my clients.', coverDocuments('chasing_client_docs', 45, '150 a month', 'about 45 minutes each', 'adviser')],
      ['lead', 'I mostly look at documents. Around 150 a month, roughly 12 minutes each.', coverDocuments('document_chasing', 12, 'Around 150 a month', 'roughly 12 minutes each', 'firm_lead')],
    ];
    llm = new ScriptedProvider({ 'interview.interpret': answers.map((a) => a[2]) });
    for (const [who, text] of answers) {
      const consent = await app.inject({ method: 'POST', url: '/api/consent', headers: { cookie: cookies[who]! }, payload: { version: CONSENT_VERSION } });
      expect(consent.json().status).toBe('in_progress');
      const turn = await app.inject({ method: 'POST', url: '/api/interview/message', headers: { cookie: cookies[who]! }, payload: { text } });
      expect(turn.json().status).toBe('completed');
    }
    // Reopening a finished interview shows it finished — it does not restart.
    const again = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookies.cara! } });
    expect(again.json().session.status).toBe('completed');
    const progress = await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/progress`, headers: { cookie: leadCookie() } });
    expect(progress.json().participants.map((p: any) => p.status)).toEqual(['completed', 'completed', 'completed']);
  });

  it('analysis merges keys, finds the disagreement by role, ranks and explains', async () => {
    llm = new ScriptedProvider({
      'analysis.merge_keys': [{ merges: [{ canonicalKey: 'chasing_client_docs', mergedKeys: ['document_chasing'], reason: 'Same task' }] }],
      'analysis.classify': [{ classification: 'automate', rationale: 'Repetitive reminders with a clear trigger and end point.', supportingQuotes: ['chase about 150 a month'], humanElements: ['Staff approve reminders'] }],
    });
    const r = await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/analyse`, headers: { cookie: leadCookie() } });
    expect(r.statusCode).toBe(200);
    const pb = r.json();
    expect(pb.painPoints).toHaveLength(1);
    const p = pb.painPoints[0];
    expect(p.key).toBe('document_chasing');                       // playbook key won the merge
    expect(p.classification).toBe('automate');
    expect(p.confidence).toBe('low');                             // 10 vs 45 minutes is not consistent
    expect(p.disagreements[0].values.map((v: any) => v.role)).toEqual(['Case manager', 'Firm owner / Managing Director', 'Mortgage adviser']);
    expect(pb.topThree).toEqual([p.id]);
    expect(p.impact.monthlyHoursRecovered).toBe(15);               // 150 × 12 min (median) × 50% template assumption
    expect(p.twoWeek.blockers).toContain('Template "Document chasing with staff-approved reminders" is not yet tested');
    const body = JSON.stringify(pb);
    for (const secret of ['Cara', 'Adam', 'Lena', 'P1', 'P2', 'P3', '@t.test']) expect(body).not.toContain(secret);
  });

  it('firm lead corrections are audited and re-score without the AI', async () => {
    const pb = (await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/playback`, headers: { cookie: leadCookie() } })).json();
    const id = pb.painPoints[0].id;
    llm = new ScriptedProvider({}); // any model call would throw
    const r = await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/pain-points/${id}/corrections`, headers: { cookie: leadCookie() },
      payload: { field: 'minutesPerOccurrence', value: 20, reason: 'Checked our case system: 20 minutes is typical' } });
    expect(r.statusCode).toBe(200);
    const p = r.json().painPoints[0];
    expect(p.impact.monthlyHoursRecovered).toBe(25);
    expect(p.impact.monthlyCapacityValueGBP).toBe(500);
    expect(p.corrections[0]).toMatchObject({ field: 'minutesPerOccurrence', new_value: 20 });
    const bad = await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/pain-points/${id}/corrections`, headers: { cookie: leadCookie() },
      payload: { field: 'classification', value: 'magic', reason: 'x' } });
    expect(bad.statusCode).toBe(400);
    const tamper = await db.query('update corrections set reason = $1', ['changed']).catch((e) => e);
    expect(tamper.message).toMatch(/permission denied/);
  });

  it('follow-ups go to the people whose figures differed, through a new link', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/follow-ups`, headers: { cookie: leadCookie() } });
    const fu = r.json();
    expect(fu).toMatchObject({ participants: 3, questions: 3 });
    expect(fu.links.map((l: any) => l.name).sort()).toEqual(['Adam Adviser', 'Cara Case', 'Lena Lead']);
    const { cookie } = await open(linkFor('cara@t.test', 1));
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me.session.mode).toBe('follow_up');
    expect(me.session.lastInterviewerMessage).toMatch(/from about 10 minutes to 45 minutes/);
    llm = new ScriptedProvider({ 'interview.interpret': [{ evidence: [], stagesConfirmedNotInvolved: [], flags: noFlags, wantsToPause: false, answerWasVague: false }] });
    const done = await app.inject({ method: 'POST', url: '/api/interview/message', headers: { cookie }, payload: { text: 'Partial packs make it slower — usually 15 minutes.' } });
    expect(done.json().status).toBe('completed');
  });

  it('firm lead can ask JADA for help', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/help`, headers: { cookie: leadCookie() }, payload: { note: 'Call me' } });
    expect(r.json().escalationId).toBeTruthy();
  });

  it('report: immutable versioned snapshots and a PDF only the firm can fetch', async () => {
    const r1 = (await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/reports`, headers: { cookie: leadCookie() } })).json();
    const r2 = (await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/reports`, headers: { cookie: leadCookie() } })).json();
    expect([r1.version, r2.version]).toEqual([1, 2]);
    const pdf = await app.inject({ method: 'GET', url: r1.pdfUrl, headers: { cookie: leadCookie() } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/Test-Brokers-discovery-report-v1\.pdf/);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const otherLead = `bp_dev=${auth.cookieFor({ userId: otherUser, orgId: otherOrg })}`;
    expect((await app.inject({ method: 'GET', url: r1.pdfUrl, headers: { cookie: otherLead } })).statusCode).toBe(404);
    const model = (await admin.query('select model from reports where id = $1', [r1.reportId])).rows[0].model;
    for (const secret of ['Cara', 'Adam', 'Lena', '@t.test']) expect(JSON.stringify(model)).not.toContain(secret);
    expect((await db.query('update reports set version = 99').catch((e) => e)).message).toMatch(/permission denied/);
  });

  let packId = '';
  const jadaUser = randomUUID();
  const jadaCookie = () => `bp_jada=${auth.jadaCookieFor(jadaUser)}`;

  it('firm lead approves priorities and chooses what to build, creating a pack', async () => {
    const pb = (await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/playback`, headers: { cookie: leadCookie() } })).json();
    const id = pb.painPoints[0].id;
    const bad = await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/approve`, headers: { cookie: leadCookie() }, payload: { priorities: [randomUUID()], proceedWith: null } });
    expect(bad.statusCode).toBe(400);
    const ok = (await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/approve`, headers: { cookie: leadCookie() }, payload: { priorities: [id], proceedWith: id, note: 'Start here' } })).json();
    packId = ok.packId;
    expect(packId).toBeTruthy();
    const again = (await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/approve`, headers: { cookie: leadCookie() }, payload: { priorities: [id], proceedWith: id } })).json();
    expect(again.packId).toBe(packId);
    expect((await admin.query('select count(*)::int as n from implementation_packs')).rows[0].n).toBe(1);
    const after = (await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/playback`, headers: { cookie: leadCookie() } })).json();
    expect(after.painPoints[0].validated).toBe(true);
    const status = (await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/implementation`, headers: { cookie: leadCookie() } })).json();
    expect(status.packs[0]).toMatchObject({ status: 'in_review', title: 'Manual chasing of outstanding client documents' });
  });

  it('JADA sees nothing until assigned, then only the assigned discovery', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/jada/discoveries' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/jada/discoveries', headers: { cookie: jadaCookie() } })).json().discoveries).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/jada/discoveries/${discoveryId}`, headers: { cookie: jadaCookie() } })).statusCode).toBe(404);
    await admin.query('insert into jada_assignments (discovery_id, staff_user_id) values ($1, $2)', [discoveryId, jadaUser]);
    const list = (await app.inject({ method: 'GET', url: '/api/jada/discoveries', headers: { cookie: jadaCookie() } })).json().discoveries;
    expect(list).toEqual([{ id: discoveryId, firmName: 'Test Brokers', status: 'priorities_approved', openEscalations: 1, packsToReview: 1 }]);
    const d = (await app.inject({ method: 'GET', url: `/api/jada/discoveries/${discoveryId}`, headers: { cookie: jadaCookie() } })).json();
    expect(d.packs[0].content.testCases.length).toBeGreaterThan(0);
    for (const secret of ['Cara', 'Adam', 'Lena', '@t.test', '"P1"', '"P2"']) expect(JSON.stringify(d.packs)).not.toContain(secret);
    const md = await app.inject({ method: 'GET', url: `/api/jada/packs/${packId}/markdown`, headers: { cookie: jadaCookie() } });
    expect(md.body).toMatch(/^# Implementation pack: Manual chasing of outstanding client documents/);
    // Another firm's discovery stays invisible.
    const otherDisc = (await app.inject({ method: 'POST', url: '/api/firm/discoveries', headers: { cookie: `bp_dev=${auth.cookieFor({ userId: otherUser, orgId: otherOrg })}` } })).json().discoveryId;
    expect((await app.inject({ method: 'GET', url: `/api/jada/discoveries/${otherDisc}`, headers: { cookie: jadaCookie() } })).statusCode).toBe(404);
  });

  it('engineering review is recorded; an untested template blocks confirmation', async () => {
    const r = (await app.inject({ method: 'POST', url: `/api/jada/packs/${packId}/reviews`, headers: { cookie: jadaCookie() }, payload: {
      checks: { singleWorkflowWithStartAndFinish: true, changesCoreSystems: false, accessAndTestDataReadyDayOne: true, humanApprovalForCommsAndRecordChanges: true, complianceQuestionsResolved: true },
      unresolvedDependencies: [], notes: 'All prerequisites in place' } })).json();
    expect(r).toEqual({ decision: 'needs_changes', failures: ['Template document_chasing_v1 is not yet tested'] });
    const status = (await app.inject({ method: 'GET', url: `/api/firm/discoveries/${discoveryId}/implementation`, headers: { cookie: leadCookie() } })).json();
    expect(status.packs[0]).toMatchObject({ status: 'needs_changes', failures: ['Template document_chasing_v1 is not yet tested'] });
    expect((await db.query("update pack_reviews set decision = 'confirmed'").catch((e) => e)).message).toMatch(/permission denied/);
    const audit = await admin.query("select actor from audit_log where action = 'pack.needs_changes'");
    expect(audit.rows[0].actor).toBe(`jada:${jadaUser}`);
  });

  it('JADA resolves escalations for assigned discoveries', async () => {
    const d = (await app.inject({ method: 'GET', url: `/api/jada/discoveries/${discoveryId}`, headers: { cookie: jadaCookie() } })).json();
    const esc = d.escalations.find((e: any) => e.status === 'open');
    expect(esc.reason).toBe('firm_lead_requested');
    expect((await app.inject({ method: 'POST', url: `/api/jada/escalations/${esc.id}/resolve`, headers: { cookie: jadaCookie() }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/jada/escalations/${esc.id}/resolve`, headers: { cookie: jadaCookie() }, payload: {} })).statusCode).toBe(404);
  });

  it('knowledge API needs JADA sign-in and a knowledge role', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/knowledge' })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url: '/api/knowledge', headers: { cookie: `bp_jada=${auth.jadaCookieFor(randomUUID())}` } });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/knowledge', headers: { cookie: leadCookie() } })).statusCode).toBe(401); // firm leads are not JADA staff
  });

  it('serves the participant and firm pages', async () => {
    for (const url of ['/interview', '/static/interview.js', '/static/app.css', `/firm/discoveries/${discoveryId}`, '/jada', '/static/jada.js', '/knowledge', '/static/knowledge.js', '/static/fonts/AtkinsonHyperlegible-Regular.ttf']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
  });
});
