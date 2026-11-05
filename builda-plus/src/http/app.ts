import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { Db } from '../db/pool';
import { NotFoundError, ConcurrencyError } from '../db/repositories';
import { InterviewService, ConsentRequiredError, SessionClosedError, InterviewTurnFailedError, MessageTooLongError } from '../interview/service';
import { FirmService, ParticipantAccessService, ConsentVersionError } from '../firm/service';
import { AnalysisService } from '../analysis/service';
import { CONSENT_VERSION, consentSections, type ConsentConfig } from '../participant/consent';
import { signParticipant, verifyParticipant, type ParticipantPrincipal } from './tokens';
import { DevCookieAuth, type FirmLeadAuth, type FirmLeadIdentity, type JadaAuth } from './auth';
import { DecisionService, JadaService } from '../implementation/service';
import { renderReportPdf } from '../report/pdf';
import { SigninService } from './signin';
import { KnowledgeService, KnowledgeForbiddenError, ReleaseBlockedError, NoApprovedReleaseError } from '../knowledge/service';

export interface AppDeps {
  db: Db;
  interviews: InterviewService;
  firms: FirmService;
  participants: ParticipantAccessService;
  analysis: AnalysisService;
  firmAuth: FirmLeadAuth;
  jadaAuth: JadaAuth;
  decisions: DecisionService;
  jada: JadaService;
  knowledge?: KnowledgeService;
  signin?: SigninService;
  sessionSecret: string;
  consent: Omit<ConsentConfig, 'firmName'>;
  secureCookies: boolean;
  publicDir?: string;
}

const STATIC: Record<string, string> = {
  '/interview': 'interview.html', '/static/interview.js': 'interview.js',
  '/static/app.css': 'app.css', '/static/firm.js': 'firm.js', '/static/jada.js': 'jada.js', '/jada': 'jada.html', '/knowledge': 'knowledge.html', '/static/knowledge.js': 'knowledge.js',
  '/': 'signin.html', '/static/signin.js': 'signin.js', '/firm': 'firm-home.html', '/static/firm-home.js': 'firm-home.js', '/static/session.js': 'session.js',
};
const FONTS = new Set(['SourceSerif4-Regular.ttf', 'SourceSerif4-Semibold.ttf', 'AtkinsonHyperlegible-Regular.ttf', 'AtkinsonHyperlegible-Bold.ttf']);
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  app.register(cookie);
  // Browsers send "Content-Type: application/json" on button clicks with no body; treat that as {}.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined) return done(null, {});
    try { done(null, JSON.parse(body as string)); }
    catch { done(Object.assign(new Error('The request body isn’t valid JSON.'), { statusCode: 400 }), undefined); }
  });
  const publicDir = deps.publicDir ?? join(process.cwd(), 'public');
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: deps.secureCookies };

  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer'); // invitation tokens must never leak via Referer
    reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Some details are missing or invalid.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'Not found.' });
    if (err instanceof KnowledgeForbiddenError) return reply.code(403).send({ error: err.message });
    if (err instanceof ReleaseBlockedError) return reply.code(409).send({ error: err.message, problems: err.problems });
    if (err instanceof NoApprovedReleaseError) return reply.code(409).send({ error: err.message });
    if (err instanceof ConsentRequiredError) return reply.code(403).send({ error: err.message });
    if (err instanceof SessionClosedError || err instanceof ConcurrencyError || err instanceof ConsentVersionError) return reply.code(409).send({ error: err.message });
    if (err instanceof MessageTooLongError) return reply.code(400).send({ error: err.message });
    if (err instanceof InterviewTurnFailedError) return reply.code(503).send({ error: err.message });
    if ((err as any).statusCode && (err as any).statusCode < 500) return reply.code((err as any).statusCode).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side. Nothing you typed was lost from this page — please try again.' });
  });

  for (const [route, file] of Object.entries(STATIC)) {
    app.get(route, async (_req, reply) => reply.type(TYPES[file.split('.').pop()!]!).send(readFileSync(join(publicDir, file))));
  }
  app.get('/firm/discoveries/:id', async (_req, reply) => reply.type(TYPES.html!).send(readFileSync(join(publicDir, 'firm.html'))));
  app.get('/jada/discoveries/:id', async (_req, reply) => reply.type(TYPES.html!).send(readFileSync(join(publicDir, 'jada.html'))));
  app.get<{ Params: { file: string } }>('/static/fonts/:file', async (req, reply) => {
    if (!FONTS.has(req.params.file)) return reply.code(404).send({ error: 'Not found.' });
    return reply.type('font/ttf').header('cache-control', 'public, max-age=31536000, immutable').send(readFileSync(join(publicDir, 'fonts', req.params.file)));
  });

  // ---------- participants ----------
  const participant = (req: FastifyRequest): ParticipantPrincipal => {
    const p = verifyParticipant(req.cookies['bp_p'], deps.sessionSecret);
    if (!p) throw Object.assign(new Error('Your session has expired. Please open the link from your invitation email again.'), { statusCode: 401 });
    return p;
  };
  const pctx = (p: ParticipantPrincipal) => ({ orgId: p.orgId });

  app.get<{ Params: { token: string } }>('/i/:token', async (req, reply) => {
    const resolved = await deps.participants.resolveInvitation(req.params.token);
    if (!resolved) return reply.code(404).type(TYPES.html!).send(readFileSync(join(publicDir, 'link-expired.html')));
    reply.setCookie('bp_p', signParticipant(resolved, deps.sessionSecret), cookieOpts);
    return reply.redirect('/interview', 303);
  });

  app.get('/api/me', async (req) => {
    const p = participant(req);
    const info = await deps.participants.participantContext(pctx(p), p.participantId);
    const session = info.consented ? await deps.interviews.startOrResume(pctx(p), p.participantId) : null;
    return {
      firmName: info.firmName, role: info.role, consentRequired: !info.consented,
      consent: info.consented ? null : { version: CONSENT_VERSION, sections: consentSections({ ...deps.consent, firmName: info.firmName }) },
      session,
    };
  });
  app.post<{ Body: { version: string } }>('/api/consent', async (req) => {
    const p = participant(req);
    await deps.participants.recordConsent(pctx(p), p.participantId, String(req.body?.version ?? ''));
    return deps.interviews.startOrResume(pctx(p), p.participantId);
  });
  app.post<{ Body: { text: string } }>('/api/interview/message', async (req) => {
    const p = participant(req);
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw Object.assign(new Error('Type an answer before sending.'), { statusCode: 400 });
    return deps.interviews.submitForParticipant(pctx(p), p.participantId, text);
  });
  app.post('/api/interview/pause', async (req) => {
    const p = participant(req);
    return deps.interviews.pauseForParticipant(pctx(p), p.participantId);
  });

  // ---------- firm lead ----------
  const lead = async (req: FastifyRequest): Promise<FirmLeadIdentity> => {
    const id = await deps.firmAuth.authenticate(req);
    if (!id) throw Object.assign(new Error('Sign in to continue.'), { statusCode: 401 });
    if (!(await deps.firms.isFirmLead(id))) throw Object.assign(new Error('Only the firm lead can do this.'), { statusCode: 403 });
    return id;
  };
  type P = { Params: { id: string; pid?: string } };

  app.post('/api/firm/discoveries', async (req) => ({ discoveryId: await deps.firms.createDiscovery(await lead(req)) }));
  app.get<P>('/api/firm/discoveries/:id/profile', async (req) => ({ profile: await deps.firms.getProfile(await lead(req), req.params.id) }));
  app.put<P>('/api/firm/discoveries/:id/profile', async (req) => ({ profile: await deps.firms.saveProfile(await lead(req), req.params.id, req.body) }));
  app.post<P>('/api/firm/discoveries/:id/participants', async (req) => deps.firms.inviteParticipant(await lead(req), req.params.id, req.body));
  app.post<P>('/api/firm/discoveries/:id/participants/:pid/link', async (req) => deps.firms.newLink(await lead(req), req.params.id, req.params.pid!));
  app.get('/api/firm/discoveries', async (req) => ({ discoveries: await deps.firms.listDiscoveries(await lead(req)) }));
  app.get<P>('/api/firm/discoveries/:id/progress', async (req) => ({ participants: await deps.firms.progress(await lead(req), req.params.id) }));
  app.post<P>('/api/firm/discoveries/:id/analyse', async (req) => { await deps.analysis.analyse(await lead(req), req.params.id); return deps.analysis.playback(await lead(req), req.params.id); });
  app.post<P>('/api/firm/discoveries/:id/follow-ups', async (req) => deps.analysis.sendFollowUps(await lead(req), req.params.id));
  app.get<P>('/api/firm/discoveries/:id/playback', async (req) => deps.analysis.playback(await lead(req), req.params.id));
  app.post<P>('/api/firm/discoveries/:id/pain-points/:pid/corrections', async (req) => {
    const id = await lead(req);
    await deps.analysis.correct(id, req.params.id, req.params.pid!, req.body);
    return deps.analysis.playback(id, req.params.id);
  });
  app.post<P & { Body: { note?: string } }>('/api/firm/discoveries/:id/help', async (req) => {
    const id = await lead(req);
    return { escalationId: await deps.interviews.requestHumanHelp(id, req.params.id, String((req.body as any)?.note ?? '')) };
  });

  // ---------- reports and decisions (milestones 9–10) ----------
  app.post<P>('/api/firm/discoveries/:id/reports', async (req) => {
    const r = await deps.decisions.createReport(await lead(req), req.params.id);
    return { ...r, pdfUrl: `/api/firm/discoveries/${req.params.id}/reports/${r.reportId}/pdf` };
  });
  app.get<{ Params: { id: string; rid: string } }>('/api/firm/discoveries/:id/reports/:rid/pdf', async (req, reply) => {
    const model = await deps.decisions.getReport(await lead(req), req.params.id, req.params.rid);
    const pdf = await renderReportPdf(model, { fontDir: join(publicDir, 'fonts') });
    const safe = model.firmName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'firm';
    return reply.type('application/pdf').header('content-disposition', `attachment; filename="${safe}-discovery-report-v${model.version}.pdf"`).send(pdf);
  });
  app.post<P>('/api/firm/discoveries/:id/approve', async (req) => deps.decisions.approve(await lead(req), req.params.id, req.body));
  app.get<P>('/api/firm/discoveries/:id/implementation', async (req) => ({ packs: await deps.decisions.packStatus(await lead(req), req.params.id) }));

  // ---------- JADA engineering ----------
  const jadaUser = async (req: FastifyRequest) => {
    const id = await deps.jadaAuth.authenticateJada(req);
    if (!id) throw Object.assign(new Error('Sign in as JADA staff to continue.'), { statusCode: 401 });
    return id.userId;
  };
  app.get('/api/jada/discoveries', async (req) => ({ discoveries: await deps.jada.assignedDiscoveries(await jadaUser(req)) }));
  app.get('/api/jada/queue', async (req) => ({ queue: await deps.jada.queue(await jadaUser(req)) }));
  app.post<P>('/api/jada/discoveries/:id/pick-up', async (req) => { await deps.jada.pickUp(await jadaUser(req), req.params.id); return { ok: true }; });
  app.get<P>('/api/jada/discoveries/:id', async (req) => deps.jada.discovery(await jadaUser(req), req.params.id));
  app.get<P>('/api/jada/packs/:id/markdown', async (req, reply) =>
    reply.type('text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="implementation-pack-${req.params.id.slice(0, 8)}.md"`)
      .send(await deps.jada.packMarkdown(await jadaUser(req), req.params.id)));
  app.post<P>('/api/jada/packs/:id/reviews', async (req) => deps.jada.review(await jadaUser(req), req.params.id, req.body));
  app.post<P & { Body: { note?: string } }>('/api/jada/escalations/:id/resolve', async (req) => {
    await deps.jada.resolveEscalation(await jadaUser(req), req.params.id, String((req.body as any)?.note ?? ''));
    return { ok: true };
  });

  // ---------- knowledge base (milestone 8) ----------
  if (deps.knowledge) {
    const kn = deps.knowledge;
    type K = { Params: { id: string } };
    app.get('/api/knowledge', async (req) => kn.overview(await jadaUser(req)));
    app.get<K>('/api/knowledge/items/:id', async (req) => kn.item(await jadaUser(req), req.params.id));
    app.post('/api/knowledge/drafts', async (req) => kn.saveDraft(await jadaUser(req), req.body));
    app.post<K>('/api/knowledge/items/:id/submit', async (req) => kn.submit(await jadaUser(req), req.params.id));
    app.post<K>('/api/knowledge/items/:id/review', async (req) => kn.review(await jadaUser(req), req.params.id, req.body));
    app.get('/api/knowledge/release-preview', async (req) => {
      const { playbook, errors } = await kn.preview(await jadaUser(req));
      return { problems: errors, counts: { cards: playbook.cards.length, checks: playbook.checks?.length ?? 0, sources: playbook.sources?.length ?? 0 } };
    });
    app.post<{ Body: { notes?: string } }>('/api/knowledge/releases', async (req) => kn.publish(await jadaUser(req), String((req.body as any)?.notes ?? '')));
    app.get('/api/knowledge/candidates', async (req) => ({ candidates: await kn.candidates(await jadaUser(req)) }));
    app.post('/api/knowledge/import-seed', async (req) => ({ imported: await kn.importSeedDrafts(await jadaUser(req)) }));
  }

  // ---------- push-button sign-in (demo mode only) ----------
  app.get('/signout', async (_req, reply) => {
    for (const c of ['bp_dev', 'bp_jada']) reply.clearCookie(c, { path: '/' });
    return reply.redirect('/', 303);
  });
  if (deps.firmAuth instanceof DevCookieAuth && deps.signin) {
    const dev = deps.firmAuth, si = deps.signin;
    const signInAs = (reply: FastifyReply, e: { userId: string; kind: string; orgId: string | null; roles: string[] }) => {
      for (const c of ['bp_dev', 'bp_jada']) reply.clearCookie(c, { path: '/' });
      if (e.kind === 'firm_lead' && e.orgId) { reply.setCookie('bp_dev', dev.cookieFor({ userId: e.userId, orgId: e.orgId }), cookieOpts); return '/firm'; }
      reply.setCookie('bp_jada', dev.jadaCookieFor(e.userId), cookieOpts);
      return e.roles.includes('engineer') ? '/jada' : '/knowledge';
    };
    app.get('/api/signin/directory', async () => ({ accounts: await si.directory() }));
    app.post<{ Body: { userId?: string } }>('/api/signin', async (req, reply) => {
      const e = await si.find(String(req.body?.userId ?? ''));
      if (!e) throw Object.assign(new Error('That account no longer exists.'), { statusCode: 404 });
      return { next: signInAs(reply, e) };
    });
    app.post('/api/signin/new-firm', async (req, reply) => ({ next: signInAs(reply, await si.newFirm(req.body)) }));
    app.get('/api/whoami', async (req) => {
      const f = await deps.firmAuth.authenticate(req);
      const j = await deps.jadaAuth.authenticateJada(req);
      const e = await si.find((f ?? j)?.userId ?? '');
      return e ? { name: e.name, kind: e.kind, orgName: e.orgName, roles: e.roles } : { name: null };
    });
  }

  // ---------- development login ----------
  if (deps.firmAuth instanceof DevCookieAuth) {
    const dev = deps.firmAuth;
    app.get<{ Querystring: { userId: string; orgId: string; next?: string } }>('/dev/login', async (req, reply) => {
      reply.setCookie('bp_dev', dev.cookieFor({ userId: req.query.userId, orgId: req.query.orgId }), cookieOpts);
      const next = req.query.next?.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/';
      return reply.redirect(next, 303);
    });
    app.get<{ Querystring: { userId: string; next?: string } }>('/dev/jada-login', async (req, reply) => {
      reply.setCookie('bp_jada', dev.jadaCookieFor(req.query.userId), cookieOpts);
      const next = req.query.next?.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/jada';
      return reply.redirect(next, 303);
    });
  }
  return app;
}

export type App = ReturnType<typeof buildApp>;
export type { FastifyReply };
