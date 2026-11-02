import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The server folder (server/). */
export const serverDir = path.resolve(here, '..');
/** The project folder (production-costing-app/). */
export const rootDir = path.resolve(serverDir, '..');

// Optional settings file at the project root. Missing file is fine.
try {
  process.loadEnvFile(path.join(rootDir, '.env'));
} catch {
  /* no .env file: use defaults */
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * The businesses' own time zone (default Asia/Manila). A hosted server's clock usually runs on UTC,
 * eight hours behind Manila. Refuses a name this computer does not know, so a typo stops the start.
 */
export function resolveTimeZone(value: string | undefined): string {
  const timeZone = value || 'Asia/Manila';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`APP_TIME_ZONE "${timeZone}" is not a time zone this computer knows. Use a name like Asia/Manila.`);
  }
  return timeZone;
}

// Checked as soon as anything loads the settings, so a typo stops the server and the scripts with a
// plain message instead of a crash report.
let timeZone: string;
try {
  timeZone = resolveTimeZone(process.env.APP_TIME_ZONE);
} catch (err) {
  console.error(`\n${(err as Error).message}\nYour data has not been touched. Refusing to start.`);
  process.exit(1);
}

/**
 * Whether the built-in database must be refused: in production, or on Render. Render sets RENDER=true
 * on every service it runs, so a forgotten NODE_ENV there cannot slip past the check.
 */
export function needsRealDatabase(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production' || env.RENDER === 'true';
}

/**
 * The web dev server's address, allowed to call the API while developing. A hosted app (production,
 * or on Render) serves its own pages and allows no other origin unless CORS_ORIGIN is set on purpose.
 */
export function corsOriginFor(env: NodeJS.ProcessEnv): string {
  // Browsers send the origin with no trailing slash, so a pasted "https://x/" must be cleaned to match.
  const set = env.CORS_ORIGIN?.trim().replace(/\/+$/, '');
  return set ?? (needsRealDatabase(env) ? '' : 'http://localhost:5173');
}

/**
 * A warning when a hosted app would send sign-in cookies without the Secure flag, or null.
 * Production with COOKIE_SECURE=false is allowed for plain-http testing, so it only warns.
 * On Render without NODE_ENV=production the cookies are not Secure either.
 */
export function insecureCookieWarning(c: { isProd: boolean; onRender: boolean; cookieSecure: boolean }): string | null {
  if (c.cookieSecure) return null;
  if (c.isProd) return 'WARNING: COOKIE_SECURE is off in production. Logins will travel without the Secure flag.';
  if (c.onRender) {
    return (
      'WARNING: NODE_ENV is not set to "production" on this Render service, so sign-ins are less protected than they ' +
      'should be (the sign-in cookie may also be sent over plain http). The app still works. To fix it, add ' +
      'NODE_ENV=production in the Environment settings of the service and redeploy (see DEPLOY.md).'
    );
  }
  return null;
}

/**
 * In production the app (and the backup and restore scripts) must use a real PostgreSQL database.
 * The built-in one keeps its files on the server's own disk, which hosts such as Render wipe on every
 * deploy and restart. Returns the reason to refuse to start, or null if all is well.
 */
export function productionDatabaseProblem(needsRealDatabase: boolean, databaseUrl: string): string | null {
  if (!needsRealDatabase) return null;
  const url = databaseUrl.trim();
  const ending = '\nYour data has not been touched. Refusing to start.';
  if (!url) {
    return (
      'DATABASE_URL is not set, so the app would use its built-in database. In production (NODE_ENV=production, or on Render) ' +
      "that would keep every business's data on the server's own disk, which hosts like Render wipe on every deploy.\n" +
      'Set DATABASE_URL to your PostgreSQL database address (see DEPLOY.md).' +
      ending +
      '\nIf you are running the app on your own computer, remove NODE_ENV=production (and RENDER, if set) from your settings instead.'
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return (
      'DATABASE_URL does not look like a PostgreSQL address. It should start with postgres:// or postgresql://. ' +
      'Copy it again from your database provider (see DEPLOY.md).' +
      ending
    );
  }
  return null;
}

export const config = {
  isProd,
  /** The built-in database is refused here (see productionDatabaseProblem). */
  needsRealDatabase: needsRealDatabase(process.env),
  /** Render sets RENDER=true on every service it runs. */
  onRender: process.env.RENDER === 'true',
  /** Decides what "today" is: trial ends, paid-through and grace days, new trials, file names. */
  timeZone,
  /** Public address of the app, used in invite links. Empty = work it out from each request. */
  appOrigin: (process.env.APP_ORIGIN ?? '').replace(/\/+$/, ''),
  /** Cookies only travel over HTTPS. On by default in production; set COOKIE_SECURE=false for plain http testing. */
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
  /** Set TRUST_PROXY=true when the app sits behind a host's HTTPS proxy (Render, Railway, Fly...). */
  trustProxy: process.env.TRUST_PROXY === 'true',
  /** Creates the platform admin (you) on first start if no admin exists yet. Remove both afterwards. */
  adminEmail: process.env.ADMIN_EMAIL ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  sessionDays: 30,
  inviteDays: 7,
  /** Days after paid_through before a paid business becomes read-only. */
  graceDays: 7,
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '127.0.0.1',
  /** Empty means: use the built-in PGlite database. */
  databaseUrl: (process.env.DATABASE_URL ?? '').trim(),
  dataDir: path.resolve(serverDir, process.env.DATA_DIR || '.data'),
  corsOrigin: corsOriginFor(process.env),
  migrationsDir: path.join(serverDir, 'migrations'),
  webDist: path.join(rootDir, 'web', 'dist'),
  backupsDir: path.join(rootDir, 'backups'),
};
