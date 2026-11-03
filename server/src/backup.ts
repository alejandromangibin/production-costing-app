import type { Db } from './db/index';
import { TENANT_TABLES } from './db/scoped';
import { badRequest } from './errors';
import { backupFile } from './schemas';

/**
 * Two kinds of copy:
 *  - exportTenant: one business's own data, for that business to keep (read-only; see their rows only).
 *  - exportEverything / importEverything: the whole database, for you as the operator (command line only).
 *    On a hosted PostgreSQL, the host's automatic backups or pg_dump are the better tool; this also
 *    works for the built-in database.
 */

/** Tables in the order they can be filled (parents first). */
const ACCOUNT_TABLES = ['tenants', 'users', 'payments'] as const;
const ALL_TABLES = [...ACCOUNT_TABLES, ...TENANT_TABLES] as const;

/** Tables that have an auto-numbered id column. */
const WITH_ID = ALL_TABLES.filter((t) => t !== 'run_cost_targets');

export interface BackupFile {
  app: 'production-costing';
  version: 2;
  schema: string;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

async function schemaVersion(db: Db): Promise<string> {
  const r = await db.query<{ name: string }>('SELECT max(name) AS name FROM schema_migrations');
  return r.rows[0]?.name ?? 'none';
}

async function exportTables(db: Db, tables: readonly string[], schema: string): Promise<BackupFile> {
  const out: BackupFile['tables'] = {};
  for (const t of tables) {
    const order = t === 'run_cost_targets' ? 'run_cost_id, run_product_id' : 'id';
    const r = await db.query<{ row: Record<string, unknown> }>(`SELECT row_to_json(x) AS row FROM ${t} x ORDER BY ${order}`);
    out[t] = r.rows.map((x) => x.row);
  }
  return { app: 'production-costing', version: 2, schema, exportedAt: new Date().toISOString(), tables: out };
}

/**
 * A business's own data. Pass the business-scoped handle: it can only see that business's rows
 * (and cannot read the migrations table, so the version is just labelled as an export).
 */
export function exportTenant(tenantDb: Db): Promise<BackupFile> {
  return exportTables(tenantDb, TENANT_TABLES, 'business-export');
}

/** The whole database, accounts included. Passwords are hashes; keep the file somewhere safe. */
export async function exportEverything(db: Db): Promise<BackupFile> {
  return exportTables(db, ALL_TABLES, await schemaVersion(db));
}

/** Replace everything in the database with a full backup. All or nothing. Logged-in sessions end. */
export async function importEverything(db: Db, data: unknown): Promise<Record<string, number>> {
  const parsed = backupFile.safeParse(data);
  if (!parsed.success) throw badRequest('This is not a Production Costing backup file.');
  const file = parsed.data;
  if (file.schema === 'business-export') throw badRequest('Business exports cannot be restored; use a full backup.');
  // The version comes before the table check: a backup from an older version lacks the newer tables,
  // and "restore it with the matching app version" is the useful message for it.
  const current = await schemaVersion(db);
  if (file.schema !== current) {
    throw badRequest(`This backup is from database version ${file.schema} but this database is on ${current}. Restore it with the matching app version, into a database a newer version has not upgraded.`);
  }
  for (const t of ALL_TABLES) {
    if (!Array.isArray(file.tables[t])) throw badRequest(`The backup file is missing the "${t}" table, so it cannot be restored.`);
  }

  const counts: Record<string, number> = {};
  await db.tx(async (q) => {
    await q.query('DELETE FROM sessions');
    await q.query('DELETE FROM user_tokens');
    for (const t of [...ALL_TABLES].reverse()) await q.query(`DELETE FROM ${t}`);
    for (const t of ALL_TABLES) {
      const rows = file.tables[t]!;
      counts[t] = rows.length;
      if (rows.length === 0) continue;
      await q.query(`INSERT INTO ${t} SELECT * FROM json_populate_recordset(null::${t}, $1::json)`, [JSON.stringify(rows)]);
    }
    for (const t of WITH_ID) {
      await q.query(
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), (SELECT MAX(id) FROM ${t}) IS NOT NULL)`,
      );
    }
  });
  return counts;
}
