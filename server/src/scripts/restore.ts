import fs from 'node:fs';
import path from 'node:path';
import { importEverything } from '../backup';
import { config, productionDatabaseProblem } from '../config';
import { openDb } from '../db/index';
import { migrateOrStop } from '../startup';
import { portIsFree } from '../portCheck';

// In production, never "restore" into a throwaway built-in database while the real one is untouched.
const dbProblem = productionDatabaseProblem(config.needsRealDatabase, config.databaseUrl);
if (dbProblem) {
  console.error(`\n${dbProblem}`);
  process.exit(1);
}

// Usage: npm run restore -- path/to/backup.json --yes
// Restoring REPLACES everything currently in the database (every business), so --yes is required.
// Everyone is logged out. The app must be stopped when using the built-in database.

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('Tell me which backup file to restore, for example:\n  npm run restore -- backups/costing-backup-2026-10-19.json --yes');
  process.exit(1);
}
if (!confirmed) {
  console.error('Restoring replaces ALL data in the database. Run it again with --yes at the end to go ahead.');
  process.exit(1);
}

// npm runs scripts from the server folder; INIT_CWD is the folder the owner typed the command in.
const fullPath = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
if (!fs.existsSync(fullPath)) {
  console.error(`Cannot find ${fullPath}`);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

if (!config.databaseUrl && !(await portIsFree(config.port, config.host))) {
  console.error('Stop the app first (close its window), then run the restore again.');
  process.exit(1);
}

const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
await migrateOrStop(db, config.databaseUrl);
try {
  const counts = await importEverything(db, data);
  console.log('Restored:', counts);
} catch (err: any) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await db.close();
}
