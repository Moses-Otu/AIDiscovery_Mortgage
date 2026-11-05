import { z } from 'zod';
import { withFirmContext, type Db, type FirmContext } from '../db/pool';
import { insertAudit, NotFoundError } from '../db/repositories';
import { RoleSchema } from '../domain/schemas';
import { ROLE_LABELS, type Role } from '../domain/journey';
import { FirmProfileSchema, type FirmProfile } from './profile';
import type { Mailer } from './mailer';
import { hashToken, newInvitationToken } from '../http/tokens';
import { CONSENT_VERSION } from '../participant/consent';
import { DEFAULT_SCORING_CONFIG } from '../engine/scoring';

export const InviteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // Optional: links are shared by hand for now, so an email address isn't needed.
  email: z.union([z.string().trim().email().max(320), z.literal('')]).optional().transform((v) => v || undefined),
  role: RoleSchema,
});
export type Invite = z.infer<typeof InviteSchema>;

export class ConsentVersionError extends Error {}

export type ParticipantProgress = 'invited' | 'opened' | 'consented' | 'in_progress' | 'paused' | 'completed' | 'escalated';

export interface FirmServiceConfig { appBaseUrl: string; invitationDays: number; playbookVersion: string; currentPlaybookVersion?: () => Promise<string> }

export class FirmService {
  constructor(private db: Db, private mailer: Mailer | null, private cfg: FirmServiceConfig) {}

  // Organisation onboarding. In production this is called by whatever creates firm accounts
  // (Builda's organisation management); here it's also used by tests and the dev seed.
  async createFirm(p: { orgId: string; name: string; leadUserId: string; leadName?: string }): Promise<void> {
    await withFirmContext(this.db, { orgId: p.orgId, userId: p.leadUserId }, async (tx) => {
      await tx.query("insert into app_users (id, display_name, kind) values ($1, $2, 'firm_lead')", [p.leadUserId, (p.leadName ?? 'Firm lead').slice(0, 120)]);
      await tx.query('insert into organisations (id, name) values ($1, $2)', [p.orgId, p.name]);
      await tx.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'firm_lead')", [p.orgId, p.leadUserId]);
      await insertAudit(tx, [{ orgId: p.orgId, discoveryId: null, actor: `user:${p.leadUserId}`, action: 'firm.created' }]);
    });
  }

  async isFirmLead(ctx: FirmContext & { userId: string }): Promise<boolean> {
    return withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query("select 1 from org_members where org_id = $1 and user_id = $2 and role = 'firm_lead'", [ctx.orgId, ctx.userId]);
      return r.rowCount === 1;
    });
  }

  async createDiscovery(ctx: FirmContext & { userId: string }): Promise<string> {
    // Each discovery pins the knowledge release it starts with.
    const playbookVersion = this.cfg.currentPlaybookVersion ? await this.cfg.currentPlaybookVersion() : this.cfg.playbookVersion;
    return withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query(
        `insert into discoveries (org_id, status, playbook_version, scoring_config_version, created_by)
         values ($1, 'profile', $2, $3, $4) returning id`,
        [ctx.orgId, playbookVersion, DEFAULT_SCORING_CONFIG.version, ctx.userId]);
      const id = r.rows[0].id as string;
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId: id, actor: `user:${ctx.userId}`, action: 'discovery.created', entityType: 'discovery', entityId: id, metadata: { playbookVersion } }]);
      return id;
    });
  }

  async saveProfile(ctx: FirmContext & { userId: string }, discoveryId: string, input: unknown): Promise<FirmProfile> {
    const profile = FirmProfileSchema.parse(input);
    return withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query(
        `update discoveries set firm_profile = $1, status = case when status = 'profile' then 'interviews' else status end
          where id = $2 returning id`, [profile, discoveryId]);
      if (r.rowCount === 0) throw new NotFoundError('Discovery not found');
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: `user:${ctx.userId}`, action: 'discovery.profile_saved', entityType: 'discovery', entityId: discoveryId }]);
      return profile;
    });
  }

  async getProfile(ctx: FirmContext, discoveryId: string): Promise<FirmProfile | null> {
    return withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query('select firm_profile from discoveries where id = $1', [discoveryId]);
      if (!r.rows[0]) throw new NotFoundError('Discovery not found');
      const parsed = FirmProfileSchema.safeParse(r.rows[0].firm_profile);
      return parsed.success ? parsed.data : null;
    });
  }

  async inviteParticipant(ctx: FirmContext & { userId: string }, discoveryId: string, input: unknown): Promise<{ participantId: string; pseudonym: string; link: string }> {
    const invite = InviteSchema.parse(input);
    const token = newInvitationToken();
    const { participantId, pseudonym, firmName } = await withFirmContext(this.db, ctx, async (tx) => {
      const d = await tx.query('select o.name from discoveries d join organisations o on o.id = d.org_id where d.id = $1', [discoveryId]);
      if (!d.rows[0]) throw new NotFoundError('Discovery not found');
      // Lock the discovery row so concurrent invites can't take the same pseudonym.
      await tx.query('select id from discoveries where id = $1 for update', [discoveryId]);
      const n = await tx.query('select count(*)::int as n from participants where discovery_id = $1', [discoveryId]);
      const pseudonym = `P${n.rows[0].n + 1}`;
      const p = await tx.query(
        `insert into participants (org_id, discovery_id, display_name, email, pseudonym, role, invited_at)
         values ($1, $2, $3, $4, $5, $6, now()) returning id`,
        [ctx.orgId, discoveryId, invite.name, invite.email?.toLowerCase() ?? null, pseudonym, invite.role]);
      const participantId = p.rows[0].id as string;
      await tx.query(
        `insert into invitations (org_id, discovery_id, participant_id, token_hash, expires_at)
         values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
        [ctx.orgId, discoveryId, participantId, hashToken(token), this.cfg.invitationDays]);
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: `user:${ctx.userId}`, action: 'participant.invited',
        entityType: 'participant', entityId: participantId, metadata: { role: invite.role, pseudonym } }]);
      return { participantId, pseudonym, firmName: d.rows[0].name as string };
    });

    const link = `${this.cfg.appBaseUrl}/i/${token}`;
    if (this.mailer && invite.email) {
      await this.mailer.send({ to: invite.email, subject: `${firmName}: help us improve how we work (20–30 minutes)`,
        text: invitationEmail(invite.name, firmName, invite.role, link, this.cfg.invitationDays) });
    }
    // Returned once to the firm lead to share by hand. Only a hash is stored, so it can't be shown again.
    return { participantId, pseudonym, link };
  }

  // Replaces a person's link: the old one stops working immediately.
  async newLink(ctx: FirmContext & { userId: string }, discoveryId: string, participantId: string): Promise<{ link: string }> {
    const token = newInvitationToken();
    await withFirmContext(this.db, ctx, async (tx) => {
      const p = await tx.query('select pseudonym from participants where id = $1 and discovery_id = $2', [participantId, discoveryId]);
      if (!p.rows[0]) throw new NotFoundError('Person not found');
      await tx.query('update invitations set expires_at = now() where participant_id = $1 and expires_at > now()', [participantId]);
      await tx.query(`insert into invitations (org_id, discovery_id, participant_id, token_hash, expires_at)
                      values ($1, $2, $3, $4, now() + make_interval(days => $5))`, [ctx.orgId, discoveryId, participantId, hashToken(token), this.cfg.invitationDays]);
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId, actor: `user:${ctx.userId}`, action: 'participant.link_replaced', entityType: 'participant', entityId: participantId }]);
    });
    return { link: `${this.cfg.appBaseUrl}/i/${token}` };
  }

  async listDiscoveries(ctx: FirmContext) {
    return withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query(
        `select d.id, d.status, d.created_at, (d.firm_profile <> '{}'::jsonb) as has_profile,
                (select count(*)::int from participants p where p.discovery_id = d.id) as people,
                (select count(*)::int from interview_sessions s where s.discovery_id = d.id and s.kind = 'main' and s.status = 'completed') as completed
           from discoveries d order by d.created_at desc`);
      return r.rows.map((x) => ({ id: x.id, status: x.status, createdAt: x.created_at, hasProfile: x.has_profile, people: x.people, completed: x.completed }));
    });
  }

  // Firm lead's view of who has taken part. Status only — never interview content.
  async progress(ctx: FirmContext, discoveryId: string): Promise<{ participantId: string; name: string; role: Role; status: ParticipantProgress }[]> {
    return withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query(
        `select p.id, p.display_name, p.role, p.consented_at, i.first_used_at,
                (select s.status from interview_sessions s where s.participant_id = p.id and s.kind = 'main'
                  order by s.started_at desc limit 1) as session_status
           from participants p left join invitations i on i.participant_id = p.id
          where p.discovery_id = $1 order by p.invited_at`, [discoveryId]);
      return r.rows.map((row) => ({
        participantId: row.id, name: row.display_name, role: row.role,
        status: (row.session_status ?? (row.consented_at ? 'consented' : row.first_used_at ? 'opened' : 'invited')) as ParticipantProgress,
      }));
    });
  }
}

function invitationEmail(name: string, firm: string, role: Role, link: string, days: number): string {
  return `Hi ${name},

${firm} is reviewing how work moves through the business, to find what slows things down and what could be made easier. As a ${ROLE_LABELS[role].toLowerCase()}, your view of the day-to-day work is important.

It's a 20–30 minute conversation with an AI interviewer about the tasks you do, how often they happen and how long they take. It is not an assessment of you. Your firm sees findings grouped by role, not by name, and your name is never sent to the AI.

Please don't include client names or case details in your answers.

Start (or carry on later) here: ${link}
The link works for ${days} days. Please don't forward it.`;
}

// Participant-side: resolve an invitation link and record consent.
export class ParticipantAccessService {
  constructor(private db: Db) {}

  async resolveInvitation(token: string): Promise<{ orgId: string; discoveryId: string; participantId: string } | null> {
    const client = await this.db.connect();
    try {
      await client.query('begin');
      // Read access by token hash only; the write happens in the firm's own context.
      await client.query("select set_config('app.invitation_hash', $1, true)", [hashToken(token)]);
      const r = await client.query(
        'select id, org_id, discovery_id, participant_id from invitations where token_hash = $1 and expires_at > now()', [hashToken(token)]);
      const row = r.rows[0];
      if (row) {
        await client.query("select set_config('app.invitation_hash', '', true), set_config('app.current_org_id', $1, true)", [row.org_id]);
        await client.query('update invitations set first_used_at = coalesce(first_used_at, now()) where id = $1', [row.id]);
      }
      await client.query('commit');
      return row ? { orgId: row.org_id, discoveryId: row.discovery_id, participantId: row.participant_id } : null;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  async participantContext(ctx: FirmContext, participantId: string) {
    return withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query(
        `select p.role, p.consented_at, o.name as firm_name from participants p join organisations o on o.id = p.org_id where p.id = $1`, [participantId]);
      if (!r.rows[0]) throw new NotFoundError('Participant not found');
      return { role: r.rows[0].role as Role, consented: !!r.rows[0].consented_at, firmName: r.rows[0].firm_name as string };
    });
  }

  async recordConsent(ctx: FirmContext, participantId: string, version: string): Promise<void> {
    if (version !== CONSENT_VERSION) throw new ConsentVersionError('Consent text has changed; please reload and review it again');
    await withFirmContext(this.db, ctx, async (tx) => {
      const r = await tx.query(
        'update participants set consent_version = $1, consented_at = coalesce(consented_at, now()) where id = $2 returning discovery_id, pseudonym',
        [version, participantId]);
      if (!r.rows[0]) throw new NotFoundError('Participant not found');
      await insertAudit(tx, [{ orgId: ctx.orgId, discoveryId: r.rows[0].discovery_id, actor: `participant:${r.rows[0].pseudonym}`,
        action: 'participant.consented', entityType: 'participant', entityId: participantId, metadata: { version } }]);
    });
  }
}
