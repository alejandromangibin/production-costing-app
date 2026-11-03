import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index';
import { TENANT_TABLES, assertIsolation, scopedDb } from '../src/db/scoped';
import {
  type Agent,
  type App,
  at01Body,
  createBusiness,
  makeApp,
  makeCatalog,
  openTestDb,
  resetData,
  size,
} from './helpers';

let db: Db;
let app: App;
let A: Agent;
let B: Agent;
let aId: number;
let bId: number;

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Business A', 'owner@a.test');
  const b = await createBusiness(app, db, 'Business B', 'owner@b.test');
  [A, B, aId, bId] = [a.agent, b.agent, a.tenantId, b.tenantId];
});
afterAll(async () => {
  await db?.close();
});

describe('one business cannot see or change another', () => {
  it('starts every business empty and keeps lists apart', async () => {
    const ca = await makeCatalog(A);
    await A.post('/api/runs').send(at01Body(ca));

    expect((await B.get('/api/products')).body).toEqual([]);
    expect((await B.get('/api/products?includeInactive=1')).body).toEqual([]);
    expect((await B.get('/api/runs')).body).toEqual([]);
    expect((await B.get('/api/margins')).body).toEqual([]);
    expect((await B.get('/api/batches/expiry?today=2026-10-19')).body.batches).toEqual([]);
    // Long after A's batches have expired, so the expired half of the board is asked too.
    expect((await B.get('/api/batches/expiry?today=2030-01-01')).body.batches).toEqual([]);
    expect((await A.get('/api/batches/expiry?today=2030-01-01')).body.batches).toHaveLength(2);
    expect((await B.get('/api/runs/export.csv')).text.replace('﻿', '').trim().split('\r\n')).toHaveLength(1); // header only
    expect((await A.get('/api/products')).body).toHaveLength(2);
  });

  it("returns 'not found' for another business's records, never their contents", async () => {
    const ca = await makeCatalog(A);
    const run = (await A.post('/api/runs').send(at01Body(ca))).body;

    for (const call of [
      () => B.get(`/api/runs/${run.id}`),
      () => B.get(`/api/products/${ca.pork.id}`),
      () => B.post(`/api/runs/${run.id}/void`).send({ reason: 'hostile' }),
      () => B.patch(`/api/products/${ca.pork.id}`).send({ name: 'hacked' }),
    ]) {
      const r = await call();
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain('Pork');
    }

    // Nothing was changed.
    expect((await A.get(`/api/runs/${run.id}`)).body).toMatchObject({ status: 'saved', voidedByName: null });
    expect((await A.get(`/api/products/${ca.pork.id}`)).body.name).toBe('Pork Siomai');
  });

  it("cannot change another business's pack size or price", async () => {
    const ca = await makeCatalog(A);
    const r = await B.patch(`/api/pack-sizes/${size(ca.pork, 12).id}`).send({ retailPriceCents: 1 });
    expect(r.status).toBe(404);
    expect(size((await A.get(`/api/products/${ca.pork.id}`)).body, 12).retailPriceCents).toBe(7000);
    const add = await B.post(`/api/products/${ca.pork.id}/pack-sizes`).send({ piecesPerPack: 6, retailPriceCents: 100 });
    expect(add.status).toBe(404);
  });

  it("cannot record a run using another business's products or pack sizes", async () => {
    const ca = await makeCatalog(A);
    const cb = await makeCatalog(B);
    const stolenProduct = await B.post('/api/runs').send(at01Body(ca));
    expect(stolenProduct.status).toBe(400);
    expect(stolenProduct.body.error).toMatch(/no longer exists/);

    // B's own product with A's pack size.
    const mixed = at01Body(cb);
    (mixed.products[0] as any).packings = [{ packSizeId: size(ca.pork, 12).id, packs: 5 }];
    const r = await B.post('/api/runs').send(mixed);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not belong/);
    expect((await B.get('/api/runs')).body).toEqual([]);
    expect((await A.get('/api/runs')).body).toEqual([]);
  });

  it('lets two businesses use the same product codes and batch codes', async () => {
    const ca = await makeCatalog(A);
    const cb = await makeCatalog(B); // same PORK and JAP codes
    expect(cb.pork.code).toBe(ca.pork.code);
    const ra = (await A.post('/api/runs').send(at01Body(ca))).body;
    const rb = (await B.post('/api/runs').send(at01Body(cb))).body;
    expect(ra.products[0].batchCode).toBe('20261019-PORK');
    expect(rb.products[0].batchCode).toBe('20261019-PORK'); // not -2: other business's batches are invisible
    // But still unique within one business.
    const again = (await A.post('/api/runs').send(at01Body(ca))).body;
    expect(again.products[0].batchCode).toBe('20261019-PORK-2');
  });

  it("each business's reports use only its own runs", async () => {
    const ca = await makeCatalog(A);
    const cb = await makeCatalog(B);
    await A.post('/api/runs').send(at01Body(ca, '2026-10-01'));
    await B.patch(`/api/pack-sizes/${size(cb.pork, 12).id}`).send({ retailPriceCents: 9000 });
    await B.post('/api/runs').send(at01Body(cb, '2026-10-05'));
    const a = (await A.get('/api/margins')).body.find((r: any) => r.productCode === 'PORK');
    const b = (await B.get('/api/margins')).body.find((r: any) => r.productCode === 'PORK');
    expect(a.runDate).toBe('2026-10-01');
    expect(b.runDate).toBe('2026-10-05');
    expect(a.currentRetailPriceCents).toBe(7000);
    expect(b.currentRetailPriceCents).toBe(9000);
    expect((await A.get('/api/runs?q=20261005')).body).toEqual([]);
  });

  it('team lists and admin data stay inside the business', async () => {
    await A.post('/api/team').send({ email: 'staff@a.test', name: 'A Staff' }).expect(201);
    const team = (await B.get('/api/team')).body;
    expect(team.map((u: any) => u.email)).toEqual(['owner@b.test']);
  });
});

describe('the database itself enforces the wall', () => {
  it('a scoped handle sees only its own rows, whatever SQL it runs', async () => {
    await makeCatalog(A);
    await makeCatalog(B);
    const a = scopedDb(db, aId);
    for (const table of TENANT_TABLES) {
      const own = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      const foreign = await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id <> $1`, [aId]);
      expect(foreign.rows[0]!.n, table).toBe(0);
      expect(own.rows[0]!.n).toBeGreaterThanOrEqual(0);
    }
    expect((await a.query('SELECT * FROM products')).rows.every((r) => r.tenant_id === aId)).toBe(true);
    expect((await a.query('SELECT * FROM products WHERE 1=1 OR tenant_id = 99999')).rows.every((r) => r.tenant_id === aId)).toBe(true);
  });

  it("cannot write into, or move rows to, another business even with hand-written SQL", async () => {
    const ca = await makeCatalog(A);
    const b = scopedDb(db, bId);
    await expect(
      b.query(`INSERT INTO products (tenant_id, code, name, shelf_life_days) VALUES ($1, 'EVIL', 'forged', 1)`, [aId]),
    ).rejects.toThrow(/row-level security/);
    expect((await b.query(`UPDATE products SET name = 'hacked' WHERE id = $1 RETURNING id`, [ca.pork.id])).rows).toHaveLength(0);
    expect((await b.query(`DELETE FROM products WHERE id = $1`, [ca.pork.id]).catch(() => ({ rows: [] }))).rows).toHaveLength(0);
    // A row cannot be moved from one's own business to another.
    const own = (await makeCatalog(B)).pork;
    await expect(b.query(`UPDATE products SET tenant_id = $2 WHERE id = $1`, [own.id, aId])).rejects.toThrow(/row-level security/);
    expect((await A.get(`/api/products/${ca.pork.id}`)).body.name).toBe('Pork Siomai');
  });

  it('a request with no business set sees and writes nothing', async () => {
    await makeCatalog(A);
    const none = await db.tx(async (q) => {
      await q.exec('SET LOCAL ROLE costing_app');
      const seen = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM products');
      return seen.rows[0]!.n;
    });
    expect(none).toBe(0);
    await expect(
      db.tx(async (q) => {
        await q.exec('SET LOCAL ROLE costing_app');
        await q.query(`INSERT INTO products (code, name, shelf_life_days) VALUES ('X', 'X', 1)`);
      }),
    ).rejects.toThrow();
  });

  it('the app role cannot read accounts, sessions, links or payments', async () => {
    for (const table of ['users', 'tenants', 'sessions', 'user_tokens', 'payments']) {
      await expect(scopedDb(db, aId).query(`SELECT * FROM ${table}`), table).rejects.toThrow(/permission denied/);
    }
  });

  it('price history stays inside its business and can never be changed or deleted', async () => {
    const ca = await makeCatalog(A);
    const aSize = ca.pork.packSizes[0].id;
    // Another business gets "not found", never A's history.
    expect((await B.get(`/api/products/${ca.pork.id}/changes`)).status).toBe(404);
    // Hand-written SQL as business B can neither see A's history nor add to it.
    const b = scopedDb(db, bId);
    expect((await b.query<{ n: number }>('SELECT count(*)::int AS n FROM pack_size_changes')).rows[0]!.n).toBe(0);
    await expect(
      b.query(
        `INSERT INTO pack_size_changes (tenant_id, pack_size_id, kind, retail_price_cents, packaging_cost_cents, is_default, active)
         VALUES ($1, $2, 'updated', 1, 0, true, true)`,
        [aId, aSize],
      ),
    ).rejects.toThrow(/row-level security/);
    // Even the database owner cannot attach a change of business B to A's pack size (composite foreign key).
    await expect(
      db.query(
        `INSERT INTO pack_size_changes (tenant_id, pack_size_id, kind, retail_price_cents, packaging_cost_cents, is_default, active)
         VALUES ($1, $2, 'updated', 1, 0, true, true)`,
        [bId, aSize],
      ),
    ).rejects.toThrow(/foreign key/);
    // A's own history is append-only: the app role may not change or delete it.
    const a = scopedDb(db, aId);
    await expect(a.query(`UPDATE pack_size_changes SET retail_price_cents = 1`)).rejects.toThrow(/permission denied/);
    await expect(a.query(`DELETE FROM pack_size_changes`)).rejects.toThrow(/permission denied/);
    expect((await a.query<{ n: number }>('SELECT count(*)::int AS n FROM pack_size_changes')).rows[0]!.n).toBeGreaterThan(0);
  });

  it('the app role cannot delete business data at all', async () => {
    const ca = await makeCatalog(A);
    await expect(scopedDb(db, aId).query(`DELETE FROM products WHERE id = $1`, [ca.pork.id])).rejects.toThrow(/permission denied/);
  });

  it('even the database owner cannot link rows across businesses (composite foreign keys)', async () => {
    const ca = await makeCatalog(A);
    await A.post('/api/runs').send(at01Body(ca));
    // A pack size row of business B pointing at business A's product.
    await expect(
      db.query(
        `INSERT INTO pack_sizes (tenant_id, product_id, pieces_per_pack, retail_price_cents) VALUES ($1, $2, 6, 100)`,
        [bId, ca.pork.id],
      ),
    ).rejects.toThrow(/foreign key/);
    // A run of business B using business A's product.
    const run = await db.query(`INSERT INTO runs (tenant_id, run_date, total_cost_cents) VALUES ($1, '2026-10-19', 0) RETURNING id`, [bId]);
    await expect(
      db.query(
        `INSERT INTO run_products (tenant_id, run_id, product_id, product_code, product_name, loose_pieces, rejected_pieces, packed_pieces,
           pieces_made, good_pieces, shared_share_cents, specific_cents, packaging_cents, total_cost_cents, cost_per_good_piece,
           batch_code, production_date, expiry_date)
         VALUES ($1, $2, $3, 'X', 'X', 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 'X-1', '2026-10-19', '2026-10-20')`,
        [bId, run.rows[0]!.id, ca.pork.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('startup check passes now, and fails loudly if row-level security is switched off', async () => {
    await expect(assertIsolation(db)).resolves.toBeUndefined();
    await db.exec('ALTER TABLE runs DISABLE ROW LEVEL SECURITY');
    try {
      await expect(assertIsolation(db)).rejects.toThrow(/Row-level security is not switched on for: runs/);
    } finally {
      await db.exec('ALTER TABLE runs ENABLE ROW LEVEL SECURITY');
    }
    await expect(assertIsolation(db)).resolves.toBeUndefined();
  });
});
