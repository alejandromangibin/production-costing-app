import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toSafeInteger } from '../src/calc/stock';
import { serverDir } from '../src/config';
import type { Db } from '../src/db/index';
import { assertIsolation, scopedDb } from '../src/db/scoped';
import { type Agent, type App, createBusiness, makeApp, openTestDb, resetData } from './helpers';

/**
 * What only a real PostgreSQL server can show (task P4-40). Skipped in the normal test run; `npm run
 * test:postgres` runs it, along with every other test, against the separate test database.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('on a real PostgreSQL server', () => {
  let db: Db;
  let app: App;
  let owner: Agent;
  let tenantId: number;

  beforeAll(async () => {
    db = await openTestDb();
    app = makeApp(db);
  });
  beforeEach(async () => {
    await resetData(db);
    const business = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    [owner, tenantId] = [business.agent, business.tenantId];
  });
  afterAll(async () => {
    await db?.close();
  });

  it('is PostgreSQL 16, the version the host runs, with UTF8 text', async () => {
    const version = (await db.query<{ server_version: string }>('SHOW server_version')).rows[0]!.server_version;
    expect(version).toMatch(/^16\./);
    expect((await db.query<{ server_encoding: string }>('SHOW server_encoding')).rows[0]!.server_encoding).toBe('UTF8');
  });

  it('connects as a plain owner, so nothing here skips the separation between businesses', async () => {
    const me = (await db.query<any>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    expect(me).toEqual({ rolsuper: false, rolbypassrls: false });
    const appRole = (await db.query<any>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'costing_app'`)).rows[0];
    expect(appRole).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });

  it('passes the start-up check', async () => {
    await expect(assertIsolation(db)).resolves.toBeUndefined();
  });

  it('hands bigint and sum values back as text, which the app turns into exact numbers', async () => {
    const id = (await owner.post('/api/ingredients').send({ name: 'Soy sauce', baseUnit: 'mL' }).expect(201)).body.id;
    for (let i = 0; i < 2; i++) {
      await owner.post(`/api/ingredients/${id}/purchases`).send({ effectiveDate: '2026-01-01', quantity: '10000000', unit: 'mL', totalCostCents: 1000 }).expect(201);
    }
    const r = (await scopedDb(db, tenantId).query<any>(
      `SELECT on_hand_milli, avg_cost_e4, (SELECT sum(quantity_milli) FROM stock_movements) AS total FROM ingredients WHERE id = $1`,
      [id],
    )).rows[0];
    expect([typeof r.on_hand_milli, typeof r.avg_cost_e4, typeof r.total]).toEqual(['string', 'string', 'string']);
    expect(toSafeInteger(r.total)).toBe(20_000_000_000);
    const shown = (await owner.get(`/api/ingredients/${id}`)).body;
    expect(shown).toMatchObject({ onHandMilli: 20_000_000_000, avgCostE4: 1 });
  });

  it('gives the plain name-clash message through the real driver', async () => {
    await owner.post('/api/ingredients').send({ name: 'Soy sauce', baseUnit: 'mL' }).expect(201);
    const r = await owner.post('/api/ingredients').send({ name: 'SOY SAUCE', baseUnit: 'mL' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('There is already an ingredient called SOY SAUCE. It may be archived.');
  });

  it('treats accented capitals as the same name', async () => {
    const locale = (await db.query<{ datctype: string }>('SELECT datctype FROM pg_database WHERE datname = current_database()')).rows[0]!.datctype;
    await owner.post('/api/ingredients').send({ name: 'Piña', baseUnit: 'g' }).expect(201);
    expect((await owner.post('/api/ingredients').send({ name: 'PIÑA', baseUnit: 'g' })).status, `database locale: ${locale}`).toBe(400);
  });

  it('stores emoji and Japanese text', async () => {
    const r = await owner.post('/api/ingredients').send({ name: '醤油 🌶', baseUnit: 'mL' }).expect(201);
    expect((await owner.get(`/api/ingredients/${r.body.id}`)).body.name).toBe('醤油 🌶');
  });

  it('backs up and restores from the command line', async () => {
    const id = (await owner.post('/api/ingredients').send({ name: 'Vinegar', baseUnit: 'mL' }).expect(201)).body.id;
    await owner.post(`/api/ingredients/${id}/purchases`).send({ effectiveDate: '2026-01-01', quantity: '100', unit: 'mL', totalCostCents: 1000 }).expect(201);

    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'costing-pg-'));
    const file = path.join(scratch, 'backup.json');
    const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL!, INIT_CWD: scratch };
    const run = (script: string, ...args: string[]) =>
      spawnSync(process.execPath, [tsx, script, ...args], { cwd: serverDir, env, encoding: 'utf8', timeout: 60_000 });
    try {
      const backup = run('src/scripts/backup.ts', file);
      expect(backup.status, backup.stderr).toBe(0);
      await scopedDb(db, tenantId).query(`UPDATE ingredients SET name = 'Changed' WHERE id = $1`, [id]);
      const restore = run('src/scripts/restore.ts', file, '--yes');
      expect(restore.status, restore.stderr).toBe(0);
      const row = (await scopedDb(db, tenantId).query<any>('SELECT name, on_hand_milli FROM ingredients WHERE id = $1', [id])).rows[0];
      expect(row.name).toBe('Vinegar');
      expect(toSafeInteger(row.on_hand_milli)).toBe(100_000);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 150_000);
});
