import { type Db, databaseConnectionProblem } from './db/index';
import { migrate } from './db/migrate';
import { assertIsolation } from './db/scoped';
import { HttpError } from './errors';
import { ensureAdmin } from './services/accounts';

// Start-up steps for the server and the backup/restore scripts. Each one stops the program with a
// plain message (no crash report) for the problems an operator can fix, and lets anything else through.

function stop(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/**
 * The database user is not allowed to create the restricted role costing_app (migration 002), which
 * is how one business's data is kept away from another's. Returns a plain message, or null.
 */
export function roleProblem(err: unknown): string | null {
  const e = err as { code?: string; message?: string; where?: string } | null;
  if (e?.code !== '42501') return null;
  // The message may be translated on a non-English server; the statement in 'where' never is.
  if (!/create role/i.test(String(e?.message ?? '')) && !/CREATE ROLE/.test(String(e?.where ?? ''))) return null;
  return (
    'The database user in DATABASE_URL is not allowed to create the restricted database role "costing_app" ' +
    "that keeps each business's data separate, so the app cannot run safely on this database.\n" +
    'Ask your database provider whether its main user can create roles (the CREATEROLE permission), or use a ' +
    'database where it can (see DEPLOY.md). No settings change in the app fixes this.\n' +
    'No business data has been changed. Refusing to start.'
  );
}

/**
 * migrate() is the first query, so a wrong DATABASE_URL, a stopped database or a database user without
 * the right to create the app's role shows up here.
 */
export async function migrateOrStop(db: Db, databaseUrl: string): Promise<string[]> {
  try {
    return await migrate(db);
  } catch (err) {
    const problem = databaseConnectionProblem(err, databaseUrl) ?? roleProblem(err);
    if (!problem) throw err;
    stop(problem);
  }
}

/**
 * The business-separation check. Its own refusals are written for the operator and end in
 * "Refusing to start."; anything else (a bug) is shown in full.
 */
export async function checkIsolationOrStop(db: Db): Promise<void> {
  try {
    await assertIsolation(db);
  } catch (err) {
    const message = String((err as Error)?.message ?? '');
    if (!/Refusing to start\.$/.test(message)) throw err;
    await db.close().catch(() => {});
    stop(message);
  }
}

/** Creates the first platform admin. A password that breaks the rules stops the start with the reason. */
export async function ensureAdminOrStop(db: Db, email: string, password: string): Promise<boolean> {
  try {
    return await ensureAdmin(db, email, password);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 400) throw err;
    // Close the built-in database cleanly before stopping.
    await db.close().catch(() => {});
    stop(
      `ADMIN_PASSWORD was not accepted: ${err.message}\n` +
        'Change ADMIN_PASSWORD in the settings and start again. No sign-in was created.',
    );
  }
}
