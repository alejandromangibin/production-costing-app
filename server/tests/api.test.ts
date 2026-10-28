import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportEverything, importEverything } from '../src/backup';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { expiryBoard } from '../src/services/reports';
import {
  type Agent,
  type App,
  at01Body,
  createBusiness,
  makeApp,
  makeCatalog as makeCatalogFor,
  openTestDb,
  resetData,
  size,
} from './helpers';

let db: Db;
let app: App;
let api: Agent;
let tenantId: number;

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  ({ agent: api, tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test'));
});
afterAll(async () => {
  await db?.close();
});

const makeCatalog = () => makeCatalogFor(api);

describe('products', () => {
  it('creates products with an upper-cased code and a default pack size', async () => {
    const { pork, jap } = await makeCatalog();
    expect(pork.code).toBe('PORK');
    expect(pork.packSizes).toHaveLength(1);
    expect(pork.packSizes[0].isDefault).toBe(true);
    expect(jap.packSizes.filter((s: any) => s.isDefault)).toHaveLength(1);
  });

  it('rejects a duplicate code and a duplicate pack size', async () => {
    await makeCatalog();
    const dup = await api.post('/api/products').send({ code: 'PORK', name: 'Other', shelfLifeDays: 30 });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/already used/);

    const { pork } = (await api.get('/api/products')).body.reduce((a: any, p: any) => ({ ...a, [p.code.toLowerCase()]: p }), {});
    const again = await api.post(`/api/products/${pork.id}/pack-sizes`).send({ piecesPerPack: 12, retailPriceCents: 8000 });
    expect(again.status).toBe(400);
  });

  it('validates input with a readable message', async () => {
    const r = await api.post('/api/products').send({ code: 'bad code!', name: '', shelfLifeDays: -1 });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
  });

  it('moves the default pack size and archives', async () => {
    const { jap } = await makeCatalog();
    const twenty = size(jap, 20);
    const updated = (await api.patch(`/api/pack-sizes/${twenty.id}`).send({ isDefault: true })).body;
    expect(updated.packSizes.find((s: any) => s.isDefault).piecesPerPack).toBe(20);
    const archived = (await api.patch(`/api/pack-sizes/${twenty.id}`).send({ active: false })).body;
    // Archived sizes stay listed (so they can be turned back on) but can no longer be the default.
    expect(archived.packSizes.find((s: any) => s.piecesPerPack === 20)).toMatchObject({ active: false, isDefault: false });
    expect(archived.packSizes.find((s: any) => s.isDefault).piecesPerPack).toBe(12);
    const listed = (await api.get('/api/products')).body.find((p: any) => p.id === jap.id);
    expect(listed.packSizes.map((s: any) => s.piecesPerPack)).toEqual([12]);
  });
});

describe('runs', () => {
  it('previews AT-01 without saving anything', async () => {
    const c = await makeCatalog();
    const r = await api.post('/api/runs/preview').send(at01Body(c));
    expect(r.status).toBe(200);
    expect(r.body.result.totalCostCents).toBe(379200);
    expect(r.body.result.products[0].packings[0].packCostCents).toBe(3915);
    expect(r.body.products[0].batchCode).toBe('20261019-PORK');
    expect((await api.get('/api/runs')).body).toHaveLength(0);
  });

  it('saves AT-01 and returns the full run', async () => {
    const c = await makeCatalog();
    const r = await api.post('/api/runs').send(at01Body(c));
    expect(r.status).toBe(201);
    expect(r.body.totalCostCents).toBe(379200);
    const [pork, jap] = r.body.products;
    expect(pork.batchCode).toBe('20261019-PORK');
    expect(pork.expiryDate).toBe('2027-01-17'); // 90 days after 2026-10-19
    expect(jap.expiryDate).toBe('2026-12-18'); // 60 days
    expect(jap.packings.map((k: any) => k.packCostCents).sort()).toEqual([4890, 8017]);
    expect(r.body.costs).toHaveLength(2);
    expect(r.body.costs[1].targetRunProductIds).toEqual([jap.id]);
  });

  it('adds a numeric suffix to a second batch of the same product on the same day', async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c));
    const second = await api.post('/api/runs').send(at01Body(c));
    expect(second.body.products.map((p: any) => p.batchCode)).toEqual(['20261019-PORK-2', '20261019-JAP-2']);
    const preview = await api.post('/api/runs/preview').send(at01Body(c));
    expect(preview.body.products[0].batchCode).toBe('20261019-PORK-3');
  });

  it('lets the production and expiry dates be changed, and rejects expiry before production', async () => {
    const c = await makeCatalog();
    const body = at01Body(c);
    (body.products[0] as any).productionDate = '2026-10-20';
    (body.products[0] as any).expiryDate = '2026-11-20';
    const ok = await api.post('/api/runs').send(body);
    expect(ok.body.products[0].batchCode).toBe('20261020-PORK');
    expect(ok.body.products[0].expiryDate).toBe('2026-11-20');

    (body.products[0] as any).expiryDate = '2026-10-01';
    const bad = await api.post('/api/runs').send(body);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/expiry date cannot be earlier/);
  });

  it('explains problems with the numbers and saves nothing', async () => {
    const c = await makeCatalog();
    const body = at01Body(c);
    (body.products[0] as any).rejectedPieces = 9999;
    (body.products[0] as any).packings = [];
    (body.products[0] as any).loosePieces = 0;
    const r = await api.post('/api/runs').send(body);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/good piece/);
    expect((await api.get('/api/runs')).body).toHaveLength(0);
  });

  it('rejects a pack size that belongs to another product', async () => {
    const c = await makeCatalog();
    const body = at01Body(c);
    (body.products[0] as any).packings = [{ packSizeId: size(c.jap, 12).id, packs: 1 }];
    const r = await api.post('/api/runs').send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not belong/);
  });

  it('keeps saved figures after a price change', async () => {
    const c = await makeCatalog();
    const saved = (await api.post('/api/runs').send(at01Body(c))).body;
    await api.patch(`/api/pack-sizes/${size(c.pork, 12).id}`).send({ retailPriceCents: 9900, packagingCostCents: 900 });
    const again = (await api.get(`/api/runs/${saved.id}`)).body;
    expect(again.products[0].packings[0].retailPriceCents).toBe(7000);
    expect(again.products[0].packings[0].packCostCents).toBe(3915);
    expect(again.totalCostCents).toBe(379200);
  });

  it('keeps old runs readable after a product is renamed or archived', async () => {
    const c = await makeCatalog();
    const saved = (await api.post('/api/runs').send(at01Body(c))).body;
    await api.patch(`/api/products/${c.pork.id}`).send({ name: 'Renamed', active: false });
    const again = (await api.get(`/api/runs/${saved.id}`)).body;
    expect(again.products[0].productName).toBe('Pork Siomai');
    const blocked = await api.post('/api/runs').send(at01Body(c));
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/archived/);
  });

  it('voids a run and keeps it out of reports', async () => {
    const c = await makeCatalog();
    const saved = (await api.post('/api/runs').send(at01Body(c))).body;

    expect((await api.get('/api/margins')).body.length).toBe(3);
    expect((await api.get('/api/batches/expiry?today=2026-10-19')).body.batches).toHaveLength(2);

    const noReason = await api.post(`/api/runs/${saved.id}/void`).send({});
    expect(noReason.status).toBe(400);

    const v = await api.post(`/api/runs/${saved.id}/void`).send({ reason: 'Entered by mistake' });
    expect(v.body.status).toBe('void');
    expect(v.body.voidReason).toBe('Entered by mistake');
    expect((await api.post(`/api/runs/${saved.id}/void`).send({ reason: 'again' })).status).toBe(409);

    expect((await api.get('/api/margins')).body).toHaveLength(0);
    expect((await api.get('/api/batches/expiry?today=2026-10-19')).body.batches).toHaveLength(0);
    // Still in history, marked void.
    expect((await api.get('/api/runs?status=void')).body).toHaveLength(1);
  });

  it('filters history by date, product, status and search text', async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c, '2026-10-01'));
    const onlyPork = {
      runDate: '2026-10-15',
      note: 'weekend rush',
      products: [{ productId: c.pork.id, loosePieces: 0, rejectedPieces: 0, packings: [{ packSizeId: size(c.pork, 12).id, packs: 10 }] }],
      costs: [{ category: 'ingredient', description: 'all', amountCents: 50000, scope: 'shared' }],
    };
    await api.post('/api/runs').send(onlyPork);

    expect((await api.get('/api/runs')).body.map((r: any) => r.runDate)).toEqual(['2026-10-15', '2026-10-01']);
    expect((await api.get('/api/runs?from=2026-10-10')).body).toHaveLength(1);
    expect((await api.get('/api/runs?to=2026-10-10')).body).toHaveLength(1);
    expect((await api.get(`/api/runs?productId=${c.jap.id}`)).body).toHaveLength(1);
    expect((await api.get('/api/runs?q=rush')).body).toHaveLength(1);
    expect((await api.get('/api/runs?q=japanese')).body).toHaveLength(1);
    expect((await api.get('/api/runs?q=20261001-JAP')).body).toHaveLength(1);
    expect((await api.get('/api/runs?q=%25')).body).toHaveLength(0);
    expect((await api.get('/api/runs?from=2026-13-40')).status).toBe(400);
  });
});

describe('reports', () => {
  it('sorts the expiry list soonest first and counts the days left', async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c, '2026-10-01'));
    const r = (await api.get('/api/batches/expiry?today=2026-11-01')).body;
    expect(r.batches.map((b: any) => b.productName)).toEqual(['Japanese Siomai', 'Pork Siomai']);
    expect(r.batches[0].expiryDate).toBe('2026-11-30');
    expect(r.batches[0].daysRemaining).toBe(29);
    expect((await api.get('/api/batches/expiry?today=2027-01-01')).body.batches[0].daysRemaining).toBe(-32);
    expect(r).toMatchObject({ moreCurrent: false, moreExpired: false });
  });

  it('keeps current batches on the expiry board however many batches have expired', async () => {
    const c = await makeCatalog();
    // Six batches that have expired by Nov 1 (Mar 2 to May 30), and two current ones (Nov 30, Dec 30).
    for (const day of ['2026-01-01', '2026-02-01', '2026-03-01', '2026-10-01']) {
      await api.post('/api/runs').send(at01Body(c, day)).expect(201);
    }
    const tdb = scopedDb(db, tenantId);

    const fewExpired = await expiryBoard(tdb, '2026-11-01', { current: 500, expired: 2 });
    expect(fewExpired.batches.map((b: any) => b.expiryDate)).toEqual(['2026-05-02', '2026-05-30', '2026-11-30', '2026-12-30']);
    expect(fewExpired).toMatchObject({ moreCurrent: false, moreExpired: true });

    const fewCurrent = await expiryBoard(tdb, '2026-11-01', { current: 1, expired: 100 });
    expect(fewCurrent.batches.map((b: any) => b.expiryDate)).toEqual([
      '2026-03-02', '2026-04-01', '2026-04-02', '2026-04-30', '2026-05-02', '2026-05-30', '2026-11-30',
    ]);
    expect(fewCurrent).toMatchObject({ moreCurrent: true, moreExpired: false });

    // A batch expiring today counts as current, and appears once.
    const onTheDay = await expiryBoard(tdb, '2026-11-30');
    expect(onTheDay.batches.map((b: any) => [b.expiryDate, b.daysRemaining])).toEqual([
      ['2026-03-02', -273], ['2026-04-01', -243], ['2026-04-02', -242], ['2026-04-30', -214], ['2026-05-02', -212], ['2026-05-30', -184],
      ['2026-11-30', 0], ['2026-12-30', 30],
    ]);

    // The API gives the same board.
    const viaApi = (await api.get('/api/batches/expiry?today=2026-11-30')).body;
    expect(viaApi.batches.map((b: any) => b.expiryDate)).toEqual(onTheDay.batches.map((b: any) => b.expiryDate));
    expect(viaApi).toMatchObject({ today: '2026-11-30', moreCurrent: false, moreExpired: false });
  });

  it('margins view uses the latest saved run and the current price', async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c, '2026-10-01'));
    await api.patch(`/api/pack-sizes/${size(c.pork, 12).id}`).send({ retailPriceCents: 10000 });
    const rows = (await api.get('/api/margins')).body;
    const pork = rows.find((r: any) => r.productCode === 'PORK');
    expect(pork.packCostCents).toBe(3915);
    expect(pork.runMarginPct).toBeCloseTo(44.1, 1);
    expect(pork.currentRetailPriceCents).toBe(10000);
    expect(pork.currentMarginPct).toBeCloseTo(60.85, 1);
  });

  it('exports history as CSV with one row per pack size', async () => {
    const c = await makeCatalog();
    const body = at01Body(c);
    body.note = '=HYPERLINK("http://x")';
    await api.post('/api/runs').send(body);
    const r = await api.get('/api/runs/export.csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const lines = r.text.replace('﻿', '').trim().split('\r\n');
    expect(lines).toHaveLength(1 + 3);
    expect(lines[0]).toContain('Cost per pack (PHP)');
    expect(r.text).toContain('39.15');
    expect(r.text).toContain('80.17');
    expect(r.text).toContain(`"'=HYPERLINK`);
  });
});

describe('business export and operator backup', () => {
  it("lets a business download its own data, and only its own", async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c));
    const other = (await createBusiness(app, db, 'Other Cafe', 'owner@b.test')).agent;
    await other.post('/api/products').send({ code: 'LATTE', name: 'Latte Mix', shelfLifeDays: 30 });

    const mine = (await api.get('/api/export')).body;
    expect(mine.app).toBe('production-costing');
    expect(mine.tables.products.map((p: any) => p.code).sort()).toEqual(['JAP', 'PORK']);
    expect(mine.tables.runs).toHaveLength(1);
    expect(mine.tables.users).toBeUndefined();
    expect(JSON.stringify(mine)).not.toContain('LATTE');

    const theirs = (await other.get('/api/export')).body;
    expect(theirs.tables.products.map((p: any) => p.code)).toEqual(['LATTE']);
    expect(theirs.tables.runs).toHaveLength(0);
  });

  it('restores a full backup exactly, ends all logins, and keeps numbering going', async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c));
    const backup = await exportEverything(db);

    // Make a mess, then restore.
    await api.post('/api/runs').send(at01Body(c, '2026-11-01'));
    await api.post('/api/products').send({ code: 'XTRA', name: 'Extra', shelfLifeDays: 10 });

    const counts = await importEverything(db, backup);
    expect(counts.runs).toBe(1);
    expect({ ...(await exportEverything(db)), exportedAt: '' }).toEqual({ ...backup, exportedAt: '' });

    // Sessions are not part of a backup: everyone has to log in again.
    expect((await api.get('/api/runs')).status).toBe(401);
    expect(db.kind).toBeTruthy();
  });

  it('refuses a business export, a foreign file, and a backup from another database version', async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c));
    const businessExport = (await api.get('/api/export')).body;
    await expect(importEverything(db, businessExport)).rejects.toThrow(/missing the "tenants" table|database version/);
    await expect(importEverything(db, { hello: 'world' })).rejects.toThrow(/not a Production Costing backup/);

    const full = await exportEverything(db);
    await expect(importEverything(db, { ...full, schema: '000_old.sql' })).rejects.toThrow(/database version/);
    // Nothing was changed by the refusals.
    expect((await api.get('/api/runs')).body).toHaveLength(1);
  });

  it('a damaged backup rolls back and leaves current data alone', async () => {
    const c = await makeCatalog();
    await api.post('/api/runs').send(at01Body(c));
    const backup = await exportEverything(db);
    backup.tables.run_products![0]!.expiry_date = '1999-01-01'; // before production date: breaks a rule
    await expect(importEverything(db, backup)).rejects.toThrow();
    expect((await api.get('/api/runs')).body).toHaveLength(1);
    expect((await api.get('/api/runs/1')).body.totalCostCents).toBe(379200);
  });
});

describe('server basics', () => {
  it('reports health and gives clean errors', async () => {
    expect((await api.get('/api/health')).body).toEqual({ ok: true, database: db.kind });
    expect((await api.get('/api/runs/abc')).status).toBe(400);
    expect((await api.get('/api/runs/9999')).status).toBe(404);
    expect((await api.get('/api/nothing')).status).toBe(404);
    const bad = await api.post('/api/runs').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
  });
});
