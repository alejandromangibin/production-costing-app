import fs from 'node:fs';
import path from 'node:path';
import { exportEverything } from '../backup';
import { config, productionDatabaseProblem } from '../config';
import { localTimeStamp, localToday } from '../dates';
import { openDb } from '../db/index';
import { migrateOrStop } from '../startup';
import { portIsFree } from '../portCheck';

// In production, never back up an empty throwaway built-in database and report success.
const dbProblem = productionDatabaseProblem(config.needsRealDatabase, config.databaseUrl);
if (dbProblem) {
  console.error(`\n${dbProblem}`);
  process.exit(1);
}

// Usage: npm run backup [-- optional-file-name.json]
// Makes a copy of the WHOLE database (every business, every login). Keep the file private.
// With the built-in database the app must be stopped first. With PostgreSQL it can keep running,
// though your host's automatic backups or pg_dump are the better tool there.

// npm runs scripts from the server folder; INIT_CWD is the folder the owner typed the command in.
const startDir = process.env.INIT_CWD ?? process.cwd();

const now = new Date();
const target = process.argv[2]
  ? path.resolve(startDir, process.argv[2])
  : path.join(config.backupsDir, `costing-backup-${localToday(now)}-${localTimeStamp(now)}.json`);

if (!config.databaseUrl && !(await portIsFree(config.port, config.host))) {
  console.error('Stop the app first (close its window), then run the backup again. The built-in database can only be opened by one program at a time.');
  process.exit(1);
}

const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
await migrateOrStop(db, config.databaseUrl);
const data = await exportEverything(db);
await db.close();

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(data, null, 2), { mode: 0o600 });
console.log(`Backup saved to ${target}`);
console.log('It contains every business and every login (password hashes). Store it somewhere private and safe.');
