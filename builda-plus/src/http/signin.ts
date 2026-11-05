import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/pool';
import type { FirmService } from '../firm/service';

// Push-button sign-in for demos. There are no passwords: anyone who can reach the site can use any
// account, so the app only enables this outside production (see DevCookieAuth).
export interface DirectoryEntry { userId: string; name: string; kind: 'firm_lead' | 'jada'; orgId: string | null; orgName: string | null; roles: string[] }

export const NewFirmSchema = z.object({ firmName: z.string().trim().min(2).max(160), yourName: z.string().trim().min(1).max(120) });

export class SigninService {
  constructor(private db: Db, private firms: FirmService) {}

  async directory(): Promise<DirectoryEntry[]> {
    const r = await this.db.query('select * from signin_directory()');
    return r.rows.map((x) => ({ userId: x.user_id, name: x.display_name, kind: x.kind, orgId: x.org_id, orgName: x.org_name, roles: x.roles }));
  }

  async find(userId: string): Promise<DirectoryEntry | null> {
    return (await this.directory()).find((d) => d.userId === userId) ?? null;
  }

  async newFirm(input: unknown): Promise<DirectoryEntry> {
    const f = NewFirmSchema.parse(input);
    const orgId = randomUUID(), userId = randomUUID();
    await this.firms.createFirm({ orgId, name: f.firmName, leadUserId: userId, leadName: f.yourName });
    return { userId, name: f.yourName, kind: 'firm_lead', orgId, orgName: f.firmName, roles: [] };
  }
}
