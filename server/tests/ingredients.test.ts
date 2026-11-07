import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { acceptToken, inviteStaff } from '../src/services/accounts';
import { createIngredient, getIngredient, getIngredientWithCost, listIngredients, listIngredientsWithCost } from '../src/services/ingredients';
import { type Agent, type App, PASSWORD, createAdminAgent, createBusiness, makeApp, openTestDb, resetData } from './helpers';

let db: Db;
let app: App;
let owner: Agent;
let staff: Agent;
let other: Agent;
let tenantId: number;

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
  const b = await createBusiness(app, db, 'Other Foods', 'owner@b.test');
  [owner, other, tenantId] = [a.agent, b.agent, a.tenantId];
  const invited = await inviteStaff(db, tenantId, { email: 'staff@a.test', name: 'Staff' });
  await acceptToken(db, invited.token, PASSWORD);
  staff = request.agent(app);
  await staff.post('/api/auth/login').send({ email: 'staff@a.test', password: PASSWORD }).expect(200);
});
afterAll(async () => {
  await db?.close();
});

const add = async (name = 'Soy sauce', baseUnit = 'mL') => (await owner.post('/api/ingredients').send({ name, baseUnit }).expect(201)).body;

/** A ledger line and the cached figures, written directly: purchases come in a later task. */
async function recordStock(id: number) {
  const scoped = scopedDb(db, tenantId);
  await scoped.query(
    `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, total_cost_cents, entered_by_user_id, entered_by_name)
     VALUES ($1, 'purchase', '2026-11-01', 500000, 6000, 1, 'Owner')`,
    [id],
  );
  await scoped.query(`UPDATE ingredients SET on_hand_milli = 500000, avg_cost_e4 = 120000, avg_version = 1 WHERE id = $1`, [id]);
}

describe('the owner keeps the ingredient list (INV-01)', () => {
  it('adds an ingredient with nothing on hand and no average, and saves who added it', async () => {
    const soy = await add();
    expect(soy).toEqual({ id: soy.id, name: 'Soy sauce', baseUnit: 'mL', onHandMilli: 0, lowStockMilli: null, active: true, avgCostE4: null });
    const row = (await scopedDb(db, tenantId).query<any>('SELECT created_by_name, created_by_user_id FROM ingredients WHERE id = $1', [soy.id])).rows[0];
    expect(row.created_by_name).toBe('Frozen Foods Owner');
    expect(row.created_by_user_id).toBeGreaterThan(0);
  });

  it('accepts g, mL and pieces only', async () => {
    expect((await add('Pork', 'g')).baseUnit).toBe('g');
    expect((await add('Wrappers', 'pc')).baseUnit).toBe('pc');
    for (const baseUnit of ['kg', 'L', 'G', '', undefined, 5]) {
      expect((await owner.post('/api/ingredients').send({ name: 'Flour', baseUnit })).status, String(baseUnit)).toBe(400);
    }
  });

  it('trims the name and refuses a blank or too long one', async () => {
    expect((await add('  Pork shoulder \t', 'g')).name).toBe('Pork shoulder');
    expect((await add('x'.repeat(80), 'g')).name).toHaveLength(80);
    for (const name of ['', '   ', '\t\n', ' 　', 'x'.repeat(81), undefined, 5]) {
      const r = await owner.post('/api/ingredients').send({ name, baseUnit: 'g' });
      expect(r.status, JSON.stringify(name)).toBe(400);
    }
    const blank = await owner.patch(`/api/ingredients/${(await add()).id}`).send({ name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/Name is required/);
  });

  it('refuses control and invisible characters with a plain message, and keeps ordinary ones', async () => {
    const soy = await add();
    for (const name of ['a\u0000b', '\u0000', 'Soy\nsauce', 'Soy\tsauce', '\u200b', 'Soy sauce\u200b', '\u00ad', '\ufeffx\u2060']) {
      const created = await owner.post('/api/ingredients').send({ name, baseUnit: 'g' });
      expect(created.status, JSON.stringify(name)).toBe(400);
      expect(created.body.error).toMatch(/hidden or control characters|Name is required/);
      expect((await owner.patch(`/api/ingredients/${soy.id}`).send({ name })).status, JSON.stringify(name)).toBe(400);
    }
    expect((await owner.get('/api/ingredients')).body).toEqual([soy]);
    for (const name of ['Piña', 'Calamansí juice', '醤油', 'Chili 🌶', "Mang Tomas' sauce"]) {
      expect((await add(name, 'g')).name).toBe(name);
    }
  });

  it('refuses a name already used in the business, ignoring case, with a plain message', async () => {
    await add('Soy sauce');
    const r = await owner.post('/api/ingredients').send({ name: 'SOY SAUCE', baseUnit: 'mL' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('There is already an ingredient called SOY SAUCE. It may be archived.');
    expect((await owner.get('/api/ingredients')).body).toHaveLength(1);
  });

  it('counts an archived ingredient as using its name', async () => {
    const soy = await add('Soy sauce');
    await owner.patch(`/api/ingredients/${soy.id}`).send({ active: false }).expect(200);
    expect((await owner.post('/api/ingredients').send({ name: 'Soy sauce', baseUnit: 'mL' })).status).toBe(400);
  });

  it('renames, including just changing the capitals, and refuses another ingredient\'s name', async () => {
    const soy = await add('Soy sauce');
    const vinegar = await add('Vinegar');
    expect((await owner.patch(`/api/ingredients/${soy.id}`).send({ name: 'Dark soy' })).body.name).toBe('Dark soy');
    expect((await owner.patch(`/api/ingredients/${soy.id}`).send({ name: 'DARK SOY' })).body.name).toBe('DARK SOY');
    const taken = await owner.patch(`/api/ingredients/${vinegar.id}`).send({ name: 'dark soy' });
    expect(taken.status).toBe(400);
    expect(taken.body.error).toMatch(/already an ingredient called dark soy/);
    expect((await owner.get(`/api/ingredients/${vinegar.id}`)).body.name).toBe('Vinegar');
  });

  it('leaves everything as it is for an empty change', async () => {
    const soy = await add();
    expect((await owner.patch(`/api/ingredients/${soy.id}`).send({})).body).toEqual(soy);
  });

  it('never takes on hand, the average or the business from a request', async () => {
    const soy = await add();
    const r = await owner
      .patch(`/api/ingredients/${soy.id}`)
      .send({ onHandMilli: 999, avgCostE4: 999, tenantId: 999, lowStockMilli: 999, on_hand_milli: 999, avg_cost_e4: 999 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(soy);
    const created = await owner.post('/api/ingredients').send({ name: 'Vinegar', baseUnit: 'mL', onHandMilli: 999, avgCostE4: 999, active: false });
    expect(created.body).toMatchObject({ onHandMilli: 0, avgCostE4: null, active: true });
  });
});

describe('the unit is fixed once stock has moved (INV-01)', () => {
  it('can change before any stock is recorded, which clears the low-stock level', async () => {
    const soy = await add('Soy sauce', 'mL');
    await scopedDb(db, tenantId).query('UPDATE ingredients SET low_stock_milli = 5000 WHERE id = $1', [soy.id]);
    const r = await owner.patch(`/api/ingredients/${soy.id}`).send({ baseUnit: 'g' });
    expect(r.body).toMatchObject({ baseUnit: 'g', lowStockMilli: null });
  });

  it('keeps the low-stock level when the unit given is the same one', async () => {
    const soy = await add('Soy sauce', 'mL');
    await scopedDb(db, tenantId).query('UPDATE ingredients SET low_stock_milli = 5000 WHERE id = $1', [soy.id]);
    expect((await owner.patch(`/api/ingredients/${soy.id}`).send({ baseUnit: 'mL' })).body.lowStockMilli).toBe(5000);
  });

  it('is refused once a ledger line exists, and the whole change is left undone', async () => {
    const soy = await add('Soy sauce', 'mL');
    await recordStock(soy.id);
    const r = await owner.patch(`/api/ingredients/${soy.id}`).send({ baseUnit: 'g', name: 'Renamed', active: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('The unit cannot change once stock has been recorded for this ingredient.');
    expect((await owner.get(`/api/ingredients/${soy.id}`)).body).toMatchObject({ name: 'Soy sauce', baseUnit: 'mL', active: true });
  });

  it('still allows a rename, and giving the same unit, once stock has moved', async () => {
    const soy = await add('Soy sauce', 'mL');
    await recordStock(soy.id);
    const r = await owner.patch(`/api/ingredients/${soy.id}`).send({ name: 'Dark soy', baseUnit: 'mL' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Dark soy', baseUnit: 'mL', onHandMilli: 500000, avgCostE4: 120000 });
  });

  it('stays fixed even when the only ledger lines were reversed', async () => {
    const soy = await add('Soy sauce', 'mL');
    await recordStock(soy.id);
    const scoped = scopedDb(db, tenantId);
    const line = (await scoped.query<{ id: number }>('SELECT id FROM stock_movements WHERE ingredient_id = $1', [soy.id])).rows[0]!.id;
    await scoped.query(
      `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, reason, reverses_movement_id, entered_by_user_id, entered_by_name)
       VALUES ($1, 'purchase_reversal', '2026-11-01', -500000, 'Wrong entry', $2, 1, 'Owner')`,
      [soy.id, line],
    );
    expect((await owner.patch(`/api/ingredients/${soy.id}`).send({ baseUnit: 'g' })).status).toBe(409);
  });

  it('does not change the average or its version on a rename or archive', async () => {
    const soy = await add();
    await recordStock(soy.id);
    await owner.patch(`/api/ingredients/${soy.id}`).send({ name: 'Dark soy', active: false }).expect(200);
    const row = (await scopedDb(db, tenantId).query<any>('SELECT avg_version FROM ingredients WHERE id = $1', [soy.id])).rows[0];
    expect(row.avg_version).toBe(1);
  });
});

describe('archiving (Q46, Q50)', () => {
  it('works while the ingredient has stock, keeps its stock, and can be undone', async () => {
    const soy = await add();
    await recordStock(soy.id);
    const archived = (await owner.patch(`/api/ingredients/${soy.id}`).send({ active: false })).body;
    expect(archived).toMatchObject({ active: false, onHandMilli: 500000, avgCostE4: 120000 });
    expect((await owner.get('/api/ingredients')).body).toEqual([]);
    expect((await owner.get('/api/ingredients?includeInactive=1')).body).toHaveLength(1);
    expect((await owner.get(`/api/ingredients/${soy.id}`)).status).toBe(200);
    expect((await owner.patch(`/api/ingredients/${soy.id}`).send({ active: true })).body.active).toBe(true);
    expect((await owner.get('/api/ingredients')).body).toHaveLength(1);
  });

  it('never deletes: there is no delete route', async () => {
    const soy = await add();
    expect((await owner.delete(`/api/ingredients/${soy.id}`)).status).toBe(404);
    expect((await owner.get(`/api/ingredients/${soy.id}`)).status).toBe(200);
  });
});

describe('lists', () => {
  it('sorts by name, ignoring case', async () => {
    await add('vinegar');
    await add('annatto');
    await add('Pork', 'g');
    const expected = ['annatto', 'Pork', 'vinegar'];
    expect((await owner.get('/api/ingredients')).body.map((i: any) => i.name)).toEqual(expected);
    expect((await staff.get('/api/ingredients')).body.map((i: any) => i.name)).toEqual(expected);
  });
});

describe('who can do what (INV-14)', () => {
  it('shows staff names, units and quantities, and never a cost', async () => {
    const soy = await add();
    await recordStock(soy.id);
    const quantities = { id: soy.id, name: 'Soy sauce', baseUnit: 'mL', onHandMilli: 500000, lowStockMilli: null, active: true };
    const list = await staff.get('/api/ingredients');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([quantities]);
    const one = await staff.get(`/api/ingredients/${soy.id}`);
    expect(one.body).toEqual(quantities);
    expect((await staff.get('/api/ingredients?includeInactive=1')).body).toEqual([quantities]);
    for (const r of [list, one]) {
      expect(r.text).not.toMatch(/avg|cost/i);
      expect(r.text).not.toContain('120000');
    }
  });

  it('hides archived ingredients from staff too, unless asked', async () => {
    const soy = await add('Soy sauce');
    const vinegar = await add('Vinegar');
    await owner.patch(`/api/ingredients/${vinegar.id}`).send({ active: false }).expect(200);
    expect((await staff.get('/api/ingredients')).body.map((i: any) => i.id)).toEqual([soy.id]);
    expect((await staff.get('/api/ingredients?includeInactive=1')).body.map((i: any) => i.id)).toEqual([soy.id, vinegar.id]);
  });

  it('shows the owner the average', async () => {
    const soy = await add();
    await recordStock(soy.id);
    expect((await owner.get('/api/ingredients')).body[0].avgCostE4).toBe(120000);
    expect((await owner.get(`/api/ingredients/${soy.id}`)).body.avgCostE4).toBe(120000);
  });

  it('refuses staff adding or changing, with nothing changed', async () => {
    const soy = await add();
    const added = await staff.post('/api/ingredients').send({ name: 'Vinegar', baseUnit: 'mL' });
    expect(added.status).toBe(403);
    expect(added.body.error).toBe('Only the business owner can do this.');
    for (const body of [{ name: 'Hacked' }, { active: false }, { baseUnit: 'g' }]) {
      expect((await staff.patch(`/api/ingredients/${soy.id}`).send(body)).status).toBe(403);
    }
    expect((await owner.get('/api/ingredients')).body).toEqual([soy]);
  });

  it('refuses anyone not signed in, and the admin account', async () => {
    const soy = await add();
    const admin = await createAdminAgent(app, db);
    for (const agent of [request(app), admin]) {
      const expected = agent === admin ? 403 : 401;
      expect((await agent.get('/api/ingredients')).status).toBe(expected);
      expect((await agent.get(`/api/ingredients/${soy.id}`)).status).toBe(expected);
      expect((await agent.post('/api/ingredients').send({ name: 'X', baseUnit: 'g' })).status).toBe(expected);
      expect((await agent.patch(`/api/ingredients/${soy.id}`).send({ name: 'X' })).status).toBe(expected);
    }
  });

  it('lets a lapsed business look but not change, and locks a suspended one out', async () => {
    const soy = await add();
    await db.query(`UPDATE tenants SET status = 'cancelled' WHERE id = $1`, [tenantId]);
    expect((await owner.get('/api/ingredients')).status).toBe(200);
    expect((await staff.get('/api/ingredients')).status).toBe(200);
    const added = await owner.post('/api/ingredients').send({ name: 'Vinegar', baseUnit: 'mL' });
    expect(added.status).toBe(402);
    expect(added.body.code).toBe('read_only');
    expect((await owner.patch(`/api/ingredients/${soy.id}`).send({ name: 'X' })).status).toBe(402);
    // Staff are told it is not theirs to do, not that the subscription would fix it.
    expect((await staff.post('/api/ingredients').send({ name: 'Vinegar', baseUnit: 'mL' })).status).toBe(403);
    expect((await staff.patch(`/api/ingredients/${soy.id}`).send({ name: 'X' })).status).toBe(403);

    await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);
    const locked = await owner.get('/api/ingredients');
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe('suspended');
  });
});

describe('one business cannot reach another\'s ingredients', () => {
  it('keeps lists apart and lets each business use the same name', async () => {
    const soy = await add('Soy sauce');
    expect((await other.get('/api/ingredients')).body).toEqual([]);
    const theirs = (await other.post('/api/ingredients').send({ name: 'Soy sauce', baseUnit: 'g' }).expect(201)).body;
    expect(theirs.id).not.toBe(soy.id);
    expect((await owner.get('/api/ingredients')).body.map((i: any) => i.baseUnit)).toEqual(['mL']);
  });

  it('answers "not found" for another business\'s ingredient, and changes nothing', async () => {
    const soy = await add();
    const seen = await other.get(`/api/ingredients/${soy.id}`);
    expect(seen.status).toBe(404);
    expect(seen.body.error).toBe('Ingredient not found');
    expect((await other.patch(`/api/ingredients/${soy.id}`).send({ name: 'Hacked', active: false })).status).toBe(404);
    expect((await owner.get(`/api/ingredients/${soy.id}`)).body).toEqual(soy);
  });
});

describe('what the database driver hands back', () => {
  const row = { id: 7, name: 'Soy sauce', base_unit: 'mL', active: true };
  /** A stand-in for the database that records the SQL it was given and returns these rows. */
  const fake = (rows: any[]) => {
    const seen: string[] = [];
    return { seen, q: { query: async (text: string) => (seen.push(text), { rows }), exec: async () => undefined } as any };
  };

  it('turns bigint strings (node-postgres) and BigInts into exact numbers', async () => {
    const strings = fake([{ ...row, on_hand_milli: '-10000000000', low_stock_milli: '5000', avg_cost_e4: '1000000000000' }]);
    const expected = { id: 7, name: 'Soy sauce', baseUnit: 'mL', onHandMilli: -10_000_000_000, lowStockMilli: 5000, active: true };
    expect(await listIngredientsWithCost(strings.q)).toEqual([{ ...expected, avgCostE4: 1_000_000_000_000 }]);
    expect(await getIngredientWithCost(strings.q, 7)).toEqual({ ...expected, avgCostE4: 1_000_000_000_000 });
    expect(await listIngredients(strings.q)).toEqual([expected]);
    expect(await getIngredient(strings.q, 7)).toEqual(expected);

    const bigints = fake([{ ...row, on_hand_milli: 5n, low_stock_milli: null, avg_cost_e4: 7n }]);
    expect(await getIngredientWithCost(bigints.q, 7)).toMatchObject({ onHandMilli: 5, lowStockMilli: null, avgCostE4: 7 });
  });

  it('never asks the database for costs on the staff reads', async () => {
    const staffReads = fake([{ ...row, on_hand_milli: '0', low_stock_milli: null }]);
    await listIngredients(staffReads.q, true);
    await getIngredient(staffReads.q, 7);
    expect(staffReads.seen).toHaveLength(2);
    for (const text of staffReads.seen) {
      expect(text).not.toMatch(/avg_|cost|\*/i);
    }
  });

  it('only treats a clash on the name index as "name taken"', async () => {
    const failing = (err: unknown) =>
      ({ tx: async (fn: any) => fn({ query: async () => Promise.reject(err) }) }) as unknown as Db;
    const actor = { id: 1, name: 'Owner' };
    const input = { name: 'Soy sauce', baseUnit: 'mL' as const };
    const name = { code: '23505', constraint: 'ingredients_tenant_name_key' };
    await expect(createIngredient(failing(name), input, actor)).rejects.toThrow(/already an ingredient called Soy sauce/);
    const otherKey = { code: '23505', constraint: 'ingredients_pkey' };
    await expect(createIngredient(failing(otherKey), input, actor)).rejects.toBe(otherKey);
    const notUnique = new Error('connection lost');
    await expect(createIngredient(failing(notUnique), input, actor)).rejects.toBe(notUnique);
  });
});

describe('two saves blocking each other', () => {
  it('answers plainly when the database stops a save to end a deadlock', async () => {
    let armed = false;
    const failing: Db = {
      ...db,
      tx: (fn) => {
        if (!armed) return db.tx(fn);
        armed = false;
        return db.tx(async (q) => {
          await fn(q);
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        });
      },
    };
    const api = request.agent(makeApp(failing));
    await api.post('/api/auth/login').send({ email: 'owner@a.test', password: PASSWORD }).expect(200);
    const soy = await add();
    armed = true;
    const r = await api.patch(`/api/ingredients/${soy.id}`).send({ name: 'Dark soy' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Someone else was saving at the same moment. Please try again.');
    expect((await owner.get(`/api/ingredients/${soy.id}`)).body.name).toBe('Soy sauce');
  });
});

describe('bad addresses', () => {
  it('answers plainly for ids that are not valid or do not exist', async () => {
    expect((await owner.get('/api/ingredients/abc')).status).toBe(400);
    expect((await owner.get('/api/ingredients/0')).status).toBe(400);
    expect((await owner.get('/api/ingredients/9999')).status).toBe(404);
    expect((await owner.patch('/api/ingredients/9999').send({ name: 'X' })).status).toBe(404);
    // Too large for the database's id column: a plain answer, not a server error, on the business data routes.
    expect((await owner.get('/api/ingredients/2147483647')).status).toBe(404);
    expect((await owner.get('/api/ingredients/2147483648')).status).toBe(400);
    expect((await owner.patch('/api/ingredients/2147483648').send({ name: 'X' })).status).toBe(400);
    expect((await owner.get('/api/products/2147483648')).status).toBe(400);
    expect((await owner.get('/api/runs/2147483648')).status).toBe(400);
  });
});
