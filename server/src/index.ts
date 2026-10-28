import { createApp } from './app';
import { config, insecureCookieWarning, productionDatabaseProblem } from './config';
import { openDb } from './db/index';
import { checkIsolationOrStop, ensureAdminOrStop, migrateOrStop } from './startup';
import { portIsFree } from './portCheck';

// Never run a hosted service on the built-in database: its data would be lost on the next deploy.
const dbProblem = productionDatabaseProblem(config.needsRealDatabase, config.databaseUrl);
if (dbProblem) {
  console.error(`\n${dbProblem}`);
  process.exit(1);
}

// Shown before the database is opened, so it reaches the log even if connecting fails.
const cookieProblem = insecureCookieWarning(config);
if (cookieProblem) console.warn(cookieProblem);

/**
 * With the built-in database, make sure no other copy of the app is already running BEFORE opening it.
 * Two copies using the same database folder could damage it.
 */
if (!config.databaseUrl && !(await portIsFree(config.port, config.host))) {
  console.error(
    `\nThe app seems to be running already (port ${config.port} is in use).\n` +
      'Close the other terminal window running it, or set a different PORT in the .env file, then try again.\n' +
      'Your data has not been touched.',
  );
  process.exit(1);
}

const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const applied = await migrateOrStop(db, config.databaseUrl);
if (applied.length) console.log(`Database set up (${applied.join(', ')})`);

// Stop at once if one business's data is not truly walled off from another's.
await checkIsolationOrStop(db);

if (await ensureAdminOrStop(db, config.adminEmail, config.adminPassword)) {
  console.log(`Created the platform admin account for ${config.adminEmail}. Remove ADMIN_EMAIL and ADMIN_PASSWORD from the settings now.`);
}

const app = createApp(db);
const server = app.listen(config.port, config.host, (err?: Error) => {
  if (err) {
    console.error(err.message);
    process.exit(1);
  }
  const where = db.kind === 'postgres' ? 'PostgreSQL' : `built-in database in ${config.dataDir}`;
  console.log(`Production Costing server ready at http://${config.host}:${config.port}  (${where})`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
