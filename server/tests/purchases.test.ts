import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lineCostCents, replay, toSafeInteger } from '../src/calc/stock';
import { CalcError } from '../src/calc/types';
import { addDays, localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { acceptToken, inviteStaff } from '../src/services/accounts';
import { addLedgerLine, lockIngredients, plainRefusal, recordPurchase } from '../src/services/stockLedger';
import { type Agent, type App, PASSWORD, createAdminAgent, createBusiness, makeApp, openTestDb, resetData } from './helpers';

let db: Db;
let app: App;
let owner: Agent;
let staff: Agent;
let other: Agent;
let tenantId: number;
let scoped: Db;
let soy: number;

const today = () => localToday();

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
  const b = await createBusiness(app, db, 'Other Foods', 'owner@b.test');
  [owner, other, tenantId] = [a.agent, b.agent, a.tenantId];
  scoped = scopedDb(db, tenantId);
  const invited = await inviteStaff(db, tenantId, { email: 'staff@a.test', name: 'Staff Member' });
  await acceptToken(db, invited.token, PASSWORD);
  staff = request.agent(app);
  await staff.post('/api/auth/login').send({ email: 'staff@a.test', password: PASSWORD }).expect(200);
  soy = await addIngredient('Soy sauce', 'mL');
});
afterAll(async () => {
  await db?.close();
});

async function addIngredient(name: string, baseUnit: string): Promise<number> {
  return (await owner.post('/api/ingredients').send({ name, baseUnit }).expect(201)).body.id;
}

const body = (fields: Record<string, unknown> = {}) => ({
  effectiveDate: today(),
  quantity: '500',
  unit: 'mL',
  totalCostCents: 6000,
  ...fields,
});
const buy = (fields: Record<string, unknown> = {}, id = soy, agent = owner) => agent.post(`/api/ingredients/${id}/purchases`).send(body(fields));
const bought = async (fields: Record<string, unknown> = {}, id = soy, agent = owner) => (await buy(fields, id, agent).expect(201)).body;

async function stored(id = soy) {
  const r = (await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4, avg_version FROM ingredients WHERE id = $1', [id])).rows[0];
  return {
    onHandMilli: toSafeInteger(r.on_hand_milli),
    avgE4: r.avg_cost_e4 === null ? null : toSafeInteger(r.avg_cost_e4),
    version: r.avg_version as number,
  };
}
async function lines(id = soy) {
  return (await scoped.query<any>(`SELECT *, effective_date::text AS day, expiry_date::text AS expiry FROM stock_movements WHERE ingredient_id = $1 ORDER BY id`, [id])).rows;
}
/** The whole ledger worked out again by the stock maths, to compare with the cached copy. */
async function replayed(id = soy) {
  return replay(
    (await lines(id)).map((l) => ({
      id: l.id,
      kind: l.kind,
      effectiveDate: l.day,
      quantityMilli: toSafeInteger(l.quantity_milli),
      totalCostCents: l.total_cost_cents,
      reversesMovementId: l.reverses_movement_id,
    })),
  );
}

describe('recording a purchase (INV-02, INV-04)', () => {
  it('reproduces the BRD example: 496 mL at P0.10/mL plus 500 mL for P60 gives P0.11004/mL', async () => {
    await bought({ quantity: '496', totalCostCents: 4960 });
    expect(await stored()).toEqual({ onHandMilli: 496_000, avgE4: 100_000, version: 1 });
    const second = await bought({ quantity: '500', totalCostCents: 6000 });
    expect(second.ingredient).toMatchObject({ onHandMilli: 996_000, avgCostE4: 110_040 });
    expect(await stored()).toEqual({ onHandMilli: 996_000, avgE4: 110_040, version: 2 });
    expect(lineCostCents(2000, 110_040)).toBe(22);
  });

  it('stores the line as entered, with who and when', async () => {
    const r = await bought({ quantity: '2.5', totalCostCents: 1250, supplier: '  Market ', reference: ' OR-1001 ', expiryDate: '2027-01-31' });
    const [line] = await lines();
    expect(line.id).toBe(r.movementId);
    expect(line).toMatchObject({ kind: 'purchase', total_cost_cents: 1250, supplier: 'Market', reference: 'OR-1001', day: today(), expiry: '2027-01-31', reason: '' });
    expect(toSafeInteger(line.quantity_milli)).toBe(2500);
    expect(line.entered_by_name).toBe('Frozen Foods Owner');
    expect(line.entered_by_user_id).toBeGreaterThan(0);
    expect(line.entered_at).toBeTruthy();
    expect([line.run_id, line.run_cost_id, line.unit_cost_e4, line.reverses_movement_id]).toEqual([null, null, null, null]);
  });

  it('leaves supplier, reference and expiry optional', async () => {
    await bought();
    expect((await lines())[0]).toMatchObject({ supplier: '', reference: '', expiry: null });
    await bought({ expiryDate: null });
    expect((await lines())[1].expiry).toBeNull();
  });

  it('uses the purchase price when on hand is zero or below (Q33)', async () => {
    await bought({ quantity: '100', totalCostCents: 1000 });
    await scoped.query('UPDATE ingredients SET on_hand_milli = -20000 WHERE id = $1', [soy]);
    await bought({ quantity: '100', totalCostCents: 3000 });
    expect(await stored()).toMatchObject({ onHandMilli: 80_000, avgE4: 300_000 });
  });

  it('allows a free purchase, which lowers the average', async () => {
    await bought({ quantity: '100', totalCostCents: 1000 });
    await bought({ quantity: '100', totalCostCents: 0 });
    expect(await stored()).toMatchObject({ onHandMilli: 200_000, avgE4: 50_000 });
  });

  it('moves the version only when the average really changes', async () => {
    await bought({ quantity: '100', totalCostCents: 1000 });
    await bought({ quantity: '100', totalCostCents: 1000 });
    expect(await stored()).toMatchObject({ onHandMilli: 200_000, avgE4: 100_000, version: 1 });
  });

  it('does not move the version for a back-dated line that leaves the average as it was', async () => {
    await bought({ effectiveDate: addDays(today(), -1), quantity: '100', totalCostCents: 1000 });
    await bought({ effectiveDate: addDays(today(), -5), quantity: '100', totalCostCents: 1000 });
    expect(await stored()).toEqual({ onHandMilli: 200_000, avgE4: 100_000, version: 1 });
  });

  it('keeps each ingredient apart', async () => {
    const vinegar = await addIngredient('Vinegar', 'mL');
    await bought({ quantity: '100', totalCostCents: 1000 });
    await bought({ quantity: '100', totalCostCents: 5000 }, vinegar);
    expect(await stored()).toMatchObject({ onHandMilli: 100_000, avgE4: 100_000 });
    expect(await stored(vinegar)).toMatchObject({ onHandMilli: 100_000, avgE4: 500_000 });
  });
});

describe('quantities as typed (Q42, Q53)', () => {
  it('converts kg to g and L to mL exactly', async () => {
    const pork = await addIngredient('Pork', 'g');
    await bought({ quantity: '1.25', unit: 'kg', totalCostCents: 40000 }, pork);
    expect(await stored(pork)).toMatchObject({ onHandMilli: 1_250_000, avgE4: 320_000 });
    await bought({ quantity: '0.1', unit: 'L', totalCostCents: 1000 });
    expect(await stored()).toMatchObject({ onHandMilli: 100_000, avgE4: 100_000 });
  });

  it('refuses a unit that does not fit the ingredient', async () => {
    const r = await buy({ quantity: '1', unit: 'kg' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('This ingredient is measured in mL, so it cannot be entered in kg.');
    expect(await lines()).toEqual([]);
  });

  it('takes whole pieces only', async () => {
    const wrappers = await addIngredient('Wrappers', 'pc');
    await bought({ quantity: '300', unit: 'pc', totalCostCents: 18000 }, wrappers);
    expect(await stored(wrappers)).toMatchObject({ onHandMilli: 300_000, avgE4: 600_000 });
    const half = await buy({ quantity: '2.5', unit: 'pc' }, wrappers);
    expect(half.status).toBe(400);
    expect(half.body.error).toBe('Pieces must be whole numbers.');
  });

  it('refuses too many decimals, odd text and zero, with plain messages', async () => {
    const cases: [string, string][] = [
      ['2.0005', 'A quantity in mL can have at most 3 decimals.'],
      ['1,5', 'Enter the quantity as a number, for example 2.5.'],
      ['-5', 'Enter the quantity as a number, for example 2.5.'],
      ['', 'Enter the quantity as a number, for example 2.5.'],
      ['0', 'The quantity must be more than zero.'],
      ['0.000', 'The quantity must be more than zero.'],
    ];
    for (const [quantity, message] of cases) {
      const r = await buy({ quantity });
      expect(r.status, quantity).toBe(400);
      expect(r.body.error, quantity).toBe(message);
    }
    expect(await lines()).toEqual([]);
    expect(await stored()).toEqual({ onHandMilli: 0, avgE4: null, version: 0 });
  });

  it('refuses a quantity sent as a number, or too long', async () => {
    expect((await buy({ quantity: 500 })).status).toBe(400);
    expect((await buy({ quantity: '1'.repeat(31) })).status).toBe(400);
    expect((await buy({ quantity: undefined })).status).toBe(400);
    expect((await buy({ unit: 'lb' })).status).toBe(400);
  });
});

describe('limits (design note 2.1)', () => {
  it('holds 10,000,000 base units and refuses more, naming the unit', async () => {
    await bought({ quantity: '10000000', totalCostCents: 1000 });
    const r = await buy({ quantity: '10000000.001' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('A quantity can be at most 10,000,000 mL per entry.');
    const big = await buy({ quantity: '10001', unit: 'L' });
    expect(big.body.error).toBe('A quantity can be at most 10,000,000 mL (10,000 L) per entry.');
  });

  it('holds a total of P20,000,000 and refuses more', async () => {
    await bought({ quantity: '1000', totalCostCents: 2_000_000_000 });
    expect((await buy({ totalCostCents: 2_000_000_001 })).status).toBe(400);
    for (const totalCostCents of [-1, 1.5, '100', null, undefined]) {
      expect((await buy({ totalCostCents })).status, String(totalCostCents)).toBe(400);
    }
  });

  it('refuses a unit price above P1,000,000 with a plain message', async () => {
    await bought({ quantity: '0.001', totalCostCents: 100_000 });
    const r = await buy({ quantity: '0.001', totalCostCents: 100_001 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('The price per g, mL or piece can be at most P1,000,000. Check the quantity and the total.');
  });

  it('limits supplier and reference, and refuses hidden characters in them', async () => {
    await bought({ supplier: 'x'.repeat(120), reference: 'y'.repeat(120) });
    for (const fields of [{ supplier: 'x'.repeat(121) }, { reference: 'x'.repeat(121) }, { supplier: 'a\u0000b' }, { reference: 'a\u200bb' }, { supplier: 5 }]) {
      expect((await buy(fields)).status, JSON.stringify(fields)).toBe(400);
    }
    expect((await bought({ supplier: "Mang Tomas' Meats, Piña St." })).ingredient).toBeTruthy();
  });
});

describe('dates (Q45, Q54)', () => {
  it('accepts today and any earlier day, and refuses the future', async () => {
    await bought({ effectiveDate: today() });
    await bought({ effectiveDate: '2001-02-03' });
    const r = await buy({ effectiveDate: addDays(today(), 1) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('The purchase date cannot be in the future.');
  });

  it('refuses dates that do not exist or the database cannot hold', async () => {
    for (const effectiveDate of ['2026-02-30', 'yesterday', '', undefined, 20261101, '0000-01-01']) {
      expect((await buy({ effectiveDate })).status, String(effectiveDate)).toBe(400);
    }
    expect((await buy({ expiryDate: '2026-02-30' })).status).toBe(400);
    expect((await buy({ expiryDate: '0000-01-01' })).status).toBe(400);
    expect(await lines()).toEqual([]);
  });

  it('works a back-dated purchase out in date order', async () => {
    const [d1, d2, d3] = [addDays(today(), -9), addDays(today(), -6), addDays(today(), -3)];
    await bought({ effectiveDate: d1, quantity: '1000', totalCostCents: 10000 }); // P0.10
    await bought({ effectiveDate: d3, quantity: '1000', totalCostCents: 30000 }); // average P0.20
    expect(await stored()).toMatchObject({ onHandMilli: 2_000_000, avgE4: 200_000 });
    await bought({ effectiveDate: d2, quantity: '2000', totalCostCents: 60000 }); // P0.30, before the last one
    // Date order: 1,000 at P0.10; then 2,000 at P0.30 gives 3,000 at about P0.2333; then 1,000 at P0.30 gives P0.25.
    expect(await stored()).toMatchObject({ onHandMilli: 4_000_000, avgE4: 250_000, version: 3 });
    expect(await replayed()).toEqual({ onHandMilli: 4_000_000, avgE4: 250_000 });
  });

  it('replays only the ingredient being changed', async () => {
    const vinegar = await addIngredient('Vinegar', 'mL');
    await bought({ quantity: '100', totalCostCents: 1000 });
    await bought({ quantity: '300', totalCostCents: 15000 }, vinegar);
    await bought({ effectiveDate: addDays(today(), -5), quantity: '100', totalCostCents: 3000 });
    expect(await stored()).toMatchObject({ onHandMilli: 200_000, avgE4: 200_000 });
    expect(await stored(vinegar)).toMatchObject({ onHandMilli: 300_000, avgE4: 500_000, version: 1 });
  });

  it('gets a different average from date order than from entry order when stock ran out in between', async () => {
    const [d1, d2, d3, d4] = [-9, -7, -5, -3].map((n) => addDays(today(), n));
    await bought({ effectiveDate: d1, quantity: '1000', totalCostCents: 10000 }); // 1,000 at P0.10
    // All of it spilled: written directly, because corrections come in a later task.
    await scoped.query(
      `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, reason, entered_by_user_id, entered_by_name)
       VALUES ($1, 'spillage', $2, -1000000, 'Spilled', 1, 'Owner')`,
      [soy, d3],
    );
    await scoped.query('UPDATE ingredients SET on_hand_milli = 0 WHERE id = $1', [soy]);
    await bought({ effectiveDate: d4, quantity: '1000', totalCostCents: 40000 }); // stock was 0, so P0.40
    expect(await stored()).toMatchObject({ onHandMilli: 1_000_000, avgE4: 400_000 });
    // A purchase at P0.30 dated before the spill. In date order: P0.10 and P0.30 make P0.20, 1,000 spilled,
    // then 1,000 at P0.40 on top of 1,000 at P0.20 is P0.30. In entry order it would be P0.35.
    await bought({ effectiveDate: d2, quantity: '1000', totalCostCents: 30000 });
    expect(await stored()).toMatchObject({ onHandMilli: 2_000_000, avgE4: 300_000 });
  });

  it('counts a line dated the same day as the latest as the newest', async () => {
    const day = addDays(today(), -2);
    await bought({ effectiveDate: day, quantity: '100', totalCostCents: 1000 });
    await bought({ effectiveDate: day, quantity: '100', totalCostCents: 3000 });
    expect(await stored()).toMatchObject({ avgE4: 200_000 });
    expect(await replayed()).toEqual({ onHandMilli: 200_000, avgE4: 200_000 });
  });

  it('keeps the cached copy equal to the ledger through a mix of dates', async () => {
    const offsets = [-5, -8, -2, -8, 0, -20, -1, -3];
    for (const [i, days] of offsets.entries()) {
      await bought({ effectiveDate: addDays(today(), days), quantity: String(100 + i * 37), totalCostCents: 1000 + i * 777 });
      const { version: _version, ...cached } = await stored();
      expect(cached, `after line ${i}`).toEqual(await replayed());
    }
  });
});

describe('archived ingredients (Q50)', () => {
  it('cannot be bought, and nothing is stored, until turned back on', async () => {
    await owner.patch(`/api/ingredients/${soy}`).send({ active: false }).expect(200);
    const r = await buy();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('This ingredient is archived, so it cannot be bought. The owner can turn it back on.');
    expect(await lines()).toEqual([]);
    await owner.patch(`/api/ingredients/${soy}`).send({ active: true }).expect(200);
    await bought();
  });
});

describe('who can record a purchase (INV-14)', () => {
  it('lets staff record one, saves their name, and shows them no cost', async () => {
    await bought({ quantity: '100', totalCostCents: 1000 });
    const r = await buy({ quantity: '300', totalCostCents: 9000 }, soy, staff);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      movementId: r.body.movementId,
      ingredient: { id: soy, name: 'Soy sauce', baseUnit: 'mL', onHandMilli: 400_000, lowStockMilli: null, active: true, lastCountDate: null },
    });
    expect(r.text).not.toMatch(/avg/i);
    expect(r.text).not.toContain('250000');
    expect((await lines())[1].entered_by_name).toBe('Staff Member');
    expect(await stored()).toMatchObject({ avgE4: 250_000 });
  });

  it('shows the owner the average', async () => {
    expect((await bought({ quantity: '100', totalCostCents: 1000 })).ingredient.avgCostE4).toBe(100_000);
  });

  it('refuses anyone not signed in and the admin account', async () => {
    const admin = await createAdminAgent(app, db);
    expect((await request(app).post(`/api/ingredients/${soy}/purchases`).send(body())).status).toBe(401);
    expect((await admin.post(`/api/ingredients/${soy}/purchases`).send(body())).status).toBe(403);
    expect(await lines()).toEqual([]);
  });

  it('refuses a lapsed or suspended business, with nothing stored', async () => {
    await db.query(`UPDATE tenants SET status = 'cancelled' WHERE id = $1`, [tenantId]);
    const r = await buy();
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('read_only');
    expect((await buy({}, soy, staff)).status).toBe(402);
    await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);
    expect((await buy()).body.code).toBe('suspended');
    expect(await lines()).toEqual([]);
  });
});

describe('one business cannot buy for another', () => {
  it('answers "not found", and nothing is stored', async () => {
    const r = await buy({}, soy, other);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Ingredient not found');
    expect(await lines()).toEqual([]);
    expect(await stored()).toEqual({ onHandMilli: 0, avgE4: null, version: 0 });
  });

  it('answers plainly for an id that does not exist or is not valid', async () => {
    expect((await buy({}, 9999)).status).toBe(404);
    expect((await owner.post('/api/ingredients/abc/purchases').send(body())).status).toBe(400);
    expect((await owner.post('/api/ingredients/2147483648/purchases').send(body())).status).toBe(400);
  });
});

describe('never takes figures from the request', () => {
  it('ignores extra fields', async () => {
    await bought({ onHandMilli: 999, avgCostE4: 999, kind: 'opening', tenantId: 999, enteredByName: 'Someone else', runId: 1 });
    expect((await lines())[0]).toMatchObject({ kind: 'purchase', entered_by_name: 'Frozen Foods Owner', run_id: null, tenant_id: tenantId });
    expect(await stored()).toMatchObject({ onHandMilli: 500_000, avgE4: 120_000 });
  });
});

describe('the shared ledger writer', () => {
  const actor = { id: 1, name: 'Owner' };
  const line = (effectiveDate: string, quantityMilli: number, totalCostCents: number) =>
    ({ kind: 'purchase', quantityMilli, totalCostCents, effectiveDate }) as const;

  it('keeps count when several lines of one ingredient go through one lock', async () => {
    const d = today();
    await scoped.tx(async (q) => {
      const locked = (await lockIngredients(q, [soy])).get(soy)!;
      await addLedgerLine(q, locked, line(d, 100_000, 1000), actor);
      await addLedgerLine(q, locked, line(d, 100_000, 3000), actor);
      expect(locked.state).toEqual({ onHandMilli: 200_000, avgE4: 200_000 });
    });
    expect(await stored()).toEqual({ onHandMilli: 200_000, avgE4: 200_000, version: 2 });
    expect(await replayed()).toEqual({ onHandMilli: 200_000, avgE4: 200_000 });
  });

  it('keeps count when a back-dated line follows another in the same lock, and the other way round', async () => {
    const [early, late] = [addDays(today(), -5), today()];
    await scoped.tx(async (q) => {
      const locked = (await lockIngredients(q, [soy])).get(soy)!;
      await addLedgerLine(q, locked, line(late, 100_000, 1000), actor);
      await addLedgerLine(q, locked, line(early, 100_000, 3000), actor);
      await addLedgerLine(q, locked, line(late, 100_000, 2000), actor);
    });
    const { version, ...cached } = await stored();
    expect(cached).toEqual({ onHandMilli: 300_000, avgE4: 200_000 });
    expect(cached).toEqual(await replayed());
    expect(version).toBe(2); // P0.10, then P0.20 after the replay; the third line leaves it at P0.20
  });

  it('refuses part pieces, wherever the line comes from', async () => {
    const wrappers = await addIngredient('Wrappers', 'pc');
    await expect(
      scoped.tx(async (q) => addLedgerLine(q, (await lockIngredients(q, [wrappers])).get(wrappers)!, line(today(), 1500, 100), actor)),
    ).rejects.toThrow(new CalcError('Pieces must be whole numbers.'));
    expect(await lines(wrappers)).toEqual([]);
  });

  it('stores the name trimmed, and treats a blank name as a server error, not the person\'s mistake', async () => {
    await scoped.tx(async (q) => addLedgerLine(q, (await lockIngredients(q, [soy])).get(soy)!, line(today(), 1000, 10), { id: 1, name: '  Owner ' }));
    expect((await lines())[0].entered_by_name).toBe('Owner');
    for (const name of ['', '   ']) {
      const failed = await scoped
        .tx(async (q) => addLedgerLine(q, (await lockIngredients(q, [soy])).get(soy)!, line(today(), 1000, 10), { id: 1, name }))
        .catch((e) => e);
      expect(failed).toBeInstanceOf(Error);
      expect(failed).not.toBeInstanceOf(CalcError);
      expect(failed.message).toMatch(/name of the person/);
    }
    expect(await lines()).toHaveLength(1);
  });

  it('saves the email for someone with no name', async () => {
    await db.query(`UPDATE users SET name = '   ' WHERE email = 'staff@a.test'`);
    await bought({}, soy, staff);
    expect((await lines())[0].entered_by_name).toBe('staff@a.test');
  });

  it('turns the stock maths\' refusals into a plain 400 and leaves other errors alone', () => {
    const refusal = plainRefusal(new CalcError('Nothing to correct.')) as any;
    expect([refusal.status, refusal.message]).toEqual([400, 'Nothing to correct.']);
    const bug = new Error('bug');
    expect(plainRefusal(bug)).toBe(bug);
  });
});

describe('locking several ingredients (design note 4, rule 1)', () => {
  it('locks each id once, in ascending order, whatever order they come in', async () => {
    const vinegar = await addIngredient('Vinegar', 'mL');
    const pork = await addIngredient('Pork', 'g');
    const asked: unknown[] = [];
    const texts: string[] = [];
    const locked = await scoped.tx(async (q) =>
      lockIngredients({ ...q, query: (text: string, params?: unknown[]) => (texts.push(text), asked.push(params![0]), q.query(text, params)) } as any, [pork, soy, vinegar, soy]),
    );
    expect(asked).toEqual([[soy, vinegar, pork]]);
    expect(texts[0]).toMatch(/ORDER BY id FOR NO KEY UPDATE/);
    expect([...locked.keys()]).toEqual([soy, vinegar, pork]);
    expect(locked.get(pork)).toMatchObject({ baseUnit: 'g', active: true, state: { onHandMilli: 0, avgE4: null } });
  });

  it('is "not found" if any id is missing or belongs to another business', async () => {
    const theirs = (await other.post('/api/ingredients').send({ name: 'Theirs', baseUnit: 'g' }).expect(201)).body.id;
    await expect(scoped.tx((q) => lockIngredients(q, [soy, 9999]))).rejects.toThrow('Ingredient not found');
    await expect(scoped.tx((q) => lockIngredients(q, [soy, theirs]))).rejects.toThrow('Ingredient not found');
  });
});

describe('order of work inside the save (design note 4, rule 1)', () => {
  /** A stand-in database: answers the lock with this unit and records the SQL in order. */
  const fakeDb = (baseUnit: string, active = true) => {
    const seen: string[] = [];
    const q = {
      query: async (text: string) => {
        seen.push(text);
        if (text.includes('FOR NO KEY UPDATE')) {
          return { rows: [{ id: 1, base_unit: baseUnit, active, on_hand_milli: '0', avg_cost_e4: null }] };
        }
        return { rows: [{ id: 7, latest: null }] };
      },
    };
    return { seen, db: { tx: async (fn: any) => fn(q) } as unknown as Db };
  };
  const input = { effectiveDate: '2026-01-01', quantity: '1', unit: 'kg' as const, totalCostCents: 100, supplier: '', reference: '' };
  const actor = { id: 1, name: 'Owner' };

  it('takes the lock before anything else, and uses the unit the lock read', async () => {
    const { db: fake, seen } = fakeDb('mL');
    await expect(recordPurchase(fake, 1, input, actor, true)).rejects.toThrow('This ingredient is measured in mL');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('FOR NO KEY UPDATE');
  });

  it('uses the archived status the lock read', async () => {
    const { db: fake, seen } = fakeDb('g', false);
    await expect(recordPurchase(fake, 1, input, actor, true)).rejects.toThrow(/archived/);
    expect(seen).toHaveLength(1);
  });

  describe('"today" is the business\'s day, not the server\'s', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('accepts a date that is already today in Manila but still yesterday in UTC', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-05T16:30:00Z')); // 00:30 on Nov 6 in Manila
      const { db: fake, seen } = fakeDb('mL');
      await expect(recordPurchase(fake, 1, { ...input, effectiveDate: '2026-11-06' }, actor, true)).rejects.toThrow('measured in mL');
      expect(seen).toHaveLength(1);
      await expect(recordPurchase(fake, 1, { ...input, effectiveDate: '2026-11-07' }, actor, true)).rejects.toThrow(/future/);
    });
  });

  it('checks the date before touching the database', async () => {
    const { db: fake, seen } = fakeDb('g');
    await expect(recordPurchase(fake, 1, { ...input, effectiveDate: addDays(today(), 1) }, actor, true)).rejects.toThrow(/future/);
    expect(seen).toHaveLength(0);
  });
});
