import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PSQL_ARGS, TEST_DATABASE, psqlEnv, setupSql, testDatabaseUrl } from './testDbSql';

// Usage: npm run test:db:setup
// Creates a separate database on this PC's PostgreSQL for `npm run test:postgres`, and saves its address in
// .env.test, which git ignores. psql asks for the "postgres" password itself; this script never sees it.
// The tests wipe the test database on every run, so nothing in it matters. It touches no other database.

const psql = process.env.PSQL_PATH ?? 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const envFile = path.resolve(import.meta.dirname, '../../../.env.test');
const password = randomBytes(24).toString('hex');

if (!fs.existsSync(psql)) {
  console.error(`Cannot find psql at ${psql}. If PostgreSQL 16 is somewhere else, set PSQL_PATH to its psql.exe.`);
  process.exit(1);
}

console.log('Connecting to PostgreSQL on this PC. Type the password of the "postgres" user when asked.\n');
const run = spawnSync(psql, PSQL_ARGS, {
  input: setupSql(password),
  stdio: ['pipe', 'inherit', 'inherit'],
  env: psqlEnv(process.env),
});
if (run.error || run.status !== 0) {
  // The role's password may already have changed, so an older .env.test would no longer work.
  fs.rmSync(envFile, { force: true });
  console.error('\nThe test database is not ready. Check the password and that the PostgreSQL service is running, then run this again.');
  process.exit(1);
}

fs.writeFileSync(envFile, `TEST_DATABASE_URL=${testDatabaseUrl(password)}\n`, { mode: 0o600 });
console.log(`\nDone. The database "${TEST_DATABASE}" is ready, and its address is saved in .env.test.`);
console.log('Now run: npm.cmd run test:postgres');
