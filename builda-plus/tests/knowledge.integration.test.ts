import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { KnowledgeService, KnowledgeForbiddenError, ReleaseBlockedError, NoApprovedReleaseError } from '../src/knowledge/service';
import { FirmService } from '../src/firm/service';
import { InterviewService } from '../src/interview/service';
import { DevOutboxMailer } from '../src/firm/mailer';
import { ScriptedProvider } from '../src/llm/mock';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';
import { REGULATED_STAGES } from '../src/knowledge/model';
import { CONSENT_VERSION } from '../src/participant/consent';
import { ParticipantAccessService } from '../src/firm/service';

const APP = process.env.TEST_DATABASE_URL, ADMIN = process.env.TEST_ADMIN_DATABASE_URL;

describe.skipIf(!APP || !ADMIN)('knowledge base workflow (Postgres)', () => {
  const db = new pg.Pool({ connectionString: APP });
  const admin = new pg.Pool({ connectionString: ADMIN });
  const prod = new KnowledgeService(db, { allowUnreviewedSeed: false });
  const kb = new KnowledgeService(db, { allowUnreviewedSeed: true });
  const editor = randomUUID(), reviewer = randomUUID(), reviewer2 = randomUUID(), outsider = randomUUID();
  const { id: _i, lastReviewed: _l, ...seedCard } = SEED_PLAYBOOK.cards[0]!;

  beforeAll(async () => {
    await admin.query('truncate knowledge_items, knowledge_releases, jada_staff_roles');
    await admin.query('truncate organisations cascade');
    await admin.query(`insert into jada_staff_roles values ($1,'knowledge_editor'), ($2,'compliance_reviewer'), ($3,'compliance_reviewer'), ($3,'knowledge_editor')`, [editor, reviewer, reviewer2]);
  });
  afterAll(async () => { await db.end(); await admin.end(); });

  const approve = async (kind: string, key: string, content: any, author = editor, by = reviewer) => {
    const d = await kb.saveDraft(author, { kind, key, content });
    await kb.submit(author, d.id);
    return kb.review(by, d.id, { decision: 'approve', note: 'Checked against source' });
  };

  it('production refuses to start discoveries before an approved release exists', async () => {
    await expect(prod.currentVersion()).rejects.toBeInstanceOf(NoApprovedReleaseError);
    expect(await kb.currentVersion()).toBe(SEED_PLAYBOOK.version); // development only
  });

  it('only knowledge staff can author; content is validated', async () => {
    await expect(kb.overview(outsider)).rejects.toBeInstanceOf(KnowledgeForbiddenError);
    await expect(kb.saveDraft(editor, { kind: 'card', key: 'document_chasing', content: { title: 'x' } })).rejects.toThrow();
    await expect(kb.saveDraft(editor, { kind: 'card', key: 'Bad Key!', content: seedCard })).rejects.toThrow(/lower-case/);
  });

  it('four eyes: editors cannot approve, authors cannot approve their own work, rejections need a reason', async () => {
    const d = await kb.saveDraft(reviewer2, { kind: 'card', key: 'document_chasing', content: { ...seedCard, owner: 'Mortgage ops lead', sourceRefs: [] } });
    await expect(kb.submit(editor, d.id)).rejects.toBeInstanceOf(KnowledgeForbiddenError);   // only the author submits
    await kb.submit(reviewer2, d.id);
    await expect(kb.saveDraft(reviewer2, { kind: 'card', key: 'document_chasing', content: seedCard })).rejects.toThrow(/waiting for review/);
    await expect(kb.review(editor, d.id, { decision: 'approve' })).rejects.toBeInstanceOf(KnowledgeForbiddenError);
    await expect(kb.review(reviewer2, d.id, { decision: 'approve' })).rejects.toBeInstanceOf(KnowledgeForbiddenError);
    await expect(kb.review(reviewer, d.id, { decision: 'reject', note: '' })).rejects.toThrow(/Say what needs to change/);
    const ok = await kb.review(reviewer, d.id, { decision: 'approve', note: 'Matches our process' });
    expect(ok.status).toBe('approved');
    // The database enforces four eyes too, even if application code were bypassed.
    const sneaky = await db.query('update knowledge_items set reviewed_by = author_id where id = $1', [d.id]).catch((e) => e);
    expect(sneaky.message).toMatch(/check constraint/);
  });

  it('a new version shows reviewers what changed', async () => {
    const v2 = await kb.saveDraft(editor, { kind: 'card', key: 'document_chasing', content: { ...seedCard, owner: 'Mortgage ops lead', title: 'Chasing outstanding documents', sourceRefs: [] } });
    expect(v2.version).toBe(2);
    const view = await kb.item(reviewer, v2.id);
    expect(view.changes).toEqual([{ field: 'title', before: seedCard.title, after: 'Chasing outstanding documents' }]);
    expect(view.history.map((h) => h.version)).toEqual([2, 1]);
  });

  it('publishing is blocked until every regulated stage has an approved, cited check', async () => {
    await expect(kb.publish(editor, '')).rejects.toBeInstanceOf(ReleaseBlockedError);
    const err = await kb.publish(editor, '').catch((e) => e);
    expect(err.problems).toHaveLength(REGULATED_STAGES.length);
    await expect(kb.publish(reviewer, '')).rejects.toBeInstanceOf(KnowledgeForbiddenError); // reviewers don't publish

    await approve('source', 'fca-mcob', { title: 'FCA Handbook: MCOB', reference: 'https://www.handbook.fca.org.uk/handbook/MCOB', publisher: 'FCA', updatedOn: '2025-06-01', sections: ['MCOB 4.7A'], summary: 'Advised sales rules', owner: 'Compliance lead' });
    await approve('check', 'advice_stays_human', { title: 'Advice decisions stay with the adviser', statement: 'Suitability and advice decisions are made by a qualified adviser.',
      appliesToStages: REGULATED_STAGES, appliesTo: 'any_change', requiredAction: 'Compliance review before any change', owner: 'Compliance lead', sourceRefs: [{ sourceKey: 'fca-mcob', section: 'MCOB 4.7A' }] });
    const { version } = await kb.publish(editor, 'First reviewed release');
    expect(version).toMatch(/^\d{4}\.\d{2}\.1$/);
    const rel = await kb.forVersion(version);
    expect(rel.reviewed).toBe(true);
    expect(rel.cards[0]!.owner).toBe('Mortgage ops lead');     // v1 approved; v2 is still a draft
    expect((await db.query('update knowledge_releases set notes = $1', ['x']).catch((e) => e)).message).toMatch(/permission denied/);
    expect(await prod.currentVersion()).toBe(version);
  });

  it('new discoveries pin the release, and interviews use its cards', async () => {
    const version = await prod.currentVersion();
    const mailer = new DevOutboxMailer();
    const firms = new FirmService(db, mailer, { appBaseUrl: 'http://t', invitationDays: 30, playbookVersion: 'unused', currentPlaybookVersion: () => prod.currentVersion() });
    const orgId = randomUUID(), userId = randomUUID();
    await firms.createFirm({ orgId, name: 'Pinned Ltd', leadUserId: userId });
    const did = await firms.createDiscovery({ orgId, userId });
    expect((await admin.query('select playbook_version from discoveries where id = $1', [did])).rows[0].playbook_version).toBe(version);

    const { participantId } = await firms.inviteParticipant({ orgId, userId }, did, { name: 'X', email: 'x@p.test', role: 'case_manager' });
    await new ParticipantAccessService(db).recordConsent({ orgId }, participantId, CONSENT_VERSION);
    const llm = new ScriptedProvider({ 'interview.interpret': [{ evidence: [], stagesConfirmedNotInvolved: [], flags: { clientInformation: false, complaintOrCompliance: false, employmentIssue: false, adviceRequest: false, outOfScope: false }, wantsToPause: false, answerWasVague: true }],
      'interview.next_question': [{ question: 'Which stages do you work on?' }] });
    const interviews = new InterviewService(db, { providerFor: () => llm, playbook: { version: 'should-not-be-used', cards: [] }, playbookFor: prod.forDiscovery });
    await interviews.startOrResume({ orgId }, participantId);
    await interviews.submitForParticipant({ orgId }, participantId, 'Mostly documents');
    expect(llm.calls[0]!.system).toContain('document_chasing');   // card key from the pinned release
  });

  it('candidates: pain points raised by two or more firms, with no firm details', async () => {
    const mk = async (name: string, keys: string[]) => {
      const org = randomUUID();
      await admin.query('insert into organisations (id, name) values ($1,$2)', [org, name]);
      const d = (await admin.query(`insert into discoveries (org_id, playbook_version, scoring_config_version, created_by) values ($1,'x','x',gen_random_uuid()) returning id`, [org])).rows[0].id;
      for (const k of keys) await admin.query('insert into pain_points (org_id, discovery_id, key, stage_id, title) values ($1,$2,$3,$4,$5)', [org, d, k, 'enquiry', `Title for ${k}`]);
    };
    await mk('Alpha Mortgages', ['diary_juggling', 'document_chasing', 'only_alpha']);
    await mk('Beta Mortgages', ['diary_juggling']);
    const c = await kb.candidates(editor);
    expect(c).toEqual([{ key: 'diary_juggling', title: 'Title for diary_juggling', stageId: 'enquiry', firms: 2 }]);
    expect(JSON.stringify(c)).not.toMatch(/Alpha|Beta/);
    await expect(kb.candidates(outsider)).rejects.toBeInstanceOf(KnowledgeForbiddenError);
    expect((await db.query('select * from knowledge_candidates($1, $2)', [outsider, []])).rows).toEqual([]); // function checks the caller too
  });
});
