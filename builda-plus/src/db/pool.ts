import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url, max: 10 });
}

export interface FirmContext { orgId: string; userId?: string }

// Every query runs inside a transaction scoped to one firm. Row-level security in the
// database uses these settings, so a bug in application code still can't cross firms.
export async function withFirmContext<T>(db: Db, ctx: FirmContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.current_org_id', $1, true), set_config('app.current_user_id', $2, true)",
      [ctx.orgId, ctx.userId ?? ''],
    );
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// JADA staff: no firm context. Row-level security lets them see only discoveries assigned to them.
export async function withJadaContext<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.current_org_id', '', true), set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
