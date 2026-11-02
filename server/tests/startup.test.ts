import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { corsOriginFor, insecureCookieWarning, needsRealDatabase, productionDatabaseProblem, serverDir } from '../src/config';
import { CONNECT_TIMEOUT_MS, databaseConnectionProblem, logIdleConnectionErrors, postgresPoolConfig } from '../src/db/index';
import { checkIsolationOrStop, roleProblem } from '../src/startup';

const tsx = createRequire(import.meta.url).resolve('tsx/cli');

/** Run a server entry point the way a host would: production mode, no database address. */
function runInProduction(
  script: string,
  args: string[] = [],
  files: Record<string, string> = {},
  env: Record<string, string> = {},
  timeoutMs = 20_000,
) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'costing-guard-'));
  const dataDir = path.join(scratch, 'data');
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(scratch, name), text);
    const run = spawnSync(process.execPath, [tsx, script, ...args], {
      cwd: serverDir,
      // An empty DATABASE_URL also stops a developer's .env from supplying one.
      env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', DATA_DIR: dataDir, PORT: '3997', INIT_CWD: scratch, ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    // A child killed for taking too long has no exit code; say so plainly instead of "expected null to be 1".
    if (run.error || run.signal) throw new Error(`${script} did not finish within ${timeoutMs} ms (${run.error?.message ?? run.signal})`);
    return { run, dataDirCreated: fs.existsSync(dataDir), files: fs.readdirSync(scratch) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// A failed assertion must not leave process.exit or console.error mocked for later tests.
afterEach(() => vi.restoreAllMocks());

describe('production needs a real database', () => {
  it('refuses a missing or wrong database address in production only', () => {
    for (const blank of ['', '   ', '\t', '\n']) expect(productionDatabaseProblem(true, blank)).toContain('DATABASE_URL is not set');
    // What Node's .env reader produces from "DATABASE_URL=   " followed by another line.
    expect(productionDatabaseProblem(true, 'DATA_DIR=.data')).toContain('does not look like a PostgreSQL address');
    expect(productionDatabaseProblem(true, 'mysql://u:p@db/costing')).toContain('does not look like a PostgreSQL address');
    expect(productionDatabaseProblem(true, 'postgres://u:p@db.internal:5432/costing')).toBeNull();
    expect(productionDatabaseProblem(true, '  postgresql://u:p@db.internal/costing?sslmode=require  ')).toBeNull();
    expect(productionDatabaseProblem(false, '')).toBeNull();
    expect(productionDatabaseProblem(true, '')).toContain('Your data has not been touched');
    expect(productionDatabaseProblem(true, '')).toContain('on your own computer');
    expect(productionDatabaseProblem(true, 'DATA_DIR=.data')).toContain('Your data has not been touched');
    expect(productionDatabaseProblem(true, 'DATA_DIR=.data')).not.toContain('on your own computer');
  });

  it('the server stops at once, before touching any data folder', () => {
    const { run, dataDirCreated } = runInProduction('src/index.ts');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('DATABASE_URL is not set');
    expect(dataDirCreated).toBe(false);
  });

  it('counts production or Render, and nothing else, as needing a real database', () => {
    expect(needsRealDatabase({ NODE_ENV: 'production' })).toBe(true);
    expect(needsRealDatabase({ RENDER: 'true' })).toBe(true);
    expect(needsRealDatabase({ NODE_ENV: 'development', RENDER: 'true' })).toBe(true);
    for (const render of ['false', '', 'TRUE', '1']) expect(needsRealDatabase({ RENDER: render })).toBe(false);
    expect(needsRealDatabase({ NODE_ENV: 'development' })).toBe(false);
    expect(needsRealDatabase({})).toBe(false);
  });

  it('on Render the server refuses even when NODE_ENV was forgotten', () => {
    // NODE_ENV set but not production, so only Render's own RENDER=true marker can trigger the guard.
    const { run, dataDirCreated } = runInProduction('src/index.ts', [], {}, { NODE_ENV: 'development', RENDER: 'true' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('DATABASE_URL is not set');
    expect(dataDirCreated).toBe(false);
  });

  it('allows the web dev server only while developing, unless CORS_ORIGIN is set on purpose', () => {
    expect(corsOriginFor({})).toBe('http://localhost:5173');
    expect(corsOriginFor({ NODE_ENV: 'development' })).toBe('http://localhost:5173');
    expect(corsOriginFor({ NODE_ENV: 'production' })).toBe('');
    expect(corsOriginFor({ RENDER: 'true' })).toBe('');
    expect(corsOriginFor({ NODE_ENV: 'production', CORS_ORIGIN: 'https://admin.example' })).toBe('https://admin.example');
    expect(corsOriginFor({ NODE_ENV: 'production', CORS_ORIGIN: '  https://admin.example/  ' })).toBe('https://admin.example');
    // The example settings file must not switch the dev address on for a host.
    expect(fs.readFileSync(path.join(serverDir, '..', '.env.example'), 'utf8')).not.toMatch(/^CORS_ORIGIN=/m);
  });

  it('warns when a hosted app would send sign-in cookies without the Secure flag', () => {
    const w = (isProd: boolean, onRender: boolean, cookieSecure: boolean) => insecureCookieWarning({ isProd, onRender, cookieSecure });
    expect(w(true, true, false)).toContain('COOKIE_SECURE is off in production');
    expect(w(false, true, false)).toContain('NODE_ENV is not set to "production" on this Render service');
    expect(w(true, true, true)).toBeNull();
    expect(w(false, true, true)).toBeNull(); // Render with COOKIE_SECURE=true set by hand
    expect(w(false, false, false)).toBeNull(); // your own computer
  });

  it('on Render without NODE_ENV the warning reaches the log even when the database cannot be reached', () => {
    const { run } = runInProduction('src/index.ts', [], {}, {
      NODE_ENV: 'development',
      RENDER: 'true',
      // Port 1 on this computer refuses at once: no DNS lookup, no waiting.
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/costing',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('NODE_ENV is not set to "production" on this Render service');
    expect(run.stderr).not.toContain('DATABASE_URL is not set');
  });

  it('explains a database that cannot be reached, naming the host but never the password', () => {
    const url = 'postgres://costing:S3cretPass@db.example.internal:5432/costing';
    const refused = databaseConnectionProblem({ code: 'ECONNREFUSED' }, url)!;
    expect(refused).toContain('Cannot reach the database at db.example.internal: the database refused the connection.');
    expect(refused).toContain('Your data has not been touched');
    expect(refused).not.toContain('S3cretPass');
    // Node reports "localhost" refusals as several attempts in one error.
    expect(databaseConnectionProblem({ errors: [{ code: 'ECONNREFUSED' }] }, url)).toContain('refused the connection');
    expect(databaseConnectionProblem({ code: 'ENOTFOUND' }, url)).toContain('address was not found');
    expect(databaseConnectionProblem({ code: '28P01' }, url)).toContain('user name or password was not accepted');
    expect(databaseConnectionProblem({ code: '3D000' }, url)).toContain('database name in the address does not exist');
    // Anything else is shown in full, and the built-in database never gets this message.
    expect(databaseConnectionProblem({ code: '42P01' }, url)).toBeNull();
    expect(databaseConnectionProblem(new Error('boom'), url)).toBeNull();
    expect(databaseConnectionProblem({ code: 'ECONNREFUSED' }, '')).toBeNull();
    expect(databaseConnectionProblem({ code: 'ECONNREFUSED' }, 'postgres://[bad')).toContain('Cannot reach the database at the address in DATABASE_URL');
  });

  it('never names part of a password as the host, and blanks the password out of the details', () => {
    // An unencoded @ and / in the password Xy7@k9Lm/Qz makes the parser (and pg) treat k9Lm as the host,
    // so pg's own message contains that piece of the password.
    const messy = databaseConnectionProblem({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND k9Lm' }, 'postgres://u:Xy7@k9Lm/Qz@realhost:5432/db')!;
    expect(messy).toContain('Cannot reach the database at the address in DATABASE_URL');
    expect(messy).toContain('URL-encoded');
    expect(messy).not.toContain('k9Lm');
    expect(messy).not.toContain('Details:');
    // A # in the password stops the address parsing at all: same hint, no details.
    const hash = databaseConnectionProblem({ code: 'ERR_INVALID_URL', message: 'Invalid URL' }, 'postgres://u:ab#cd@[x/db')!;
    expect(hash).toContain('the address could not be read');
    expect(hash).toContain('URL-encoded');
    expect(hash).not.toContain('Details:');
    const hostParam = databaseConnectionProblem({ code: 'ECONNREFUSED' }, 'postgres://u:pw12@db.example/x?host=/var/run')!;
    expect(hostParam).toContain('at the address in DATABASE_URL');
    expect(hostParam).not.toContain('URL-encoded'); // the password is not the problem here
    const url = 'postgres://costing:S3cretPass@db.example.internal:5432/costing';
    const auth = databaseConnectionProblem({ code: '28P01', message: 'password authentication failed for user "costing" (S3cretPass)' }, url)!;
    expect(auth).toContain('Details: password authentication failed for user "costing" (***)');
    expect(auth).not.toContain('S3cretPass');
    const encoded = databaseConnectionProblem({ code: '28P01', message: 'saw p@ssWord1 and p%40ssWord1' }, 'postgres://costing:p%40ssWord1@db.example/costing')!;
    expect(encoded).toContain('Details: saw *** and ***');
  });

  it('explains hosted network, busy-database and secure-connection failures', () => {
    const url = 'postgres://costing:S3cretPass@db.example.internal:5432/costing';
    expect(databaseConnectionProblem({ code: 'ENETUNREACH' }, url)).toContain('cannot be reached from this server');
    expect(databaseConnectionProblem({ code: 'EHOSTUNREACH' }, url)).toContain('cannot be reached from this server');
    expect(databaseConnectionProblem({ code: '53300' }, url)).toContain('too many connections');
    expect(databaseConnectionProblem({ code: '57P03' }, url)).toContain('still starting up');
    expect(databaseConnectionProblem({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }, url)).toContain('security certificate could not be checked');
    expect(databaseConnectionProblem({ code: 'CERT_HAS_EXPIRED' }, url)).toContain('security certificate could not be checked');
    // pg reports this one with no code at all.
    expect(databaseConnectionProblem(new Error('The server does not support SSL connections'), url)).toContain('does not accept secure connections');
    const noSsl = databaseConnectionProblem({ code: '28000', message: 'no pg_hba.conf entry for host "1.2.3.4", user "costing", database "costing", no encryption' }, url)!;
    expect(noSsl).toContain('add ?sslmode=verify-full');
    expect(databaseConnectionProblem({ code: '28000', message: 'role is not permitted to log in' }, url)).toContain('did not accept this login');
    // Turning certificate checks off is never suggested.
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']) expect(databaseConnectionProblem({ code }, url)).not.toMatch(/no-verify|rejectUnauthorized/);
  });

  // Three child processes in a row: allow for slow start-ups when all test files run at once.
  it('the server, a backup and a restore stop with that plain message when the database refuses', { timeout: 60_000 }, () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgres://costing:S3cretPass@127.0.0.1:1/costing' };
    const backupFile = { 'restore-me.json': JSON.stringify({ app: 'production-costing', version: 2, schema: 'none', tables: {} }) };
    for (const [script, args] of [['src/index.ts', []], ['src/scripts/backup.ts', ['backup.json']], ['src/scripts/restore.ts', ['restore-me.json', '--yes']]] as const) {
      const { run, files } = runInProduction(script, [...args], backupFile, env);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Cannot reach the database at 127.0.0.1: the database refused the connection.');
      expect(run.stderr).not.toMatch(/^\s+at /m); // no stack trace
      expect(run.stderr + run.stdout).not.toContain('S3cretPass');
      expect(files).not.toContain('backup.json');
    }
  });

  it('a # in the password gives the plain message and the encoding hint, not a crash', () => {
    const { run } = runInProduction('src/index.ts', [], {}, { DATABASE_URL: 'postgres://u:Ab#cd1234@realhost:5432/db' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Cannot reach the database at the address in DATABASE_URL: the address could not be read.');
    expect(run.stderr).toContain('URL-encoded');
    expect(run.stderr).not.toContain('Details:');
    expect(run.stderr).not.toMatch(/^\s+at /m); // no stack trace
    expect(run.stderr + run.stdout).not.toContain('cd1234');
  });

  it('gives up connecting after 30 seconds and explains it plainly (D-13)', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(30_000);
    expect(postgresPoolConfig('postgres://u:pw12@db.example/x')).toMatchObject({ connectionTimeoutMillis: 30_000 });
    const url = 'postgres://costing:S3cretPass@db.example.internal:5432/costing';
    // pg reports both of its timeouts without a code.
    for (const message of ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']) {
      expect(databaseConnectionProblem(new Error(message), url)).toContain('the database did not answer within 30 seconds');
    }
  });

  it('logs a plain line instead of crashing when the database drops an idle connection (D-14)', () => {
    const lines: string[] = [];
    const pool = new EventEmitter();
    logIdleConnectionErrors(pool, 'postgres://costing:S3cretPass@db.example/costing', (line) => lines.push(line));
    // Without a listener this emit would throw and crash the app.
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly (S3cretPass)'))).not.toThrow();
    expect(lines).toEqual([
      'The database closed an idle connection (Connection terminated unexpectedly (***)). The app keeps running and reconnects for the next request.',
    ]);
    // The real pool gets the same listener.
    const real = new pg.Pool(postgresPoolConfig('postgres://u:pw12@127.0.0.1:1/x'));
    logIdleConnectionErrors(real, 'postgres://u:pw12@127.0.0.1:1/x', () => {});
    expect(() => real.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    void real.end();
  });

  it('explains a database user that may not create the app role, in plain words', () => {
    const message = roleProblem({ code: '42501', message: 'permission denied to create role' })!;
    expect(message).toContain('not allowed to create the restricted database role "costing_app"');
    expect(message).toContain('CREATEROLE');
    expect(message).toContain('Refusing to start.');
    // Other permission errors are not this problem and are shown in full.
    expect(roleProblem({ code: '42501', message: 'permission denied for table products' })).toBeNull();
    expect(roleProblem({ code: '28P01', message: 'password authentication failed' })).toBeNull();
    expect(roleProblem(new Error('create role failed'))).toBeNull();
  });

  it('recognises the role refusal on a non-English database server too', () => {
    // The message is translated; the statement in 'where' is not.
    const translated = roleProblem({
      code: '42501',
      message: 'permiso denegado para crear rol',
      where: 'SQL statement "CREATE ROLE costing_app NOLOGIN"\nPL/pgSQL function inline_code_block line 4 at SQL statement',
    });
    expect(translated).toContain('not allowed to create the restricted database role "costing_app"');
    expect(roleProblem({ code: '42501', message: 'permiso denegado para la tabla products', where: 'SQL statement "SELECT 1"' })).toBeNull();
  });

  it('the isolation check stops plainly on its own refusals and shows anything else in full', async () => {
    const fakeDb = (query: () => Promise<{ rows: any[] }>) => {
      const close = vi.fn(async () => {});
      const db = { kind: 'postgres' as const, query, exec: async () => {}, tx: async (fn: any) => fn({ query, exec: async () => {} }), close };
      return { db, close };
    };

    // A bug (not one of the check's own refusals) is rethrown unchanged, and nothing is closed.
    const bug = new TypeError('boom');
    const broken = fakeDb(async () => {
      throw bug;
    });
    await expect(checkIsolationOrStop(broken.db)).rejects.toBe(bug);
    expect(broken.close).not.toHaveBeenCalled();

    // No tables with row-level security: the check's own refusal, shown plainly, after closing the database.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const empty = fakeDb(async () => ({ rows: [] }));
    await expect(checkIsolationOrStop(empty.db)).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('Row-level security is not switched on for:');
    expect(String(logged.mock.calls[0]?.[0])).toContain('Refusing to start.');
    expect(empty.close).toHaveBeenCalled();
    exit.mockRestore();
    logged.mockRestore();
  });

  it('a wrong APP_TIME_ZONE stops the start with a plain message, before touching any data folder', () => {
    const { run, dataDirCreated } = runInProduction('src/index.ts', [], {}, { APP_TIME_ZONE: 'Mars/Base' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('APP_TIME_ZONE "Mars/Base" is not a time zone this computer knows.');
    expect(run.stderr).toContain('Refusing to start.');
    expect(run.stderr).not.toMatch(/^\s+at /m); // no stack trace
    expect(dataDirCreated).toBe(false);
  });

  // This one starts and migrates the real built-in database, so it is much slower than the others,
  // especially with all test files running at once: it gets its own, longer limits.
  it('an ADMIN_PASSWORD that breaks the rules stops the start with the reason, not a crash', { timeout: 90_000 }, () => {
    // Own-computer mode, so the built-in database is allowed and the start reaches the admin step.
    const { run } = runInProduction(
      'src/index.ts',
      [],
      {},
      { NODE_ENV: 'development', RENDER: '', ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'short' },
      75_000,
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('ADMIN_PASSWORD was not accepted: Use a password of at least 10 characters.');
    expect(run.stderr).toContain('No sign-in was created.');
    expect(run.stderr).not.toMatch(/^\s+at /m); // no stack trace
  });

  it('a backup refuses instead of saving an empty copy of a throwaway database', () => {
    const { run, dataDirCreated, files } = runInProduction('src/scripts/backup.ts', ['backup.json']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('DATABASE_URL is not set');
    expect(dataDirCreated).toBe(false);
    expect(files).not.toContain('backup.json');
  });

  it('a restore refuses instead of restoring into a throwaway database', () => {
    // A real file, so without the guard the script would go on to open (and create) the built-in database.
    const { run, dataDirCreated } = runInProduction('src/scripts/restore.ts', ['backup.json', '--yes'], {
      'backup.json': JSON.stringify({ app: 'production-costing', version: 2, schema: 'none', tables: {} }),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('DATABASE_URL is not set');
    expect(dataDirCreated).toBe(false);
  });
});
