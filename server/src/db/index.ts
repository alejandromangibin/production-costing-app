import fs from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run one or more SQL statements with no parameters (used for migrations). */
  exec(text: string): Promise<void>;
}

export interface Db extends Queryable {
  kind: 'postgres' | 'pglite';
  /** Run several statements as one all-or-nothing transaction. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** A PostgreSQL connection string. If empty, PGlite is used. */
  databaseUrl?: string;
  /** Folder for PGlite files. Ignored when `memory` is true. */
  dataDir?: string;
  /** Keep the PGlite database in memory only (used by tests). */
  memory?: boolean;
}

// Why a PostgreSQL connection failed, in words an operator can act on. Keyed by Node / PostgreSQL error code.
const CERTIFICATE = "the database's security certificate could not be checked (ask your provider for its connection settings)";
const CONNECTION_REASONS: Record<string, string> = {
  ECONNREFUSED: 'the database refused the connection',
  ENOTFOUND: 'the database address was not found',
  EAI_AGAIN: 'the database address could not be looked up',
  ETIMEDOUT: 'the connection timed out',
  ECONNRESET: 'the connection was cut off',
  ENETUNREACH: "the database address cannot be reached from this server (try your provider's pooler or IPv4 address)",
  EHOSTUNREACH: "the database address cannot be reached from this server (try your provider's pooler or IPv4 address)",
  '28P01': 'the user name or password was not accepted',
  '28000': 'the database did not accept this login',
  '3D000': 'the database name in the address does not exist',
  // pg cannot even read the address (an unencoded # or ? in the password, for example).
  ERR_INVALID_URL: 'the address could not be read',
  '53300': 'the database has too many connections open right now; wait a minute and restart',
  '57P03': 'the database is still starting up; wait a minute and restart',
  SELF_SIGNED_CERT_IN_CHAIN: CERTIFICATE,
  DEPTH_ZERO_SELF_SIGNED_CERT: CERTIFICATE,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: CERTIFICATE,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: CERTIFICATE,
  CERT_HAS_EXPIRED: CERTIFICATE,
  ERR_TLS_CERT_ALTNAME_INVALID: CERTIFICATE,
};

/** The reason for a connection failure, or undefined if `err` is not one. Some pg errors carry no code. */
function connectionReason(err: unknown): string | undefined {
  const e = err as { code?: string; message?: string; errors?: { code?: string }[] } | null;
  const code = e?.code ?? e?.errors?.[0]?.code;
  const message = String(e?.message ?? '');
  if (code === '28000' && /SSL off|no encryption/i.test(message)) {
    return 'the database requires a secure connection: add ?sslmode=verify-full to the end of DATABASE_URL (use & instead of ? if the address already contains a ?)';
  }
  // pg reports its own connect timeout (see CONNECT_TIMEOUT_MS) with no code.
  if (!code && /timeout exceeded when trying to connect|terminated due to connection timeout/i.test(message)) {
    return `the database did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds`;
  }
  if (!code && /does not support SSL connections/i.test(message)) {
    return 'the database does not accept secure connections; remove sslmode from the address only if your provider says so';
  }
  return code ? CONNECTION_REASONS[code] : undefined;
}

/**
 * The database host to name in a message, or null when it cannot be trusted. A password with an
 * unencoded "@" or "/" makes the parser read part of it as the host; ?host= makes pg use another host.
 */
function safeHost(databaseUrl: string): string | null {
  try {
    const url = new URL(databaseUrl);
    if (databaseUrl.split('@').length > 2 || url.searchParams.has('host')) return null;
    return /^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i.test(url.hostname) ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Blank out the password from DATABASE_URL wherever it appears in `text`, raw or decoded. */
function withoutPassword(text: string, databaseUrl: string): string {
  const afterScheme = databaseUrl.slice(databaseUrl.indexOf('://') + 3);
  const userinfo = afterScheme.slice(0, Math.max(afterScheme.lastIndexOf('@'), 0));
  const raw = userinfo.slice(userinfo.indexOf(':') + 1);
  // Very short values are skipped: blanking them everywhere would garble the message. Node and pg
  // connection errors never repeat the password anyway; this is a second line of defence.
  if (!userinfo.includes(':') || raw.length < 4) return text;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep the raw form */
  }
  return [raw, decoded].reduce((t, secret) => t.split(secret).join('***'), text);
}

/**
 * A plain message for a failure to reach the PostgreSQL database in `databaseUrl`, or null when the
 * error is something else (which should then be shown in full). Never shows the password.
 */
export function databaseConnectionProblem(err: unknown, databaseUrl: string): string | null {
  if (!databaseUrl) return null;
  const reason = connectionReason(err);
  if (!reason) return null;
  const host = safeHost(databaseUrl);
  // Only for an address that parsed cleanly: with a misread address, pg's own message can contain a
  // piece of the password (for example as the "host" it could not find).
  const details = host
    ? withoutPassword(String((err as { message?: string } | null)?.message ?? '').replace(/\s+/g, ' ').trim(), databaseUrl)
    : '';
  // An unencoded @ / # ? in the password either splits the address in the wrong place or stops it parsing.
  let misread = databaseUrl.split('@').length > 2;
  try {
    new URL(databaseUrl);
  } catch {
    misread = true;
  }
  return (
    `Cannot reach the database at ${host ?? 'the address in DATABASE_URL'}: ${reason}.\n` +
    'Check that DATABASE_URL is copied exactly from your database provider, and that the database is running ' +
    '(see DEPLOY.md).' +
    (misread ? "\nIf your password contains symbols such as @ / # ?, they must be URL-encoded (your provider's copy button does this)." : '') +
    (details ? `\nDetails: ${details}` : '') +
    '\nYour data has not been touched. Refusing to start.'
  );
}

export async function openDb(opts: OpenOptions): Promise<Db> {
  if (opts.databaseUrl) return openPostgres(opts.databaseUrl);
  return openPglite(opts);
}

/**
 * How long to wait for a database connection before giving up (decision D-13). It applies at start-up
 * and whenever a request waits for a free connection from the pool.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

export function postgresPoolConfig(connectionString: string): pg.PoolConfig {
  return { connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS };
}

/**
 * The database can close a connection the pool is keeping idle (for example when the provider restarts
 * it). pg reports that as an 'error' event, which would crash the app if nothing listened (decision D-14).
 * Log one plain line instead; the pool opens a fresh connection for the next request.
 */
export function logIdleConnectionErrors(
  pool: { on(event: 'error', listener: (err: Error) => void): unknown },
  databaseUrl: string,
  log: (line: string) => void = console.error,
) {
  pool.on('error', (err) => {
    log(`The database closed an idle connection (${connectionErrorDetails(err, databaseUrl)}). The app keeps running and reconnects for the next request.`);
  });
}

/** An error's message on one line, with the password from DATABASE_URL blanked out. */
function connectionErrorDetails(err: unknown, databaseUrl: string): string {
  return withoutPassword(String((err as { message?: string } | null)?.message ?? err).replace(/\s+/g, ' ').trim(), databaseUrl);
}

function openPostgres(connectionString: string): Db {
  const pool = new pg.Pool(postgresPoolConfig(connectionString));
  logIdleConnectionErrors(pool, connectionString);
  return {
    kind: 'postgres',
    query: async (text, params) => (await pool.query(text, params as any[])) as any,
    exec: async (text) => {
      await pool.query(text);
    },
    async tx(fn) {
      const client = await pool.connect();
      // While a connection is checked out, pg-pool stops listening for its errors. If the database drops
      // it mid-change, pg emits 'error' on the client, which would crash the app (decision D-14).
      let broken: Error | undefined;
      const onError = (err: Error) => {
        broken = err;
        // "may not": if the drop comes while committing, the database may already have saved it.
        console.error(
          `The database connection dropped during a change (${connectionErrorDetails(err, connectionString)}). ` +
            'That change may not have been saved; the app keeps running.',
        );
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (text, params) => (await client.query(text, params as any[])) as any,
          exec: async (text) => {
            await client.query(text);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        // A failed ROLLBACK (for example on a dead connection) must not hide the original error.
        if (!broken) await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.removeListener('error', onError);
        // A dead connection is thrown away instead of going back into the pool.
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(opts: OpenOptions): Promise<Db> {
  let db: PGlite;
  if (opts.memory) {
    db = new PGlite();
  } else {
    const dir = opts.dataDir ?? '.data';
    fs.mkdirSync(dir, { recursive: true });
    db = new PGlite(dir);
  }
  await db.waitReady;
  return {
    kind: 'pglite',
    query: async (text, params) => (await db.query(text, params as any[])) as any,
    exec: async (text) => {
      await db.exec(text);
    },
    tx: (fn) =>
      db.transaction((t) =>
        fn({
          query: async (text, params) => (await t.query(text, params as any[])) as any,
          exec: async (text) => {
            await t.exec(text);
          },
        }),
      ),
    close: () => db.close(),
  };
}
