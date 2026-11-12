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

  describe('ingredient inventory tables (database change 005)', () => {
    const owner = `1, 'Owner'`;
    const addIngredient = async (h: Db, name = 'Pork') =>
      (
        await h.query<{ id: number }>(
          `INSERT INTO ingredients (name, base_unit, created_by_user_id, created_by_name) VALUES ($1, 'g', ${owner}) RETURNING id`,
          [name],
        )
      ).rows[0]!.id;
    const addPurchase = async (h: Db, ingredientId: number) =>
      (
        await h.query<{ id: number }>(
          `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, total_cost_cents, entered_by_user_id, entered_by_name)
           VALUES ($1, 'purchase', '2026-11-01', 1000, 100, ${owner}) RETURNING id`,
          [ingredientId],
        )
      ).rows[0]!.id;
    const count = async (h: Db, table: string) => (await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

    it('business_settings: another business cannot read or write it', async () => {
      const [a, b] = [scopedDb(db, aId), scopedDb(db, bId)];
      await a.query('INSERT INTO business_settings DEFAULT VALUES');
      expect(await count(b, 'business_settings')).toBe(0);
      await expect(b.query('INSERT INTO business_settings (tenant_id) VALUES ($1)', [aId])).rejects.toThrow(/row-level security/);
      const changed = await b.query(
        `UPDATE business_settings SET inventory_live_since = '2026-11-04', live_set_by_user_id = 1, live_set_by_name = 'x', live_set_at = now() RETURNING id`,
      );
      expect(changed.rows).toHaveLength(0);
      // Each business has its own row: B's does not collide with A's.
      await b.query('INSERT INTO business_settings DEFAULT VALUES');
      expect(await count(a, 'business_settings')).toBe(1);
      expect((await a.query<any>('SELECT inventory_live_since FROM business_settings')).rows[0].inventory_live_since).toBeNull();
    });

    it('ingredients: not visible across businesses, no writing for another, and names are unique per business', async () => {
      const [a, b] = [scopedDb(db, aId), scopedDb(db, bId)];
      const pork = await addIngredient(a);
      expect(await count(b, 'ingredients')).toBe(0);
      expect((await b.query('SELECT id FROM ingredients WHERE id = $1', [pork])).rows).toHaveLength(0);
      await expect(
        b.query(`INSERT INTO ingredients (tenant_id, name, base_unit, created_by_user_id, created_by_name) VALUES ($1, 'Forged', 'g', ${owner})`, [aId]),
      ).rejects.toThrow(/row-level security/);
      expect((await b.query(`UPDATE ingredients SET name = 'hacked' WHERE id = $1 RETURNING id`, [pork])).rows).toHaveLength(0);
      // The same name is fine in another business, and a row cannot be moved to one.
      const bPork = await addIngredient(b);
      expect(bPork).not.toBe(pork);
      await expect(b.query('UPDATE ingredients SET tenant_id = $2 WHERE id = $1', [bPork, aId])).rejects.toThrow(/row-level security/);
      expect((await a.query<{ name: string }>('SELECT name FROM ingredients')).rows).toEqual([{ name: 'Pork' }]);
    });

    it('stock_movements: not visible across businesses, and row-level security alone stops writing for another', async () => {
      const [a, b] = [scopedDb(db, aId), scopedDb(db, bId)];
      const pork = await addIngredient(a);
      const line = await addPurchase(a, pork);
      expect(await count(b, 'stock_movements')).toBe(0);
      expect((await b.query('SELECT id FROM stock_movements WHERE id = $1 OR 1 = 1', [line])).rows).toHaveLength(0);
      await expect(
        b.query(
          `INSERT INTO stock_movements (tenant_id, ingredient_id, kind, effective_date, quantity_milli, total_cost_cents, entered_by_user_id, entered_by_name)
           VALUES ($1, $2, 'purchase', '2026-11-01', 1000, 100, ${owner})`,
          [aId, pork],
        ),
      ).rejects.toThrow(/row-level security/);
      // Correcting a line of another business finds nothing to change.
      expect((await b.query(`UPDATE stock_movements SET supplier = 'hacked' WHERE id = $1 RETURNING id`, [line])).rows).toHaveLength(0);
      // B cannot attach its own line to A's ingredient either: it cannot see it, and the link stays in one business.
      await expect(addPurchase(b, pork)).rejects.toThrow(/foreign key/);
      expect((await a.query<{ supplier: string }>('SELECT supplier FROM stock_movements')).rows).toEqual([{ supplier: '' }]);
    });

    it('stock_movements: even the table owner cannot link a line to another business', async () => {
      const [a, b] = [scopedDb(db, aId), scopedDb(db, bId)];
      const ca = await makeCatalog(A);
      const run = (await A.post('/api/runs').send(at01Body(ca))).body.id;
      const runCost = (await a.query<{ id: number }>('SELECT id FROM run_costs WHERE run_id = $1 LIMIT 1', [run])).rows[0]!.id;
      const aPork = await addIngredient(a);
      const aLine = await addPurchase(a, aPork);
      const bPork = await addIngredient(b);
      const cb = await makeCatalog(B);
      const bRun = (await B.post('/api/runs').send(at01Body(cb))).body.id;
      const bRunCost = (await b.query<{ id: number }>('SELECT id FROM run_costs WHERE run_id = $1 LIMIT 1', [bRun])).rows[0]!.id;

      // A line of business B pointing at A's ingredient, run, run line and reversed line.
      const columns = `tenant_id, ingredient_id, kind, effective_date, quantity_milli, entered_by_user_id, entered_by_name`;
      await expect(
        db.query(
          `INSERT INTO stock_movements (${columns}, total_cost_cents) VALUES ($1, $2, 'purchase', '2026-11-01', 1000, ${owner}, 100)`,
          [bId, aPork],
        ),
      ).rejects.toThrow(/stock_movements_same_tenant_ingredient/);
      await expect(
        db.query(
          `INSERT INTO stock_movements (${columns}, run_id, run_cost_id, unit_cost_e4) VALUES ($1, $2, 'run_use', '2026-11-01', -1000, ${owner}, $3, $4, 1)`,
          [bId, bPork, run, runCost],
        ),
      ).rejects.toThrow(/stock_movements_same_(tenant_run|run_cost)/);
      // B's own run with A's run line: only the run-line key can stop this one.
      await expect(
        db.query(
          `INSERT INTO stock_movements (${columns}, run_id, run_cost_id, unit_cost_e4) VALUES ($1, $2, 'run_use', '2026-11-01', -1000, ${owner}, $3, $4, 1)`,
          [bId, bPork, bRun, runCost],
        ),
      ).rejects.toThrow(/stock_movements_same_run_cost/);
      // A's run with B's own run line.
      await expect(
        db.query(
          `INSERT INTO stock_movements (${columns}, run_id, run_cost_id, unit_cost_e4) VALUES ($1, $2, 'run_use', '2026-11-01', -1000, ${owner}, $3, $4, 1)`,
          [bId, bPork, run, bRunCost],
        ),
      ).rejects.toThrow(/stock_movements_same_(tenant_run|run_cost)/);
      await expect(
        db.query(
          `INSERT INTO stock_movements (${columns}, reason, reverses_movement_id) VALUES ($1, $2, 'purchase_reversal', '2026-11-01', -1000, ${owner}, 'x', $3)`,
          [bId, bPork, aLine],
        ),
      ).rejects.toThrow(/stock_movements_same_ingredient_reversal/);
    });

    it('purchase_detail_changes: not visible across businesses, and cannot be linked to another business', async () => {
      const [a, b] = [scopedDb(db, aId), scopedDb(db, bId)];
      const line = await addPurchase(a, await addIngredient(a));
      const add = `(tenant_id, movement_id, supplier, reference, changed_by_user_id, changed_by_name) VALUES ($1, $2, '', '', ${owner})`;
      await a.query(`INSERT INTO purchase_detail_changes ${add}`, [aId, line]);
      expect(await count(b, 'purchase_detail_changes')).toBe(0);
      await expect(b.query(`INSERT INTO purchase_detail_changes ${add}`, [aId, line])).rejects.toThrow(/row-level security/);
      // Even the table owner cannot attach business B's row to A's ledger line.
      await expect(db.query(`INSERT INTO purchase_detail_changes ${add}`, [bId, line])).rejects.toThrow(
        /purchase_detail_changes_same_tenant_movement/,
      );
    });

    it("purchase details (INV-17): another business cannot correct them, even with no business filter in the statement", async () => {
      const [a, b] = [scopedDb(db, aId), scopedDb(db, bId)];
      const ingredientOfA = await addIngredient(a);
      const line = await addPurchase(a, ingredientOfA);
      // No WHERE on the business at all: only row-level security stands in the way, and it hides A's line from B.
      const changed = await b.query(`UPDATE stock_movements SET supplier = 'Hacked', reference = 'Hacked', expiry_date = '2027-01-01' RETURNING id`);
      expect(changed.rows).toEqual([]);
      const byId = await b.query(`UPDATE stock_movements SET supplier = 'Hacked' WHERE id = $1 RETURNING id`, [line]);
      expect(byId.rows).toEqual([]);
      // With no business set at all, the app role changes nothing either.
      const noBusiness = await db.tx(async (q) => {
        await q.exec('SET LOCAL ROLE costing_app');
        return q.query(`UPDATE stock_movements SET supplier = 'Hacked' RETURNING id`);
      });
      expect(noBusiness.rows).toEqual([]);
      expect((await a.query<{ supplier: string }>('SELECT supplier FROM stock_movements WHERE id = $1', [line])).rows[0]!.supplier).toBe('');
      // B cannot read A's correction history with no filter either.
      await a.query(`INSERT INTO purchase_detail_changes (movement_id, supplier, reference, changed_by_user_id, changed_by_name) VALUES ($1, '', '', ${owner})`, [line]);
      expect((await b.query('SELECT id FROM purchase_detail_changes')).rows).toEqual([]);
      // Through the app: B's owner is told the line does not exist.
      expect((await B.patch(`/api/ingredients/${ingredientOfA}/movements/${line}/details`).send({ supplier: 'Hacked', reference: '', expiryDate: null })).status).toBe(404);
    });

    it('with no business set, nothing in the new tables can be seen or added', async () => {
      const a = scopedDb(db, aId);
      await a.query('INSERT INTO business_settings DEFAULT VALUES');
      const pork = await addIngredient(a);
      const line = await addPurchase(a, pork);
      await a.query(
        `INSERT INTO purchase_detail_changes (movement_id, supplier, reference, changed_by_user_id, changed_by_name) VALUES ($1, '', '', ${owner})`,
        [line],
      );
      const inserts = [
        'INSERT INTO business_settings DEFAULT VALUES',
        `INSERT INTO ingredients (name, base_unit, created_by_user_id, created_by_name) VALUES ('X', 'g', ${owner})`,
        `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, total_cost_cents, entered_by_user_id, entered_by_name)
         VALUES (${pork}, 'purchase', '2026-11-01', 1000, 100, ${owner})`,
        `INSERT INTO purchase_detail_changes (movement_id, supplier, reference, changed_by_user_id, changed_by_name) VALUES (${line}, '', '', ${owner})`,
      ];
      const tables = ['business_settings', 'ingredients', 'stock_movements', 'purchase_detail_changes'];
      for (const [i, table] of tables.entries()) {
        expect(await count(a, table), table).toBe(1);
        const seen = await db.tx(async (q) => {
          await q.exec('SET LOCAL ROLE costing_app');
          return (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
        });
        expect(seen, table).toBe(0);
        await expect(
          db.tx(async (q) => {
            await q.exec('SET LOCAL ROLE costing_app');
            await q.query(inserts[i]!);
          }),
          table,
        ).rejects.toThrow(/row-level security/);
      }
    });

    it("a business's own download holds its stock rows and no other business's", async () => {
      const [a, b] = [scopedDb(db, aId), scopedDb(db, bId)];
      await addPurchase(a, await addIngredient(a));
      await addPurchase(b, await addIngredient(b, 'Other'));
      const body = (await A.get('/api/export')).body;
      expect(body.tables.ingredients.map((i: any) => i.tenant_id)).toEqual([aId]);
      expect(body.tables.stock_movements.map((m: any) => m.tenant_id)).toEqual([aId]);
    });
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

  it('startup check fails loudly if a policy on any business table lets everything through', async () => {
    const policy = `NULLIF(current_setting('app.tenant_id', true), '')::int`;
    await scopedDb(db, aId).query(
      `INSERT INTO ingredients (name, base_unit, created_by_user_id, created_by_name) VALUES ('Pork', 'g', 1, 'Owner')`,
    );
    await expect(assertIsolation(db)).resolves.toBeUndefined();
    await db.exec('ALTER POLICY tenant_isolation ON ingredients USING (true)');
    try {
      await expect(assertIsolation(db)).rejects.toThrow(/can see ingredients/);
    } finally {
      await db.exec(`ALTER POLICY tenant_isolation ON ingredients USING (tenant_id = ${policy})`);
    }
    await expect(assertIsolation(db)).resolves.toBeUndefined();
  });
});
