import 'dotenv/config';
import { createPool } from './db/pool';
import { buildApp } from './http/app';
import { DevCookieAuth } from './http/auth';
import { InterviewService } from './interview/service';
import { FirmService, ParticipantAccessService } from './firm/service';
import { AnalysisService } from './analysis/service';
import { OpenAIProvider } from './llm/openai';
import { BudgetedProvider } from './llm/budget';
import { PgUsageLedger } from './db/usageLedger';
import { SEED_PLAYBOOK } from './knowledge/playbook';
import { assertConsentConfigReady } from './participant/consent';
import { DecisionService, JadaService } from './implementation/service';
import { KnowledgeService } from './knowledge/service';
import { SigninService } from './http/signin';

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};

const sessionSecret = env('SESSION_SECRET');
if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
const appBaseUrl = env('APP_BASE_URL', 'http://localhost:3000');
const consent = {
  retentionMonths: process.env.RETENTION_MONTHS ? Number(process.env.RETENTION_MONTHS) : null,
  jadaContact: process.env.JADA_CONTACT ?? null,
};
assertConsentConfigReady({ ...consent, firmName: '' });

const db = createPool();
// No email for now: the firm lead copies each person's link and shares it themselves.
const mailer = null;
const model = new OpenAIProvider();
const maxTokens = Number(env('MAX_TOKENS_PER_DISCOVERY', '300000'));
const providerFor = ({ orgId, discoveryId }: { orgId: string; discoveryId: string }) =>
  new BudgetedProvider(model, new PgUsageLedger(db, orgId), { discoveryId, maxTokensPerDiscovery: maxTokens });

// Unreviewed seed cards are allowed only outside production, and are labelled wherever they're used.
const knowledge = new KnowledgeService(db, { allowUnreviewedSeed: process.env.NODE_ENV !== 'production' });
const playbookFor = knowledge.forDiscovery;
const firms = new FirmService(db, mailer, { appBaseUrl, invitationDays: 30, playbookVersion: SEED_PLAYBOOK.version, currentPlaybookVersion: () => knowledge.currentVersion() });
const analysis = new AnalysisService(db, { providerFor, playbook: SEED_PLAYBOOK, playbookFor, mailer, appBaseUrl });
const devAuth = new DevCookieAuth(sessionSecret); // replace with Builda's auth and JADA's SSO adapters
const app = buildApp({
  db, firms, analysis,
  interviews: new InterviewService(db, { providerFor, playbook: SEED_PLAYBOOK, playbookFor }),
  knowledge,
  signin: new SigninService(db, firms),
  participants: new ParticipantAccessService(db),
  decisions: new DecisionService(db, { analysis, firms, playbook: SEED_PLAYBOOK }),
  jada: new JadaService(db),
  firmAuth: devAuth,
  jadaAuth: devAuth,
  sessionSecret,
  consent,
  secureCookies: appBaseUrl.startsWith('https://'),
});

const port = Number(env('PORT', '3000'));
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`builda+ listening on ${appBaseUrl}`));
