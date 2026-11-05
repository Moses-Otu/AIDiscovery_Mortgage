import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp, type App } from '../src/http/app';
import { DevCookieAuth } from '../src/http/auth';
import { SigninService } from '../src/http/signin';
import { InterviewService } from '../src/interview/service';
import { FirmService, ParticipantAccessService } from '../src/firm/service';
import { AnalysisService } from '../src/analysis/service';
import { DecisionService, JadaService } from '../src/implementation/service';
import { KnowledgeService } from '../src/knowledge/service';
import { ScriptedProvider } from '../src/llm/mock';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';

const APP = process.env.TEST_DATABASE_URL, ADMIN = process.env.TEST_ADMIN_DATABASE_URL;
const SECRET = 'signin-secret-signin-secret-signin-1';

describe.skipIf(!APP || !ADMIN)('push-button sign-in, no email (Postgres)', () => {
  const db = new pg.Pool({ connectionString: APP });
  const admin = new pg.Pool({ connectionString: ADMIN });
  const auth = new DevCookieAuth(SECRET);
  const firms = new FirmService(db, null, { appBaseUrl: 'http://demo', invitationDays: 30, playbookVersion: SEED_PLAYBOOK.version });
  const engineer = randomUUID(), editor = randomUUID();
  let app: App;
  const cookieFrom = (res: any, name: string) => { const c = res.cookies.find((x: any) => x.name === name && x.value); return c ? `${name}=${c.value}` : ''; };
  let lead = '', discoveryId = '';

  beforeAll(async () => {
    await admin.query('truncate organisations cascade');
    await admin.query('truncate app_users, jada_staff_roles, knowledge_items, knowledge_releases');
    await admin.query(`insert into app_users values ($1, 'Jo (JADA engineer)', 'jada'), ($2, 'Kim (knowledge editor)', 'jada')`, [engineer, editor]);
    await admin.query(`insert into jada_staff_roles values ($1, 'engineer'), ($2, 'knowledge_editor')`, [engineer, editor]);
    const llm = new ScriptedProvider({});
    const analysis = new AnalysisService(db, { providerFor: () => llm, playbook: SEED_PLAYBOOK, appBaseUrl: 'http://demo' });
    app = buildApp({ db, firms, analysis, firmAuth: auth, jadaAuth: auth, sessionSecret: SECRET, secureCookies: false,
      interviews: new InterviewService(db, { providerFor: () => llm, playbook: SEED_PLAYBOOK }), participants: new ParticipantAccessService(db),
      decisions: new DecisionService(db, { analysis, firms, playbook: SEED_PLAYBOOK }), jada: new JadaService(db),
      knowledge: new KnowledgeService(db, { allowUnreviewedSeed: true }), signin: new SigninService(db, firms),
      consent: { retentionMonths: 12, jadaContact: 'Jo' } });
  });
  afterAll(async () => { await app.close(); await db.end(); await admin.end(); });

  it('lists accounts and creates a firm with one click', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/signin/directory' })).json().accounts;
    expect(before.map((a: any) => a.name)).toEqual(['Jo (JADA engineer)', 'Kim (knowledge editor)']);
    const bad = await app.inject({ method: 'POST', url: '/api/signin/new-firm', payload: { firmName: '', yourName: '' } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/signin/new-firm', payload: { firmName: 'Harbour Lane Mortgages', yourName: 'Lena' } });
    expect(res.json()).toEqual({ next: '/firm' });
    lead = cookieFrom(res, 'bp_dev');
    const who = (await app.inject({ method: 'GET', url: '/api/whoami', headers: { cookie: lead } })).json();
    expect(who).toMatchObject({ name: 'Lena', kind: 'firm_lead', orgName: 'Harbour Lane Mortgages' });
  });

  it('signs JADA staff in to the right place, and rejects unknown accounts', async () => {
    const e = await app.inject({ method: 'POST', url: '/api/signin', payload: { userId: engineer } });
    expect(e.json()).toEqual({ next: '/jada' });
    expect(cookieFrom(e, 'bp_jada')).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: '/api/signin', payload: { userId: editor } })).json()).toEqual({ next: '/knowledge' });
    expect((await app.inject({ method: 'POST', url: '/api/signin', payload: { userId: randomUUID() } })).statusCode).toBe(404);
  });

  it('adding a person returns their link to copy; nothing is emailed and no email is stored', async () => {
    discoveryId = (await app.inject({ method: 'POST', url: '/api/firm/discoveries', headers: { cookie: lead } })).json().discoveryId;
    const list = (await app.inject({ method: 'GET', url: '/api/firm/discoveries', headers: { cookie: lead } })).json().discoveries;
    expect(list).toEqual([expect.objectContaining({ id: discoveryId, status: 'profile', hasProfile: false, people: 0, completed: 0 })]);
    const r = (await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/participants`, headers: { cookie: lead }, payload: { name: 'Cara', role: 'case_manager' } })).json();
    expect(r.link).toMatch(/^http:\/\/demo\/i\/[A-Za-z0-9_-]{40,}$/);
    expect((await admin.query('select email from participants where id = $1', [r.participantId])).rows[0].email).toBeNull();

    const path = new URL(r.link).pathname;
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(303);
    // A new link switches the old one off.
    const fresh = (await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/participants/${r.participantId}/link`, headers: { cookie: lead } })).json();
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: new URL(fresh.link).pathname })).statusCode).toBe(303);
  });

  it('JADA queue: firm asks for help, an engineer picks it up, then only they see it', async () => {
    const eng = `bp_jada=${auth.jadaCookieFor(engineer)}`, ed = `bp_jada=${auth.jadaCookieFor(editor)}`;
    expect((await app.inject({ method: 'GET', url: '/api/jada/queue', headers: { cookie: eng } })).json().queue).toEqual([]);
    await app.inject({ method: 'POST', url: `/api/firm/discoveries/${discoveryId}/help`, headers: { cookie: lead }, payload: { note: 'Can someone call me?' } });
    const q = (await app.inject({ method: 'GET', url: '/api/jada/queue', headers: { cookie: eng } })).json().queue;
    expect(q).toEqual([expect.objectContaining({ discoveryId, firmName: 'Harbour Lane Mortgages', reason: 'Someone asked for help' })]);
    expect(JSON.stringify(q)).not.toContain('Can someone call me');                 // details only after pick-up
    expect((await app.inject({ method: 'GET', url: '/api/jada/queue', headers: { cookie: ed } })).json().queue).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/jada/discoveries/${discoveryId}/pick-up`, headers: { cookie: ed } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/jada/discoveries/${discoveryId}`, headers: { cookie: eng } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/jada/discoveries/${discoveryId}/pick-up`, headers: { cookie: eng } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/jada/discoveries/${discoveryId}`, headers: { cookie: eng } })).json().escalations[0].detail).toBe('Can someone call me?');
    expect((await app.inject({ method: 'GET', url: '/api/jada/queue', headers: { cookie: eng } })).json().queue).toEqual([]);
    expect((await admin.query("select actor from audit_log where action = 'jada.picked_up'")).rows[0].actor).toBe(`jada:${engineer}`);
  });

  it('accepts button clicks that send a JSON header with no body (as browsers do)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/firm/discoveries', headers: { cookie: lead, 'content-type': 'application/json' }, payload: '' });
    expect(r.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/signin', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
  });

  it('sign out clears the session; pages are served', async () => {
    const out = await app.inject({ method: 'GET', url: '/signout', headers: { cookie: lead } });
    expect(out.statusCode).toBe(303);
    expect(out.cookies.find((c: any) => c.name === 'bp_dev')?.value).toBe('');
    for (const url of ['/', '/static/signin.js', '/firm', '/static/firm-home.js', '/static/session.js']) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

  it('push-button sign-in refuses to run in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { expect(() => new DevCookieAuth(SECRET)).toThrow(/must not be used in production/); } finally { process.env.NODE_ENV = prev; }
  });
});
