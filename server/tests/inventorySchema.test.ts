import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportEverything, importEverything } from '../src/backup';
import { toSafeInteger } from '../src/calc/stock';
import type { Db, Queryable } from '../src/db/index';
import { TENANT_TABLES, scopedDb } from '../src/db/scoped';
import { type Agent, type App, at01Body, createBusiness, makeApp, makeCatalog, openTestDb, resetData } from './helpers';

/** Database change 005 (design note section 1): what the tables themselves refuse, whatever the code does. */

let db: Db;
let app: App;
let agent: Agent;
let catalog: Awaited<ReturnType<typeof makeCatalog>>;
let tenantId: number;
let scoped: Db;
let ingredientId: number;
let runId: number;
let runCostId: number;

type Fields = Record<string, unknown>;

/** Insert a row from column names and values; nothing about the row is hidden in a default. */
async function insert(q: Pick<Queryable, 'query'>, table: string, fields: Fields) {
  const cols = Object.keys(fields);
  const marks = cols.map((_, i) => `$${i + 1}`).join(', ');
  const values = cols.length ? `(${cols.join(', ')}) VALUES (${marks})` : 'DEFAULT VALUES';
  const r = await q.query<{ id: number }>(`INSERT INTO ${table} ${values} RETURNING id`, Object.values(fields) as any[]);
  return r.rows[0]!.id;
}

const who = { entered_by_user_id: 1, entered_by_name: 'Owner' };
const base = () => ({ ingredient_id: ingredientId, effective_date: '2026-11-01', ...who });

/** A valid line of each kind, built fresh so tests can change one field. */
const valid = (): Record<string, Fields> => ({
  opening: { ...base(), kind: 'opening', quantity_milli: 1000, total_cost_cents: 100, reason: 'Opening balance' },
  purchase: { ...base(), kind: 'purchase', quantity_milli: 1000, total_cost_cents: 100, supplier: 'Market', reference: 'R-1', expiry_date: '2026-12-01' },
  run_use: { ...base(), kind: 'run_use', quantity_milli: -1000, run_id: runId, run_cost_id: runCostId, unit_cost_e4: 1000 },
  void_return: { ...base(), kind: 'void_return', quantity_milli: 1000, run_id: runId, run_cost_id: runCostId },
  spillage: { ...base(), kind: 'spillage', quantity_milli: -1000, reason: 'Dropped' },
  spoilage: { ...base(), kind: 'spoilage', quantity_milli: -1000, reason: 'Went bad' },
  count_correction: { ...base(), kind: 'count_correction', quantity_milli: 1000, reason: 'Counted' },
});

const line = (fields: Fields) => insert(scoped, 'stock_movements', fields);
const ingredient = (fields: Fields = {}) =>
  insert(scoped, 'ingredients', { name: 'Soy sauce', base_unit: 'mL', created_by_user_id: 1, created_by_name: 'Owner', ...fields });

async function reversalOf(id: number, quantity = -1000) {
  return line({ ...base(), kind: 'purchase_reversal', quantity_milli: quantity, reason: 'Wrong entry', reverses_movement_id: id });
}

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const business = await createBusiness(app, db, 'Business A', 'owner@a.test');
  tenantId = business.tenantId;
  scoped = scopedDb(db, tenantId);
  agent = business.agent;
  catalog = await makeCatalog(agent);
  const run = await agent.post('/api/runs').send(at01Body(catalog));
  runId = run.body.id;
  const costs = await scoped.query<{ id: number }>('SELECT id FROM run_costs WHERE run_id = $1 ORDER BY id', [runId]);
  runCostId = costs.rows[0]!.id;
  ingredientId = await ingredient();
});
afterAll(async () => {
  await db?.close();
});

describe('row-level security on the new tables', () => {
  it('has the same policy as every other business table, on and not forced (D-22)', async () => {
    const tables = ['business_settings', 'ingredients', 'stock_movements', 'purchase_detail_changes'];
    for (const t of tables) expect(TENANT_TABLES, t).toContain(t);
    const flags = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
      [tables],
    );
    expect(flags.rows).toHaveLength(4);
    for (const f of flags.rows) expect([f.relname, f.relrowsecurity, f.relforcerowsecurity]).toEqual([f.relname, true, false]);
    const policies = await db.query<{ tablename: string; qual: string; with_check: string; cmd: string; permissive: string; roles: string }>(
      `SELECT tablename, qual, with_check, cmd, permissive, roles::text AS roles
       FROM pg_policies WHERE tablename = ANY($1::text[])`,
      [[...tables, 'pack_size_changes']],
    );
    expect(policies.rows).toHaveLength(5);
    const existing = policies.rows.find((p) => p.tablename === 'pack_size_changes')!;
    const shape = (p: typeof existing) => [p.qual, p.with_check, p.cmd, p.permissive, p.roles];
    expect(shape(existing).slice(2)).toEqual(['ALL', 'PERMISSIVE', '{public}']);
    for (const p of policies.rows) expect(shape(p), p.tablename).toEqual(shape(existing));
  });
});

describe('what the database catalog must hold (design note 1.0 to 1.5)', () => {
  const tables = ['business_settings', 'ingredients', 'stock_movements', 'purchase_detail_changes'];

  it('has exactly the agreed keys and links, so every link stays inside one business', async () => {
    const r = await db.query<{ table: string; name: string; def: string }>(
      `SELECT c.conrelid::regclass::text AS table, c.conname AS name, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       WHERE c.contype IN ('p', 'u', 'f') AND c.conrelid::regclass::text = ANY($1::text[])`,
      [tables],
    );
    const found = Object.fromEntries(r.rows.map((c) => [c.name, c.def]));
    expect(found).toEqual({
      business_settings_pkey: 'PRIMARY KEY (id)',
      business_settings_tenant_id_fkey: 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      business_settings_one_per_tenant: 'UNIQUE (tenant_id)',
      business_settings_tenant_id_key: 'UNIQUE (tenant_id, id)',
      ingredients_pkey: 'PRIMARY KEY (id)',
      ingredients_tenant_id_fkey: 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      ingredients_tenant_id_key: 'UNIQUE (tenant_id, id)',
      stock_movements_pkey: 'PRIMARY KEY (id)',
      stock_movements_tenant_id_fkey: 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      stock_movements_tenant_id_key: 'UNIQUE (tenant_id, id)',
      stock_movements_tenant_ingredient_id_key: 'UNIQUE (tenant_id, ingredient_id, id)',
      stock_movements_same_tenant_ingredient: 'FOREIGN KEY (tenant_id, ingredient_id) REFERENCES ingredients(tenant_id, id)',
      stock_movements_same_tenant_run: 'FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id)',
      stock_movements_same_run_cost: 'FOREIGN KEY (tenant_id, run_id, run_cost_id) REFERENCES run_costs(tenant_id, run_id, id)',
      stock_movements_same_ingredient_reversal:
        'FOREIGN KEY (tenant_id, ingredient_id, reverses_movement_id) REFERENCES stock_movements(tenant_id, ingredient_id, id)',
      purchase_detail_changes_pkey: 'PRIMARY KEY (id)',
      purchase_detail_changes_tenant_id_fkey: 'FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      purchase_detail_changes_tenant_id_key: 'UNIQUE (tenant_id, id)',
      purchase_detail_changes_same_tenant_movement: 'FOREIGN KEY (tenant_id, movement_id) REFERENCES stock_movements(tenant_id, id)',
    });
    const runCosts = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'run_costs_tenant_run_id_key'`,
    );
    expect(runCosts.rows).toEqual([{ def: 'UNIQUE (tenant_id, run_id, id)' }]);
  });

  it('allows empty values only in the agreed columns', async () => {
    const r = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND is_nullable = 'YES'`,
      [tables],
    );
    expect(r.rows.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual(
      [
        'business_settings.inventory_live_since',
        'business_settings.live_set_at',
        'business_settings.live_set_by_name',
        'business_settings.live_set_by_user_id',
        'ingredients.avg_cost_e4',
        'ingredients.low_stock_milli',
        'purchase_detail_changes.expiry_date',
        'stock_movements.expiry_date',
        'stock_movements.reverses_movement_id',
        'stock_movements.run_cost_id',
        'stock_movements.run_id',
        'stock_movements.total_cost_cents',
        'stock_movements.unit_cost_e4',
      ].sort(),
    );
  });

  it('has the indexes the replay, run lookups and correction history need', async () => {
    const r = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[])`,
      [['stock_movements_replay_idx', 'stock_movements_run_idx', 'purchase_detail_changes_movement_idx']],
    );
    const defs = Object.fromEntries(r.rows.map((i) => [i.indexname, i.indexdef]));
    expect(defs.stock_movements_replay_idx).toContain('(ingredient_id, effective_date, id)');
    expect(defs.stock_movements_run_idx).toContain('(run_id)');
    expect(defs.purchase_detail_changes_movement_idx).toContain('(movement_id)');
  });

  it('gives the app role exactly the agreed privileges and no others', async () => {
    const privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const expected: Record<string, string[]> = {
      business_settings: ['SELECT', 'INSERT', 'UPDATE'],
      ingredients: ['SELECT', 'INSERT', 'UPDATE'],
      stock_movements: ['SELECT', 'INSERT'],
      purchase_detail_changes: ['SELECT', 'INSERT'],
    };
    for (const [table, allowed] of Object.entries(expected)) {
      const held: string[] = [];
      for (const privilege of privileges) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('costing_app', $1, $2) AS ok`, [table, privilege]);
        if (r.rows[0]!.ok) held.push(privilege);
      }
      expect(held, table).toEqual(allowed);
    }
    // On the ledger, UPDATE reaches a purchase's three correctable columns and nothing else.
    const columns = await db.query<{ column_name: string; ok: boolean }>(
      `SELECT column_name, has_column_privilege('costing_app', 'stock_movements', column_name, 'UPDATE') AS ok
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_movements'`,
    );
    expect(columns.rows.filter((c) => c.ok).map((c) => c.column_name).sort()).toEqual(['expiry_date', 'reference', 'supplier']);
    const history = await db.query<{ ok: boolean }>(
      `SELECT has_any_column_privilege('costing_app', 'purchase_detail_changes', 'UPDATE') AS ok`,
    );
    expect(history.rows[0]!.ok).toBe(false);

    for (const table of tables) {
      const sequence = `${table}_id_seq`;
      const r = await db.query<{ usage: boolean; sel: boolean; upd: boolean }>(
        `SELECT has_sequence_privilege('costing_app', $1, 'USAGE') AS usage,
                has_sequence_privilege('costing_app', $1, 'SELECT') AS sel,
                has_sequence_privilege('costing_app', $1, 'UPDATE') AS upd`,
        [sequence],
      );
      expect(r.rows[0], sequence).toEqual({ usage: true, sel: true, upd: false });
    }
  });
});

describe('ingredients', () => {
  it('refuses names that are empty, too long or already used, ignoring case', async () => {
    await expect(ingredient({ name: '' })).rejects.toThrow(/check constraint/);
    await expect(ingredient({ name: 'x'.repeat(81) })).rejects.toThrow(/check constraint/);
    await expect(ingredient({ name: 'SOY SAUCE' })).rejects.toThrow(/ingredients_tenant_name_key/);
    expect(await ingredient({ name: 'x'.repeat(80) })).toBeGreaterThan(0);
  });

  it('accepts g, mL and pieces only', async () => {
    expect(await ingredient({ name: 'Pork', base_unit: 'g' })).toBeGreaterThan(0);
    expect(await ingredient({ name: 'Wrappers', base_unit: 'pc' })).toBeGreaterThan(0);
    await expect(ingredient({ name: 'Flour', base_unit: 'kg' })).rejects.toThrow(/check constraint/);
  });

  it('keeps the low-stock level and the average inside their limits', async () => {
    expect(await ingredient({ name: 'A', low_stock_milli: '10000000000', avg_cost_e4: '1000000000000' })).toBeGreaterThan(0);
    expect(await ingredient({ name: 'Zero', low_stock_milli: 0, avg_cost_e4: 0 })).toBeGreaterThan(0);
    await expect(ingredient({ name: 'B', low_stock_milli: '10000000001' })).rejects.toThrow(/check constraint/);
    await expect(ingredient({ name: 'C', low_stock_milli: -1 })).rejects.toThrow(/check constraint/);
    await expect(ingredient({ name: 'D', avg_cost_e4: '1000000000001' })).rejects.toThrow(/check constraint/);
    await expect(ingredient({ name: 'E', avg_cost_e4: -1 })).rejects.toThrow(/check constraint/);
  });

  it('starts with nothing on hand and no average, and lets on hand go below zero', async () => {
    const r = await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4, avg_version, active FROM ingredients WHERE id = $1', [ingredientId]);
    expect(toSafeInteger(r.rows[0].on_hand_milli)).toBe(0);
    expect(r.rows[0].avg_cost_e4).toBeNull();
    expect([r.rows[0].avg_version, r.rows[0].active]).toEqual([0, true]);
    await scoped.query('UPDATE ingredients SET on_hand_milli = -5000 WHERE id = $1', [ingredientId]);
  });

  it('needs to know who created it', async () => {
    await expect(ingredient({ name: 'A', created_by_name: '' })).rejects.toThrow(/check constraint/);
    await expect(ingredient({ name: 'B', created_by_user_id: null })).rejects.toThrow(/null value/);
  });
});

describe('business_settings', () => {
  const live = { inventory_live_since: '2026-11-04', live_set_by_user_id: 1, live_set_by_name: 'Owner', live_set_at: '2026-11-04T01:00:00Z' };

  it('allows one row per business', async () => {
    await insert(scoped, 'business_settings', {});
    await expect(insert(scoped, 'business_settings', {})).rejects.toThrow(/business_settings_one_per_tenant/);
    await scoped.query('INSERT INTO business_settings DEFAULT VALUES ON CONFLICT (tenant_id) DO NOTHING');
    expect((await scoped.query('SELECT id FROM business_settings')).rows).toHaveLength(1);
  });

  it('keeps the live date and who set it together', async () => {
    for (const field of Object.keys(live)) {
      await expect(insert(scoped, 'business_settings', { ...live, [field]: null }), field).rejects.toThrow(/check constraint/);
    }
    await expect(insert(scoped, 'business_settings', { ...live, live_set_by_name: '' })).rejects.toThrow(/check constraint/);
    expect(await insert(scoped, 'business_settings', live)).toBeGreaterThan(0);
  });

  it('can be locked by the app role, as Save and the live switch need', async () => {
    await insert(scoped, 'business_settings', {});
    await scoped.tx(async (q) => {
      expect((await q.query('SELECT id FROM business_settings FOR SHARE')).rows).toHaveLength(1);
      expect((await q.query('SELECT id FROM business_settings FOR UPDATE')).rows).toHaveLength(1);
    });
  });
});

describe('stock_movements: what each kind must hold (design note 1.4)', () => {
  it('accepts a valid line of every kind, and a 0 line for run use and void return', async () => {
    for (const [kind, fields] of Object.entries(valid())) {
      if (kind === 'void_return') continue; // its own test below, after run use has its line
      expect(await line(fields), kind).toBeGreaterThan(0);
    }
    expect(await line(valid().void_return!)).toBeGreaterThan(0);
    const costs = await scoped.query<{ id: number }>('SELECT id FROM run_costs WHERE run_id = $1 ORDER BY id', [runId]);
    const second = costs.rows[1]!.id;
    expect(await line({ ...valid().run_use, quantity_milli: 0, run_cost_id: second })).toBeGreaterThan(0);
    expect(await line({ ...valid().void_return, quantity_milli: 0, run_cost_id: second })).toBeGreaterThan(0);
  });

  it('accepts a valid reversal', async () => {
    const p = await line(valid().purchase!);
    expect(await reversalOf(p)).toBeGreaterThan(0);
  });

  it('refuses an unknown kind', async () => {
    await expect(line({ ...valid().spillage, kind: 'theft' })).rejects.toThrow(/stock_movements_kind_check/);
  });

  it('refuses the wrong sign for every kind', async () => {
    const wrong: [string, number][] = [
      ['opening', -1000],
      ['opening', 0],
      ['purchase', -1000],
      ['purchase', 0],
      ['run_use', 1000],
      ['void_return', -1000],
      ['spillage', 1000],
      ['spillage', 0],
      ['spoilage', 1000],
      ['spoilage', 0],
      ['count_correction', 0],
    ];
    for (const [kind, quantity_milli] of wrong) {
      await expect(line({ ...valid()[kind], quantity_milli }), `${kind} ${quantity_milli}`).rejects.toThrow(
        /stock_movements_quantity_by_kind/,
      );
    }
    // With a total of zero the unit-price limit cannot be what refuses these.
    for (const kind of ['opening', 'purchase']) {
      await expect(line({ ...valid()[kind], quantity_milli: 0, total_cost_cents: 0 }), kind).rejects.toThrow(
        /stock_movements_quantity_by_kind/,
      );
      await expect(line({ ...valid()[kind], quantity_milli: -1000, total_cost_cents: 0 }), kind).rejects.toThrow(
        /stock_movements_quantity_by_kind/,
      );
    }
    const p = await line(valid().purchase!);
    await expect(reversalOf(p, 1000)).rejects.toThrow(/stock_movements_quantity_by_kind/);
    await expect(reversalOf(p, 0)).rejects.toThrow(/stock_movements_quantity_by_kind/);
  });

  it('allows a total cost on opening balances and purchases only, and requires it there', async () => {
    await expect(line({ ...valid().opening, total_cost_cents: null })).rejects.toThrow(/stock_movements_cost_by_kind/);
    await expect(line({ ...valid().purchase, total_cost_cents: null })).rejects.toThrow(/stock_movements_cost_by_kind/);
    for (const kind of ['run_use', 'void_return', 'spillage', 'spoilage', 'count_correction']) {
      await expect(line({ ...valid()[kind], total_cost_cents: 100 }), kind).rejects.toThrow(/stock_movements_cost_by_kind/);
    }
  });

  it('allows supplier, reference and expiry on purchases only', async () => {
    for (const kind of ['opening', 'run_use', 'void_return', 'spillage', 'spoilage', 'count_correction']) {
      for (const extra of [{ supplier: 'X' }, { reference: 'X' }, { expiry_date: '2026-12-01' }]) {
        await expect(line({ ...valid()[kind], ...extra }), kind).rejects.toThrow(/stock_movements_details_by_kind/);
      }
    }
  });

  it('requires a reason where the table says so, and not a blank one', async () => {
    for (const kind of ['opening', 'spillage', 'spoilage', 'count_correction']) {
      await expect(line({ ...valid()[kind], reason: '' }), kind).rejects.toThrow(/stock_movements_reason_by_kind/);
      await expect(line({ ...valid()[kind], reason: '   ' }), kind).rejects.toThrow(/stock_movements_reason_by_kind/);
    }
    const p = await line(valid().purchase!);
    await expect(
      line({ ...base(), kind: 'purchase_reversal', quantity_milli: -1000, reverses_movement_id: p }),
    ).rejects.toThrow(/stock_movements_reason_by_kind/);
  });

  it('ties run links and the unit cost to run lines', async () => {
    await expect(line({ ...valid().run_use, run_id: null })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().run_use, run_cost_id: null })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().run_use, unit_cost_e4: null })).rejects.toThrow(/stock_movements_unit_cost_by_kind/);
    await expect(line({ ...valid().void_return, unit_cost_e4: 1000 })).rejects.toThrow(/stock_movements_unit_cost_by_kind/);
    await expect(line({ ...valid().purchase, run_id: runId, run_cost_id: runCostId })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().spillage, run_id: runId })).rejects.toThrow(/check constraint/);
  });

  it('ties the reversed line to reversals', async () => {
    const p = await line(valid().purchase!);
    await expect(line({ ...valid().spillage, reverses_movement_id: p })).rejects.toThrow(/stock_movements_reversal_by_kind/);
    await expect(
      line({ ...base(), kind: 'purchase_reversal', quantity_milli: -1000, reason: 'x' }),
    ).rejects.toThrow(/stock_movements_reversal_by_kind/);
  });

  it('refuses a line that reverses itself', async () => {
    await expect(
      line({ id: 500, ...base(), kind: 'purchase_reversal', quantity_milli: -1000, reason: 'x', reverses_movement_id: 500 }),
    ).rejects.toThrow(/stock_movements_not_own_reversal/);
  });
});

describe('stock_movements: limits (design note 2.1)', () => {
  it('holds a quantity of 10,000,000 base units and no more, in either direction', async () => {
    expect(await line({ ...valid().purchase, quantity_milli: '10000000000', total_cost_cents: 1 })).toBeGreaterThan(0);
    expect(await line({ ...valid().spillage, quantity_milli: '-10000000000' })).toBeGreaterThan(0);
    await expect(line({ ...valid().purchase, quantity_milli: '10000000001', total_cost_cents: 1 })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().spillage, quantity_milli: '-10000000001' })).rejects.toThrow(/check constraint/);
  });

  it('holds a total of P20,000,000 and no more', async () => {
    expect(await line({ ...valid().purchase, quantity_milli: 1_000_000, total_cost_cents: 2_000_000_000 })).toBeGreaterThan(0);
    await expect(line({ ...valid().purchase, quantity_milli: 1_000_000, total_cost_cents: 2_000_000_001 })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().purchase, total_cost_cents: -1 })).rejects.toThrow(/check constraint/);
    // A free purchase is allowed (INV-02: price zero or more).
    expect(await line({ ...valid().purchase, total_cost_cents: 0 })).toBeGreaterThan(0);
  });

  it('holds a unit price of exactly P1,000,000 and not a centavo more', async () => {
    expect(await line({ ...valid().purchase, quantity_milli: 1, total_cost_cents: 100_000 })).toBeGreaterThan(0);
    await expect(line({ ...valid().purchase, quantity_milli: 1, total_cost_cents: 100_001 })).rejects.toThrow(/stock_movements_unit_price_limit/);
    await expect(line({ ...valid().opening, quantity_milli: 1, total_cost_cents: 100_001 })).rejects.toThrow(/stock_movements_unit_price_limit/);
  });

  it('limits text lengths and the unit cost, and needs to know who', async () => {
    await expect(line({ ...valid().purchase, supplier: 'x'.repeat(121) })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().purchase, reference: 'x'.repeat(121) })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().spillage, reason: 'x'.repeat(301) })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().run_use, unit_cost_e4: '1000000000001' })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().run_use, unit_cost_e4: -1 })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().spillage, entered_by_name: '' })).rejects.toThrow(/check constraint/);
    await expect(line({ ...valid().spillage, entered_by_user_id: null })).rejects.toThrow(/null value/);
    expect(await line({ ...valid().purchase, supplier: 'x'.repeat(120), reference: 'x'.repeat(120) })).toBeGreaterThan(0);
    expect(await line({ ...valid().spillage, reason: 'x'.repeat(300) })).toBeGreaterThan(0);
  });
});

describe('stock_movements: links and once-only rules', () => {
  it('holds a unit cost from zero to the per-unit limit', async () => {
    const costs = await scoped.query<{ id: number }>('SELECT id FROM run_costs WHERE run_id = $1 ORDER BY id', [runId]);
    expect(await line({ ...valid().run_use, run_cost_id: costs.rows[0]!.id, unit_cost_e4: 0 })).toBeGreaterThan(0);
    expect(await line({ ...valid().run_use, run_cost_id: costs.rows[1]!.id, unit_cost_e4: '1000000000000' })).toBeGreaterThan(0);
  });

  it('reverses a line at most once', async () => {
    const p = await line(valid().purchase!);
    await reversalOf(p);
    await expect(reversalOf(p)).rejects.toThrow(/stock_movements_reversed_once/);
  });

  it('uses and returns a run line at most once, but allows one of each', async () => {
    await line(valid().run_use!);
    await expect(line(valid().run_use!)).rejects.toThrow(/stock_movements_run_use_once/);
    await line(valid().void_return!);
    await expect(line(valid().void_return!)).rejects.toThrow(/stock_movements_void_return_once/);
  });

  it('cannot point at a run line of another run in the same business', async () => {
    const other = await agent.post('/api/runs').send(at01Body(catalog, '2026-10-20'));
    expect(other.status).toBe(201);
    await expect(line({ ...valid().run_use, run_id: other.body.id })).rejects.toThrow(/stock_movements_same_run_cost/);
    await expect(line({ ...valid().run_use, run_id: 999_999 })).rejects.toThrow(/foreign key/);
  });

  it('cannot reverse a line of another ingredient', async () => {
    const other = await ingredient({ name: 'Vinegar' });
    const p = await line({ ...valid().purchase, ingredient_id: other });
    await expect(reversalOf(p)).rejects.toThrow(/stock_movements_same_ingredient_reversal/);
  });

  it('allows a standing opening balance to be followed by another: that rule is the server\'s (Q51)', async () => {
    await line(valid().opening!);
    expect(await line(valid().opening!)).toBeGreaterThan(0);
  });
});

describe('the ledger is append-only for the app role', () => {
  it('can change a purchase\'s supplier, reference and expiry date, and nothing else', async () => {
    const p = await line(valid().purchase!);
    await scoped.query(`UPDATE stock_movements SET supplier = 'New', reference = 'R-2', expiry_date = '2027-01-01' WHERE id = $1`, [p]);
    const row = (await scoped.query<any>(`SELECT supplier, reference, expiry_date::text AS expiry FROM stock_movements WHERE id = $1`, [p])).rows[0];
    expect(row).toEqual({ supplier: 'New', reference: 'R-2', expiry: '2027-01-01' });

    for (const set of [
      'quantity_milli = 1',
      'total_cost_cents = 1',
      `effective_date = '2026-01-01'`,
      `kind = 'opening'`,
      'ingredient_id = ingredient_id',
      'run_id = NULL',
      'run_cost_id = NULL',
      'unit_cost_e4 = NULL',
      'reverses_movement_id = NULL',
      `reason = 'x'`,
      'tenant_id = tenant_id',
      `entered_by_name = 'x'`,
      'entered_by_user_id = 2',
      'entered_at = now()',
      'id = 999',
    ]) {
      await expect(scoped.query(`UPDATE stock_movements SET ${set} WHERE id = $1`, [p]), set).rejects.toThrow(/permission denied/);
    }
    await expect(scoped.query('DELETE FROM stock_movements WHERE id = $1', [p])).rejects.toThrow(/permission denied/);
  });

  it('cannot put purchase details on any other kind of line, even with the column grant', async () => {
    const s = await line(valid().spillage!);
    await expect(scoped.query(`UPDATE stock_movements SET expiry_date = '2027-01-01' WHERE id = $1`, [s])).rejects.toThrow(
      /stock_movements_details_by_kind/,
    );
    await expect(scoped.query(`UPDATE stock_movements SET supplier = 'X' WHERE id = $1`, [s])).rejects.toThrow(
      /stock_movements_details_by_kind/,
    );
  });

  it('keeps purchase corrections as add-only history', async () => {
    const p = await line(valid().purchase!);
    const c = await insert(scoped, 'purchase_detail_changes', {
      movement_id: p, supplier: 'Market', reference: 'R-1', expiry_date: '2026-12-01', changed_by_user_id: 1, changed_by_name: 'Owner',
    });
    expect(c).toBeGreaterThan(0);
    await expect(scoped.query(`UPDATE purchase_detail_changes SET supplier = 'X'`)).rejects.toThrow(/permission denied/);
    await expect(scoped.query('DELETE FROM purchase_detail_changes')).rejects.toThrow(/permission denied/);
    await expect(
      insert(scoped, 'purchase_detail_changes', { movement_id: p, supplier: '', reference: '', changed_by_user_id: 1, changed_by_name: '' }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      insert(scoped, 'purchase_detail_changes', { movement_id: 999_999, supplier: '', reference: '', changed_by_user_id: 1, changed_by_name: 'Owner' }),
    ).rejects.toThrow(/foreign key/);
    const row = { movement_id: p, supplier: '', reference: '', changed_by_user_id: 1, changed_by_name: 'Owner' };
    expect(await insert(scoped, 'purchase_detail_changes', { ...row, supplier: 'x'.repeat(120), reference: 'x'.repeat(120) })).toBeGreaterThan(0);
    await expect(insert(scoped, 'purchase_detail_changes', { ...row, supplier: 'x'.repeat(121) })).rejects.toThrow(/check constraint/);
    await expect(insert(scoped, 'purchase_detail_changes', { ...row, reference: 'x'.repeat(121) })).rejects.toThrow(/check constraint/);
  });

  it('can lock an ingredient row, as every stock save needs', async () => {
    await scoped.tx(async (q) => {
      expect((await q.query('SELECT id FROM ingredients WHERE id = $1 FOR NO KEY UPDATE', [ingredientId])).rows).toHaveLength(1);
      expect((await q.query('SELECT id FROM ingredients WHERE id = $1 FOR SHARE', [ingredientId])).rows).toHaveLength(1);
    });
  });

  it('cannot delete ingredients or settings', async () => {
    await insert(scoped, 'business_settings', {});
    await expect(scoped.query('DELETE FROM ingredients')).rejects.toThrow(/permission denied/);
    await expect(scoped.query('DELETE FROM business_settings')).rejects.toThrow(/permission denied/);
  });
});

describe('reading bigint values back (design note 2.1)', () => {
  it('turns stored quantities and their sum into exact integers', async () => {
    await line({ ...valid().purchase, quantity_milli: '10000000000', total_cost_cents: 1 });
    await line({ ...valid().purchase, quantity_milli: '10000000000', total_cost_cents: 1 });
    const r = await scoped.query<any>(
      `SELECT quantity_milli, (SELECT sum(quantity_milli) FROM stock_movements) AS total FROM stock_movements ORDER BY id LIMIT 1`,
    );
    expect(toSafeInteger(r.rows[0].quantity_milli)).toBe(10_000_000_000);
    expect(toSafeInteger(r.rows[0].total)).toBe(20_000_000_000);
  });

  it('reads negative on hand and the top of the average range', async () => {
    await scoped.query(`UPDATE ingredients SET on_hand_milli = -10000000000, avg_cost_e4 = 1000000000000 WHERE id = $1`, [ingredientId]);
    const r = await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4 FROM ingredients WHERE id = $1', [ingredientId]);
    expect(toSafeInteger(r.rows[0].on_hand_milli)).toBe(-10_000_000_000);
    expect(toSafeInteger(r.rows[0].avg_cost_e4)).toBe(1_000_000_000_000);
  });

  it('fails loudly on a value too large to hold exactly', async () => {
    const r = await db.query<any>(`SELECT 9007199254740993::bigint AS big`);
    expect(() => toSafeInteger(r.rows[0].big)).toThrow();
  });
});

describe('backup and restore with the new tables (design note section 8)', () => {
  it('brings back every line, whatever order the ledger rows are in, and keeps numbering after them', async () => {
    await insert(scoped, 'business_settings', {
      inventory_live_since: '2026-11-04', live_set_by_user_id: 1, live_set_by_name: 'Owner', live_set_at: '2026-11-04T01:00:00Z',
    });
    const p = await line(valid().purchase!);
    await reversalOf(p);
    const kept = await line(valid().purchase!);
    await line(valid().run_use!);
    await line(valid().void_return!);
    await insert(scoped, 'purchase_detail_changes', {
      movement_id: kept, supplier: 'Market', reference: 'R-1', expiry_date: '2026-12-01', changed_by_user_id: 1, changed_by_name: 'Owner',
    });
    await scoped.query(`UPDATE ingredients SET on_hand_milli = 2000, avg_cost_e4 = 1000000 WHERE id = $1`, [ingredientId]);

    const backup = await exportEverything(db);
    expect(backup.tables.stock_movements).toHaveLength(5);

    // The reversal comes before its purchase in the file: the foreign key is checked at the end of the statement.
    const shuffled = { ...backup, tables: { ...backup.tables, stock_movements: [...backup.tables.stock_movements!].reverse() } };
    // Restore as into a new database: everything empty, and all numbering back at the start.
    await resetData(db);
    const counts = await importEverything(db, JSON.parse(JSON.stringify(shuffled)));
    expect(counts).toMatchObject({ business_settings: 1, ingredients: 1, stock_movements: 5, purchase_detail_changes: 1 });
    expect({ ...(await exportEverything(db)), exportedAt: '' }).toEqual({ ...backup, exportedAt: '' });

    // New rows get ids above anything restored: the fast path relies on ledger ids always going up.
    for (const table of ['business_settings', 'ingredients', 'stock_movements', 'purchase_detail_changes']) {
      const r = await db.query<{ next: unknown; top: number }>(
        `SELECT nextval(pg_get_serial_sequence($1, 'id')) AS next, (SELECT max(id) FROM ${table}) AS top`,
        [table],
      );
      expect(toSafeInteger(r.rows[0]!.next), table).toBe(r.rows[0]!.top + 1);
    }
  });
});
