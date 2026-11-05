// Creates a demo firm, discovery and three invitations, and prints the links.
//   DATABASE_URL=... SESSION_SECRET=... npm run seed
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db/pool';
import { FirmService } from '../src/firm/service';
import { SEED_PLAYBOOK } from '../src/knowledge/playbook';

const db = createPool();
const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const firms = new FirmService(db, null, { appBaseUrl, invitationDays: 30, playbookVersion: SEED_PLAYBOOK.version });

const orgId = randomUUID(), userId = randomUUID();
await firms.createFirm({ orgId, name: 'Demo Mortgage Partners', leadUserId: userId, leadName: 'Demo Lead' });
const lead = { orgId, userId };
const discoveryId = await firms.createDiscovery(lead);
await firms.saveProfile(lead, discoveryId, {
  advisers: 14, monthlyApplications: 150, typicalWeeksEnquiryToOffer: 6, businessStructure: 'Single office, advisers supported by a case management team',
  staffRoles: [{ role: 'adviser', count: 14 }, { role: 'case_manager', count: 4 }, { role: 'administrator', count: 2 }],
  systems: ['CRM', 'Sourcing system', 'Lender portals', 'Email'], authorisation: 'network_appointed_representative',
  operationalChallenges: 'Applications stall waiting for documents', loadedHourlyCostGBP: 22,
});
console.log('\nInterview links (open each in a separate private window):');
for (const p of [
  { name: 'Demo Lead', role: 'firm_lead' },
  { name: 'Demo Case Manager', role: 'case_manager' },
  { name: 'Demo Adviser', role: 'adviser' },
]) console.log(`  ${p.name.padEnd(18)} ${(await firms.inviteParticipant(lead, discoveryId, p)).link}`);
console.log(`\nThen sign in as “Demo Mortgage Partners” at ${appBaseUrl}/\n`);
await db.end();
