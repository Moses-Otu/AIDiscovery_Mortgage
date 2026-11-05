// One-time demo setup: creates the JADA team accounts used by push-button sign-in.
// Run as a database administrator, because granting roles is deliberately not possible from the app:
//   DATABASE_ADMIN_URL=postgres://admin@localhost/builda npm run setup-demo
import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Set DATABASE_ADMIN_URL to an administrator connection');
const db = new pg.Pool({ connectionString: url });
const TEAM: [string, string[]][] = [
  ['Jo', ['engineer']],
  ['Kim', ['knowledge_editor']],
  ['Ravi', ['compliance_reviewer']],
  ['Sam', ['compliance_reviewer']],
];
for (const [name, roles] of TEAM) {
  const existing = await db.query("select id from app_users where display_name = $1 and kind = 'jada'", [name]);
  const id = existing.rows[0]?.id ?? randomUUID();
  if (!existing.rows[0]) await db.query("insert into app_users (id, display_name, kind) values ($1, $2, 'jada')", [id, name]);
  for (const r of roles) await db.query('insert into jada_staff_roles (user_id, role) values ($1, $2) on conflict do nothing', [id, r]);
  console.log(`${existing.rows[0] ? 'exists ' : 'created'}  ${name}`);
}
await db.end();
console.log('\nDone. Start the app and open the sign-in page.');
