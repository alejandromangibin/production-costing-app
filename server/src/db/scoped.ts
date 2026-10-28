import type { Db, Queryable } from './index';

/**
 * A database handle that can only see one business's data.
 *
 * Every statement runs inside a transaction that first drops to the low-privilege role
 * `costing_app` and records which business is logged in. PostgreSQL's row-level security
 * policies then hide every other business's rows, no matter what SQL runs.
 *
 * Use this for everything a logged-in business does. The plain `Db` is for account work
 * (logging in, the admin screens) that has to look across businesses.
 */
export function scopedDb(base: Db, tenantId: number): Db {
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) throw new Error('scopedDb needs a valid business id');

  const enter = async (q: Queryable) => {
    await q.exec('SET LOCAL ROLE costing_app');
    await q.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
  };

  return {
    kind: base.kind,
    query: (text, params) =>
      base.tx(async (q) => {
        await enter(q);
        return q.query(text, params);
      }),
    exec: (text) =>
      base.tx(async (q) => {
        await enter(q);
        await q.exec(text);
      }),
    tx: (fn) =>
      base.tx(async (q) => {
        await enter(q);
        return fn(q);
      }),
    close: async () => {
      /* the base handle owns the connection */
    },
  };
}

/** Tables that hold a business's data and are protected by row-level security. */
export const TENANT_TABLES = [
  'products',
  'pack_sizes',
  'runs',
  'run_products',
  'run_packings',
  'run_costs',
  'run_cost_targets',
] as const;

/**
 * Refuse to start if the isolation is not really in force. Better a loud stop than a quiet leak.
 * Checks that the role exists and works, that every data table has row-level security on, and that
 * a scoped handle with no matching business sees nothing.
 */
export async function assertIsolation(db: Db): Promise<void> {
  const flags = await db.query<{ relname: string; relrowsecurity: boolean }>(
    'SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = $2',
    [[...TENANT_TABLES], 'r'],
  );
  const missing = TENANT_TABLES.filter((t) => !flags.rows.some((r) => r.relname === t && r.relrowsecurity));
  if (missing.length) {
    throw new Error(`Row-level security is not switched on for: ${missing.join(', ')}. Refusing to start.`);
  }
  try {
    await scopedDb(db, 2_000_000_000).query('SELECT count(*)::int AS n FROM products');
    const leak = await scopedDb(db, 2_000_000_000).query<{ n: number }>('SELECT count(*)::int AS n FROM products');
    if (leak.rows[0]!.n !== 0) throw new Error('A business that does not exist can see products.');
    const account = await db
      .tx(async (q) => {
        await q.exec('SET LOCAL ROLE costing_app');
        await q.query('SELECT 1 FROM users LIMIT 1');
      })
      .then(
        () => true,
        () => false,
      );
    if (account) throw new Error('The app role can read the users table.');
  } catch (err: any) {
    throw new Error(
      `Business data separation check failed: ${err.message}\n` +
        'The database user needs permission to create the role "costing_app" and to SET ROLE to it. Refusing to start.',
    );
  }
}
