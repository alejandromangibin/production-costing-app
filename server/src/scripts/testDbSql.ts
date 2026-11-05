/** The test database's fixed names. Nothing here touches any other database. */
export const TEST_ROLE = 'costing_test_owner';
export const TEST_DATABASE = 'costing_test';

/**
 * The psql commands that create the test role and database, safe to run again. The role is a plain table
 * owner, not a superuser, like the owner role on a host: a superuser would skip the checks being tested.
 * `password` must be hex, so it needs no quoting. UTF8 matches a hosted database, whatever this PC's default is.
 */
export function setupSql(password: string): string {
  if (!/^[0-9a-f]{32,}$/.test(password)) throw new Error('The test password must be long hex text.');
  return [
    `SELECT 'CREATE ROLE ${TEST_ROLE}' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_ROLE}') \\gexec`,
    `ALTER ROLE ${TEST_ROLE} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB PASSWORD '${password}';`,
    `SELECT 'CREATE DATABASE ${TEST_DATABASE} OWNER ${TEST_ROLE} ENCODING ''UTF8'' TEMPLATE template0'`,
    `  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${TEST_DATABASE}') \\gexec`,
    // The app's own role is shared by the whole server, so it may exist from an earlier run.
    `SELECT 'GRANT costing_app TO ${TEST_ROLE}' WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'costing_app') \\gexec`,
    '',
  ].join('\n');
}

/** How psql is started: this PC's server, no personal settings file, stop at the first error. */
export const PSQL_ARGS = ['-X', '-U', 'postgres', '-h', 'localhost', '-p', '5432', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'];

/** The environment for psql, without PG* or PSQL* settings that could point it somewhere else. */
export function psqlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(PG|PSQL)/i.test(key)));
}

/** The address the tests connect to, as stored in .env.test. */
export const testDatabaseUrl = (password: string) => `postgres://${TEST_ROLE}:${password}@localhost:5432/${TEST_DATABASE}`;
