import { z } from 'zod';
import { withFirmContext, type Db, type FirmContext } from '../db/pool';
import { NotFoundError } from '../db/repositories';
import { SEED_PLAYBOOK, type Playbook } from './playbook';
import { CLASSIFICATIONS, ROLES, ROLE_LABELS, STAGE_IDS, STAGES } from '../domain/journey';
import { assembleRelease, CONTENT_SCHEMAS, diffContent, nextReleaseVersion, type KnowledgeKind } from './model';

export class KnowledgeForbiddenError extends Error {}
export class ReleaseBlockedError extends Error { constructor(public problems: string[]) { super('The release can’t be published yet.'); } }
export class NoApprovedReleaseError extends Error {}

const DraftSchema = z.object({
  kind: z.enum(['card', 'check', 'source']),
  key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,80}$/, 'Use lower-case letters, numbers, dots, dashes or underscores'),
  content: z.record(z.unknown()),
});
const ReviewSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(2000).default('') });

export interface KnowledgeRow {
  id: string; kind: KnowledgeKind; key: string; version: number; content: any; status: string;
  authorId: string; reviewedBy: string | null; reviewedAt: string | null; reviewNote: string | null; createdAt: string;
}
const toRow = (r: any): KnowledgeRow => ({
  id: r.id, kind: r.kind, key: r.key, version: r.version, content: r.content, status: r.status, authorId: r.author_id,
  reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at?.toISOString?.() ?? r.reviewed_at, reviewNote: r.review_note, createdAt: r.created_at?.toISOString?.() ?? r.created_at,
});

export class KnowledgeService {
  private cache = new Map<string, Playbook>();
  constructor(private db: Db, private opts: { allowUnreviewedSeed: boolean }) {}

  async roles(userId: string): Promise<Set<string>> {
    const r = await this.db.query('select role from jada_staff_roles where user_id = $1', [userId]);
    return new Set(r.rows.map((x) => x.role as string));
  }
  private async need(userId: string, any: string[]) {
    const roles = await this.roles(userId);
    if (!any.some((r) => roles.has(r))) throw new KnowledgeForbiddenError('You don’t have permission to do this.');
    return roles;
  }

  // ---------- authoring ----------
  async overview(userId: string) {
    const roles = await this.need(userId, ['knowledge_editor', 'compliance_reviewer']);
    const r = await this.db.query('select * from knowledge_items order by kind, key, version');
    const groups = new Map<string, KnowledgeRow[]>();
    r.rows.map(toRow).forEach((i) => groups.set(`${i.kind}:${i.key}`, [...(groups.get(`${i.kind}:${i.key}`) ?? []), i]));
    const items = [...groups.values()].map((vs) => {
      const latest = vs[vs.length - 1]!;
      const approved = [...vs].reverse().find((v) => v.status === 'approved') ?? null;
      return { kind: latest.kind, key: latest.key, title: latest.content.title ?? latest.key, latest: { id: latest.id, version: latest.version, status: latest.status, authorId: latest.authorId },
        approvedVersion: approved?.version ?? null, stageId: latest.content.stageId ?? null };
    });
    const releases = await this.db.query('select version, notes, created_at, cardinality(item_ids) as items from knowledge_releases order by created_at desc');
    const meta = {
      stages: STAGE_IDS.map((id) => ({ id, name: STAGES[id].name, regulated: STAGES[id].regulatedJudgement })),
      roles: ROLES.map((id) => ({ id, name: ROLE_LABELS[id] })), classifications: [...CLASSIFICATIONS],
    };
    return { userId, meta, roles: [...roles], items, releases: releases.rows.map((x) => ({ version: x.version, notes: x.notes, createdAt: x.created_at, items: x.items })) };
  }

  async item(userId: string, id: string) {
    await this.need(userId, ['knowledge_editor', 'compliance_reviewer']);
    const r = await this.db.query('select * from knowledge_items where id = $1', [id]);
    if (!r.rows[0]) throw new NotFoundError('Not found');
    const item = toRow(r.rows[0]);
    const prev = await this.db.query(`select content from knowledge_items where kind = $1 and key = $2 and status = 'approved' and version < $3 order by version desc limit 1`, [item.kind, item.key, item.version]);
    const history = await this.db.query('select id, version, status, author_id, reviewed_by, reviewed_at, review_note, created_at from knowledge_items where kind = $1 and key = $2 order by version desc', [item.kind, item.key]);
    return { item, changes: diffContent(prev.rows[0]?.content ?? null, item.content), history: history.rows.map(toRow) };
  }

  async saveDraft(userId: string, input: unknown): Promise<KnowledgeRow> {
    await this.need(userId, ['knowledge_editor', 'compliance_reviewer']);
    const d = DraftSchema.parse(input);
    const content = CONTENT_SCHEMAS[d.kind].parse(d.content);
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`${d.kind}:${d.key}`]);
      const latest = (await client.query('select * from knowledge_items where kind = $1 and key = $2 order by version desc limit 1', [d.kind, d.key])).rows[0];
      let row;
      if (latest && latest.status === 'draft' && latest.author_id === userId) {
        row = (await client.query('update knowledge_items set content = $1 where id = $2 returning *', [content, latest.id])).rows[0];
      } else if (latest && latest.status === 'in_review') {
        throw new KnowledgeForbiddenError('This item is waiting for review. Wait for the decision before editing it again.');
      } else if (latest && latest.status === 'draft') {
        throw new KnowledgeForbiddenError('Someone else has an unsubmitted draft of this item.');
      } else {
        row = (await client.query('insert into knowledge_items (kind, key, version, content, author_id) values ($1,$2,$3,$4,$5) returning *',
          [d.kind, d.key, (latest?.version ?? 0) + 1, content, userId])).rows[0];
      }
      await client.query('commit');
      return toRow(row);
    } catch (err) { await client.query('rollback').catch(() => {}); throw err; } finally { client.release(); }
  }

  async submit(userId: string, id: string) {
    await this.need(userId, ['knowledge_editor', 'compliance_reviewer']);
    const r = await this.db.query(`update knowledge_items set status = 'in_review' where id = $1 and status = 'draft' and author_id = $2 returning *`, [id, userId]);
    if (!r.rows[0]) throw new KnowledgeForbiddenError('Only the author can submit their own draft for review.');
    return toRow(r.rows[0]);
  }

  // Four eyes: a compliance reviewer who is not the author.
  async review(userId: string, id: string, input: unknown) {
    await this.need(userId, ['compliance_reviewer']);
    const d = ReviewSchema.parse(input);
    if (d.decision === 'reject' && !d.note) throw Object.assign(new Error('Say what needs to change when rejecting.'), { statusCode: 400 });
    const r = await this.db.query(
      `update knowledge_items set status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
        where id = $4 and status = 'in_review' and author_id <> $2 returning *`,
      [d.decision === 'approve' ? 'approved' : 'rejected', userId, d.note, id]);
    if (!r.rows[0]) throw new KnowledgeForbiddenError('Only items in review can be decided, and not by their author.');
    return toRow(r.rows[0]);
  }

  async importSeedDrafts(userId: string): Promise<number> {
    await this.need(userId, ['knowledge_editor']);
    const existing = await this.db.query("select 1 from knowledge_items where kind = 'card' limit 1");
    if (existing.rowCount) throw new KnowledgeForbiddenError('Cards already exist; the seed import is only for an empty playbook.');
    for (const c of SEED_PLAYBOOK.cards) {
      const { id, lastReviewed: _l, ...content } = c;
      await this.saveDraft(userId, { kind: 'card', key: id, content: { ...content, sourceRefs: [] } });
    }
    return SEED_PLAYBOOK.cards.length;
  }

  // ---------- releases ----------
  async preview(userId: string) {
    await this.need(userId, ['knowledge_editor', 'compliance_reviewer']);
    const items = await this.approvedItems();
    return assembleRelease('preview', items);
  }

  async publish(userId: string, notes: string): Promise<{ version: string }> {
    await this.need(userId, ['knowledge_editor']);
    const client = await this.db.connect();
    try {
      await client.query('begin');
      await client.query("select pg_advisory_xact_lock(hashtext('knowledge_release'))");
      const items = await this.approvedItems(client);
      const existing = (await client.query('select version from knowledge_releases')).rows.map((x) => x.version as string);
      const version = nextReleaseVersion(existing);
      const { playbook, errors } = assembleRelease(version, items);
      if (errors.length) throw new ReleaseBlockedError(errors);
      // Highest approved version of each item — the same set assembleRelease used.
      const ids = [...new Map([...items].sort((a, b) => a.version - b.version).map((i) => [`${i.kind}:${i.key}`, i.id])).values()];
      await client.query('insert into knowledge_releases (version, item_ids, snapshot, notes, published_by) values ($1,$2,$3,$4,$5)', [version, ids, playbook, notes.slice(0, 2000), userId]);
      await client.query('commit');
      return { version };
    } catch (err) { await client.query('rollback').catch(() => {}); throw err; } finally { client.release(); }
  }

  private async approvedItems(client: { query: Db['query'] } = this.db) {
    const r = await client.query("select id, kind, key, version, content, reviewed_at from knowledge_items where status = 'approved'");
    return r.rows.map((x: any) => ({ id: x.id, kind: x.kind, key: x.key, version: x.version, content: x.content, reviewedAt: x.reviewed_at.toISOString() }));
  }

  async candidates(userId: string) {
    await this.need(userId, ['knowledge_editor', 'compliance_reviewer']);
    const known = (await this.db.query("select distinct key from knowledge_items where kind = 'card'")).rows.map((x) => x.key);
    const r = await this.db.query('select * from knowledge_candidates($1, $2)', [userId, [...known, ...SEED_PLAYBOOK.cards.map((c) => c.id)]]);
    return r.rows.map((x) => ({ key: x.key, title: x.title, stageId: x.stage_id, firms: Number(x.firms) }));
  }

  // ---------- runtime ----------
  async currentVersion(): Promise<string> {
    const r = await this.db.query('select version from knowledge_releases order by created_at desc limit 1');
    if (r.rows[0]) return r.rows[0].version;
    if (this.opts.allowUnreviewedSeed) return SEED_PLAYBOOK.version;
    throw new NoApprovedReleaseError('No approved playbook release has been published yet, so discoveries can’t start.');
  }

  async forVersion(version: string): Promise<Playbook> {
    if (version === SEED_PLAYBOOK.version) {
      if (!this.opts.allowUnreviewedSeed) throw new NoApprovedReleaseError('This discovery uses the unreviewed development playbook.');
      return SEED_PLAYBOOK;
    }
    const hit = this.cache.get(version);
    if (hit) return hit;
    const r = await this.db.query('select snapshot from knowledge_releases where version = $1', [version]);
    if (!r.rows[0]) throw new NotFoundError(`Playbook release ${version} not found`);
    this.cache.set(version, r.rows[0].snapshot);   // releases are immutable, so caching is safe
    return r.rows[0].snapshot;
  }

  // The release a discovery pinned when it was created.
  forDiscovery = async (ctx: FirmContext, discoveryId: string): Promise<Playbook> => {
    const version = await withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query('select playbook_version from discoveries where id = $1', [discoveryId]);
      if (!r.rows[0]) throw new NotFoundError('Discovery not found');
      return r.rows[0].playbook_version as string;
    });
    return this.forVersion(version);
  };
}

export type PlaybookFor = (ctx: FirmContext, discoveryId: string) => Promise<Playbook>;
