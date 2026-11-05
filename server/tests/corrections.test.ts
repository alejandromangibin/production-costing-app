import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replay, toSafeInteger } from '../src/calc/stock';
import { CalcError } from '../src/calc/types';
import { addDays, localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { acceptToken, inviteStaff } from '../src/services/accounts';
import { addLedgerLine, lockIngredients, recordCorrection, recordOpening } from '../src/services/stockLedger';
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

const openingBody = (fields: Record<string, unknown> = {}) => ({
  effectiveDate: today(),
  quantity: '1000',
  unit: 'mL',
  totalCostCents: 10000,
  reason: 'Opening balance',
  ...fields,
});
const open = (fields: Record<string, unknown> = {}, id = soy, agent = owner) => agent.post(`/api/ingredients/${id}/opening`).send(openingBody(fields));
const opened = async (fields: Record<string, unknown> = {}, id = soy) => (await open(fields, id).expect(201)).body;

const correctionBody = (kind: string, quantity: string, fields: Record<string, unknown> = {}) => ({
  kind,
  effectiveDate: today(),
  quantity,
  unit: 'mL',
  reason: 'Checked by the owner',
  ...fields,
});
const correct = (kind: string, quantity: string, fields: Record<string, unknown> = {}, id = soy, agent = owner) =>
  agent.post(`/api/ingredients/${id}/corrections`).send(correctionBody(kind, quantity, fields));
const corrected = async (kind: string, quantity: string, fields: Record<string, unknown> = {}, id = soy) =>
  (await correct(kind, quantity, fields, id).expect(201)).body;
const buy = (fields: Record<string, unknown> = {}, id = soy) =>
  owner.post(`/api/ingredients/${id}/purchases`).send({ effectiveDate: today(), quantity: '100', unit: 'mL', totalCostCents: 1000, ...fields }).expect(201);

async function stored(id = soy) {
  const r = (await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4, avg_version FROM ingredients WHERE id = $1', [id])).rows[0];
  return {
    onHandMilli: toSafeInteger(r.on_hand_milli),
    avgE4: r.avg_cost_e4 === null ? null : toSafeInteger(r.avg_cost_e4),
    version: r.avg_version as number,
  };
}
async function lines(id = soy) {
  return (await scoped.query<any>(`SELECT *, effective_date::text AS day FROM stock_movements WHERE ingredient_id = $1 ORDER BY id`, [id])).rows;
}
async function expectCopyMatchesLedger(id = soy) {
  const { version: _version, ...cached } = await stored(id);
  expect(cached).toEqual(replay(asLedger(await lines(id))));
}
const asLedger = (rows: any[]) =>
  rows.map((l) => ({
    id: l.id,
    kind: l.kind,
    effectiveDate: l.day,
    quantityMilli: toSafeInteger(l.quantity_milli),
    totalCostCents: l.total_cost_cents,
    reversesMovementId: l.reverses_movement_id,
  }));
/** A reversal, written directly with the copy replayed: reversing comes in a later task. */
async function reverse(line: any) {
  await scoped.query(
    `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, reason, reverses_movement_id, entered_by_user_id, entered_by_name)
     VALUES ($1, 'purchase_reversal', $2, $3, 'Wrong entry', $4, 1, 'Owner')`,
    [line.ingredient_id, line.day, -toSafeInteger(line.quantity_milli), line.id],
  );
  const after = replay(asLedger(await lines(line.ingredient_id)));
  await scoped.query('UPDATE ingredients SET on_hand_milli = $2, avg_cost_e4 = $3 WHERE id = $1', [line.ingredient_id, after.onHandMilli, after.avgE4]);
}

describe('opening balance (INV-08, Q25, Q46)', () => {
  it('records quantity and cost, sets the starting average, and saves who, when and why', async () => {
    const r = await opened({ quantity: '1000', totalCostCents: 10000, reason: '  Opening balance ' });
    expect(r.ingredient).toMatchObject({ onHandMilli: 1_000_000, avgCostE4: 100_000 });
    const [line] = await lines();
    expect(line.id).toBe(r.movementId);
    expect(line).toMatchObject({ kind: 'opening', total_cost_cents: 10000, reason: 'Opening balance', day: today(), entered_by_name: 'Frozen Foods Owner', supplier: '', reference: '', expiry_date: null });
    expect(toSafeInteger(line.quantity_milli)).toBe(1_000_000);
    expect(await stored()).toEqual({ onHandMilli: 1_000_000, avgE4: 100_000, version: 1 });
  });

  it('is entered once per ingredient, and nothing changes on a second try', async () => {
    await opened();
    const r = await open({ quantity: '5', totalCostCents: 5 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('This ingredient already has an opening balance.');
    expect(await lines()).toHaveLength(1);
    expect(await stored()).toEqual({ onHandMilli: 1_000_000, avgE4: 100_000, version: 1 });
  });

  it('is counted per ingredient', async () => {
    const vinegar = await addIngredient('Vinegar', 'mL');
    await opened();
    await opened({}, vinegar);
    expect(await stored(vinegar)).toMatchObject({ onHandMilli: 1_000_000 });
  });

  it('can be entered again once the wrong one is reversed (Q51)', async () => {
    await opened({ totalCostCents: 999_000 });
    await reverse((await lines())[0]);
    await opened({ totalCostCents: 10000 });
    const { version: _v, ...now } = await stored();
    expect(now).toEqual({ onHandMilli: 1_000_000, avgE4: 100_000 });
    await expectCopyMatchesLedger();
    expect((await open()).status).toBe(409);
  });

  it('counts a purchase separately: an opening can still be entered after one, in date order', async () => {
    await buy({ quantity: '100', totalCostCents: 3000 }); // today, P0.30
    const r = await opened({ effectiveDate: addDays(today(), -5), quantity: '100', totalCostCents: 1000 }); // P0.10, earlier
    expect(r.ingredient).toMatchObject({ onHandMilli: 200_000, avgCostE4: 200_000 });
    await expectCopyMatchesLedger();
  });

  it('sets the average for stock that had none (Q49)', async () => {
    await corrected('count_correction', '300');
    expect(await stored()).toMatchObject({ onHandMilli: 300_000, avgE4: null });
    const r = await opened({ quantity: '100', totalCostCents: 2000 });
    expect(r.ingredient).toMatchObject({ onHandMilli: 400_000, avgCostE4: 200_000 });
  });

  it('converts kg and L, takes whole pieces only, and checks the limits', async () => {
    const pork = await addIngredient('Pork', 'g');
    await opened({ quantity: '2', unit: 'kg', totalCostCents: 64000 }, pork);
    expect(await stored(pork)).toMatchObject({ onHandMilli: 2_000_000, avgE4: 320_000 });
    const wrappers = await addIngredient('Wrappers', 'pc');
    const refusals: [Record<string, unknown>, number, string | RegExp][] = [
      [{ quantity: '2.5', unit: 'pc' }, wrappers, 'Pieces must be whole numbers.'],
      [{ quantity: '1', unit: 'kg' }, soy, 'This ingredient is measured in mL, so it cannot be entered in kg.'],
      [{ quantity: '0' }, soy, 'The quantity must be more than zero.'],
      [{ quantity: '0.001', totalCostCents: 100_001 }, soy, 'The price per g, mL or piece can be at most P1,000,000. Check the quantity and the total.'],
    ];
    for (const [fields, id, message] of refusals) {
      const r = await open(fields, id);
      expect(r.status, JSON.stringify(fields)).toBe(400);
      expect(r.body.error).toBe(message);
    }
    expect((await open({ totalCostCents: 2_000_000_001 })).status).toBe(400);
    expect((await open({ totalCostCents: undefined })).status).toBe(400);
    expect(await lines()).toEqual([]);
  });

  it('saves the reason the owner gave', async () => {
    await opened({ reason: 'Stock at handover from the old shop' });
    expect((await lines())[0].reason).toBe('Stock at handover from the old shop');
  });

  it('blends into the average when dated after an earlier purchase', async () => {
    await buy({ effectiveDate: addDays(today(), -5), quantity: '100', totalCostCents: 1000 }); // P0.10
    const r = await opened({ quantity: '100', totalCostCents: 3000 }); // P0.30
    expect(r.ingredient).toMatchObject({ onHandMilli: 200_000, avgCostE4: 200_000 });
  });

  it('holds no supplier, reference or expiry, whatever is sent', async () => {
    await opened({ supplier: 'X', reference: 'Y', expiryDate: '2027-01-01' });
    expect((await lines())[0]).toMatchObject({ supplier: '', reference: '', expiry_date: null });
  });

  it('needs a reason, and refuses a future date', async () => {
    for (const reason of ['', '   ', '\n\t', undefined, 5]) {
      expect((await open({ reason })).status, JSON.stringify(reason)).toBe(400);
    }
    const r = await open({ effectiveDate: addDays(today(), 1) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('The date cannot be in the future.');
    for (const effectiveDate of ['0000-01-01', '2026-02-30', undefined]) {
      expect((await open({ effectiveDate })).status, String(effectiveDate)).toBe(400);
    }
    expect(await lines()).toEqual([]);
  });
});

describe('spillage and spoilage (INV-08)', () => {
  beforeEach(async () => {
    await opened({ quantity: '1000', totalCostCents: 10000 });
  });

  it('take the quantity off on hand and leave the average and its version alone', async () => {
    const spilled = await corrected('spillage', '200', { reason: 'Dropped a bottle' });
    expect(spilled.ingredient).toMatchObject({ onHandMilli: 800_000, avgCostE4: 100_000 });
    const spoiled = await corrected('spoilage', '50.5', { reason: 'Went bad' });
    expect(spoiled.ingredient).toMatchObject({ onHandMilli: 749_500, avgCostE4: 100_000 });
    const [, first, second] = await lines();
    expect(first).toMatchObject({ kind: 'spillage', reason: 'Dropped a bottle', total_cost_cents: null, entered_by_name: 'Frozen Foods Owner' });
    expect(toSafeInteger(first.quantity_milli)).toBe(-200_000);
    expect(second.kind).toBe('spoilage');
    expect(toSafeInteger(second.quantity_milli)).toBe(-50_500);
    expect((await stored()).version).toBe(1);
  });

  it('can take on hand below zero', async () => {
    expect((await corrected('spillage', '1500')).ingredient.onHandMilli).toBe(-500_000);
  });

  it('refuses zero, odd text and too many decimals with plain messages', async () => {
    expect((await correct('spillage', '0')).body.error).toBe('The quantity must be more than zero.');
    expect((await correct('spoilage', '0.000')).body.error).toBe('The quantity must be more than zero.');
    expect((await correct('spillage', '-5')).body.error).toBe('Enter the quantity as a number, for example 2.5.');
    expect((await correct('spillage', '2.0005')).body.error).toBe('A quantity in mL can have at most 3 decimals.');
    expect((await correct('spillage', '10000000.001')).body.error).toBe('A quantity can be at most 10,000,000 mL per entry.');
    expect((await correct('spillage', '1', { unit: 'kg' })).status).toBe(400);
    expect(await lines()).toHaveLength(1);
  });

  it('take whole pieces only, also when the line is written directly', async () => {
    const wrappers = await addIngredient('Wrappers', 'pc');
    await opened({ quantity: '100', unit: 'pc' }, wrappers);
    expect((await correct('spillage', '1.5', { unit: 'pc' }, wrappers)).body.error).toBe('Pieces must be whole numbers.');
    await expect(
      scoped.tx(async (q) =>
        addLedgerLine(
          q,
          (await lockIngredients(q, [wrappers])).get(wrappers)!,
          { kind: 'spillage', quantityMilli: -1500, totalCostCents: null, effectiveDate: today(), reason: 'x' },
          { id: 1, name: 'Owner' },
        ),
      ),
    ).rejects.toThrow(new CalcError('Pieces must be whole numbers.'));
  });

  it('accepts only the three correction kinds', async () => {
    for (const kind of ['opening', 'purchase', 'purchase_reversal', 'run_use', 'void_return', 'theft', '', undefined]) {
      expect((await correct(kind as string, '5')).status, String(kind)).toBe(400);
    }
    expect(await lines()).toHaveLength(1);
  });

  it('never take a cost from the request', async () => {
    await corrected('spillage', '10', { totalCostCents: 500, onHandMilli: 999, avgCostE4: 999 });
    expect((await lines())[1].total_cost_cents).toBeNull();
    expect(await stored()).toMatchObject({ onHandMilli: 990_000, avgE4: 100_000 });
  });
});

describe('stock-count correction (Q52)', () => {
  it('stores the difference between the count and the ledger, down or up', async () => {
    await opened({ quantity: '1000', totalCostCents: 10000 });
    const down = await corrected('count_correction', '950', { reason: 'Monthly count' });
    expect(down.ingredient).toMatchObject({ onHandMilli: 950_000, avgCostE4: 100_000 });
    expect(toSafeInteger((await lines())[1].quantity_milli)).toBe(-50_000);
    const up = await corrected('count_correction', '960.5', { reason: 'Found a bottle' });
    expect(up.ingredient.onHandMilli).toBe(960_500);
    expect(toSafeInteger((await lines())[2].quantity_milli)).toBe(10_500);
    expect((await stored()).version).toBe(1);
  });

  it('accepts a count of zero', async () => {
    await opened();
    expect((await corrected('count_correction', '0')).ingredient.onHandMilli).toBe(0);
  });

  it('accepts kg and L, converted', async () => {
    await opened({ quantity: '1000' });
    expect((await corrected('count_correction', '0.75', { unit: 'L' })).ingredient.onHandMilli).toBe(750_000);
  });

  it('says "nothing to correct" when the count matches, and stores nothing', async () => {
    await opened();
    const r = await correct('count_correction', '1000');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Nothing to correct: the count matches the recorded stock for that date.');
    expect(await lines()).toHaveLength(1);
    const empty = await correct('count_correction', '0', {}, await addIngredient('Vinegar', 'mL'));
    expect(empty.body.error).toBe('Nothing to correct: the count matches the recorded stock for that date.');
  });

  it('compares with the recorded stock on that date, not with today\'s on hand', async () => {
    await opened({ effectiveDate: addDays(today(), -9), quantity: '1000' });
    await buy({ effectiveDate: addDays(today(), -3), quantity: '500', totalCostCents: 5000 });
    const r = await correct('count_correction', '1000', { effectiveDate: addDays(today(), -6) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Nothing to correct: the count matches the recorded stock for that date.');
    expect((await lines()).map((l) => l.kind)).toEqual(['opening', 'purchase']);
  });

  it('counts the ledger as of the end of that date, and leaves later lines alone', async () => {
    const [d1, d2, d3] = [-9, -6, -3].map((n) => addDays(today(), n));
    await opened({ effectiveDate: d1, quantity: '1000', totalCostCents: 10000 });
    await buy({ effectiveDate: d3, quantity: '500', totalCostCents: 5000 });
    // On d2 the ledger says 1,000; the owner counted 900 then. The later purchase still stands.
    const r = await corrected('count_correction', '900', { effectiveDate: d2 });
    expect(toSafeInteger((await lines())[2].quantity_milli)).toBe(-100_000);
    expect(r.ingredient.onHandMilli).toBe(1_400_000);
    await expectCopyMatchesLedger();
  });

  it('includes lines dated the same day as the count', async () => {
    const day = addDays(today(), -3);
    await opened({ effectiveDate: day, quantity: '1000' });
    await corrected('spillage', '100', { effectiveDate: day });
    await corrected('count_correction', '850', { effectiveDate: day });
    expect(toSafeInteger((await lines())[2].quantity_milli)).toBe(-50_000);
  });

  it('is not fooled by a reversed line', async () => {
    await opened({ quantity: '1000' });
    await buy({ quantity: '500', totalCostCents: 5000 });
    const purchase = (await lines())[1];
    await reverse(purchase);
    await corrected('count_correction', '990');
    expect(toSafeInteger((await lines())[3].quantity_milli)).toBe(-10_000);
    await expectCopyMatchesLedger();
  });

  it('works when on hand is below zero', async () => {
    await opened({ quantity: '100' });
    await corrected('spillage', '150');
    const r = await corrected('count_correction', '20');
    expect(r.ingredient.onHandMilli).toBe(20_000);
    expect(toSafeInteger((await lines())[2].quantity_milli)).toBe(70_000);
  });

  it('leaves the average alone when dated on or after the latest line', async () => {
    await opened({ effectiveDate: addDays(today(), -9), quantity: '1000', totalCostCents: 10000 });
    await buy({ effectiveDate: addDays(today(), -3), quantity: '1000', totalCostCents: 30000 });
    const before = await stored();
    await corrected('count_correction', '1000.5', { effectiveDate: addDays(today(), -1) });
    await corrected('spillage', '1', { effectiveDate: addDays(today(), -1) });
    expect(await stored()).toMatchObject({ avgE4: before.avgE4, version: before.version });
  });

  it('moves the average when dated before a purchase, because that purchase is averaged against less stock', async () => {
    await opened({ effectiveDate: addDays(today(), -9), quantity: '1000', totalCostCents: 10000 }); // P0.10
    await buy({ effectiveDate: addDays(today(), -3), quantity: '1000', totalCostCents: 30000 }); // average P0.20
    expect(await stored()).toMatchObject({ avgE4: 200_000, version: 2 });
    // 500 spilled before that purchase: 500 at P0.10 plus 1,000 at P0.30 is 1,500 at about P0.2333.
    await corrected('spillage', '500', { effectiveDate: addDays(today(), -5) });
    expect(await stored()).toEqual({ onHandMilli: 1_500_000, avgE4: 233_333, version: 3 });
    // Counted 200 before that purchase: 200 at P0.10 plus 1,000 at P0.30 is 1,200 at about P0.2667.
    await corrected('count_correction', '200', { effectiveDate: addDays(today(), -4) });
    expect(await stored()).toEqual({ onHandMilli: 1_200_000, avgE4: 266_667, version: 4 });
    await expectCopyMatchesLedger();
  });

  it('refuses a difference above the limit with a message naming the unit, and a count above it', async () => {
    await opened({ quantity: '1000' });
    await corrected('spillage', '10000000');
    const r = await correct('count_correction', '10000000');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('The difference from the recorded stock can be at most 10,000,000 mL per entry.');
    expect((await correct('count_correction', '10000001')).body.error).toBe('A quantity can be at most 10,000,000 mL per entry.');
    expect(await lines()).toHaveLength(2);
  });

  it('refuses a difference above the limit going down too, naming the unit', async () => {
    await opened({ quantity: '10000000', totalCostCents: 1000 });
    await buy({ quantity: '1000', totalCostCents: 1000 });
    const r = await correct('count_correction', '0');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('The difference from the recorded stock can be at most 10,000,000 mL per entry.');
  });

  it('accepts a difference of exactly the limit, in both directions', async () => {
    await opened({ quantity: '10000000', totalCostCents: 1000 });
    expect((await corrected('count_correction', '0')).ingredient.onHandMilli).toBe(0);
    expect((await corrected('count_correction', '10000000')).ingredient.onHandMilli).toBe(10_000_000_000);
  });

  it('takes whole pieces only', async () => {
    const wrappers = await addIngredient('Wrappers', 'pc');
    await opened({ quantity: '100', unit: 'pc' }, wrappers);
    expect((await correct('count_correction', '98.5', { unit: 'pc' }, wrappers)).body.error).toBe('Pieces must be whole numbers.');
    expect((await corrected('count_correction', '98', { unit: 'pc' }, wrappers)).ingredient.onHandMilli).toBe(98_000);
  });
});

describe('reasons and dates on every correction', () => {
  it('requires a reason, keeps line breaks, and refuses hidden characters', async () => {
    for (const kind of ['spillage', 'spoilage', 'count_correction']) {
      for (const reason of ['', '    ', '\n \t', undefined, 5]) {
        expect((await correct(kind, '5', { reason })).status, `${kind} ${JSON.stringify(reason)}`).toBe(400);
      }
    }
    await opened();
    const r = await corrected('spillage', '5', { reason: '  Dropped\nin the freezer\r\n\tby Juan ' });
    expect(r.ingredient).toBeTruthy();
    expect((await lines())[1].reason).toBe('Dropped\nin the freezer\r\n\tby Juan');
    for (const reason of ['a\u0000b', 'a\u200bb', 'a\u0007b', 'a\u000bb', 'a\u000cb', 'a\u0085b', 'x'.repeat(301)]) {
      const refused = await correct('spillage', '5', { reason });
      expect(refused.status, JSON.stringify(reason).slice(0, 20)).toBe(400);
    }
    await corrected('spillage', '5', { reason: 'x'.repeat(300) });
    expect((await correct('spillage', '5', { reason: ' 　' })).body.error).toMatch(/reason is required/);
  });

  it('refuses the future and accepts any earlier day', async () => {
    await opened({ effectiveDate: addDays(today(), -30) });
    for (const kind of ['spillage', 'spoilage', 'count_correction']) {
      const r = await correct(kind, '5', { effectiveDate: addDays(today(), 1) });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('The date cannot be in the future.');
    }
    await corrected('spillage', '5', { effectiveDate: addDays(today(), -10) });
    for (const effectiveDate of ['2026-02-30', '0000-01-01', 'today', undefined]) {
      expect((await correct('spillage', '5', { effectiveDate })).status, String(effectiveDate)).toBe(400);
    }
  });

  it('keeps the cached copy equal to the ledger through a mix of everything', async () => {
    const steps: (() => Promise<unknown>)[] = [
      () => opened({ effectiveDate: addDays(today(), -20), quantity: '1000', totalCostCents: 12345 }),
      () => buy({ effectiveDate: addDays(today(), -5), quantity: '333', totalCostCents: 7777 }),
      () => corrected('spillage', '100.5', { effectiveDate: addDays(today(), -12) }),
      () => buy({ effectiveDate: addDays(today(), -15), quantity: '250', totalCostCents: 9999 }),
      () => corrected('count_correction', '10', { effectiveDate: addDays(today(), -10) }),
      () => buy({ effectiveDate: addDays(today(), -8), quantity: '77', totalCostCents: 1234 }),
      () => corrected('spoilage', '5', {}),
    ];
    for (const step of steps) {
      await step();
      await expectCopyMatchesLedger();
    }
  });
});

describe('archived ingredients (Q50)', () => {
  it('still take the owner\'s corrections, but not purchases', async () => {
    await opened();
    await owner.patch(`/api/ingredients/${soy}`).send({ active: false }).expect(200);
    await corrected('spillage', '10');
    await corrected('count_correction', '900');
    expect((await owner.post(`/api/ingredients/${soy}/purchases`).send({ effectiveDate: today(), quantity: '1', unit: 'mL', totalCostCents: 1 })).status).toBe(409);
    const vinegar = await addIngredient('Vinegar', 'mL');
    await owner.patch(`/api/ingredients/${vinegar}`).send({ active: false }).expect(200);
    await opened({}, vinegar);
  });
});

describe('who can do this (INV-14)', () => {
  it('refuses staff, with nothing stored', async () => {
    await opened();
    const r = await open({}, await addIngredient('Vinegar', 'mL'), staff);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Only the business owner can do this.');
    for (const kind of ['spillage', 'spoilage', 'count_correction']) {
      expect((await correct(kind, '5', {}, soy, staff)).status).toBe(403);
    }
    expect(await lines()).toHaveLength(1);
  });

  it('refuses anyone not signed in and the admin account', async () => {
    const admin = await createAdminAgent(app, db);
    for (const [agent, status] of [[request(app), 401], [admin, 403]] as const) {
      expect((await agent.post(`/api/ingredients/${soy}/opening`).send(openingBody())).status).toBe(status);
      expect((await agent.post(`/api/ingredients/${soy}/corrections`).send(correctionBody('spillage', '5'))).status).toBe(status);
    }
  });

  it('refuses a lapsed or suspended business, and staff get told it is the owner\'s to do', async () => {
    await db.query(`UPDATE tenants SET status = 'cancelled' WHERE id = $1`, [tenantId]);
    expect((await open()).status).toBe(402);
    expect((await correct('spillage', '5')).status).toBe(402);
    expect((await correct('spillage', '5', {}, soy, staff)).status).toBe(403);
    expect((await open({}, soy, staff)).status).toBe(403);
    await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);
    expect((await open()).body.code).toBe('suspended');
    expect(await lines()).toEqual([]);
  });
});

describe('one business cannot touch another\'s stock', () => {
  it('answers "not found", and nothing changes', async () => {
    await opened();
    expect((await open({}, soy, other)).status).toBe(404);
    const r = await correct('spillage', '5', {}, soy, other);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Ingredient not found');
    expect(await lines()).toHaveLength(1);
    expect((await stored()).onHandMilli).toBe(1_000_000);
  });

  it('answers plainly for an id that does not exist or is not valid', async () => {
    expect((await open({}, 9999)).status).toBe(404);
    expect((await correct('spillage', '5', {}, 9999)).status).toBe(404);
    expect((await owner.post('/api/ingredients/abc/opening').send(openingBody())).status).toBe(400);
    expect((await owner.post('/api/ingredients/2147483648/corrections').send(correctionBody('spillage', '5'))).status).toBe(400);
  });
});

describe('order of work inside the save (design note 4, rule 1)', () => {
  /** A stand-in database: answers the lock with this unit and records the SQL in order. */
  const fakeDb = (baseUnit: string, opts: { hasOpening?: boolean } = {}) => {
    const seen: string[] = [];
    const ingredient = { id: 1, name: 'X', base_unit: baseUnit, active: true, on_hand_milli: '0', low_stock_milli: null, avg_cost_e4: null };
    const q = {
      query: async (text: string) => {
        seen.push(text);
        if (text.includes('FOR NO KEY UPDATE')) return { rows: [ingredient] };
        if (text.includes("o.kind = 'opening'")) return { rows: opts.hasOpening ? [{}] : [] };
        if (text.includes('sum(quantity_milli)')) return { rows: [{ total: '5000' }] };
        if (text.includes('max(effective_date)')) return { rows: [{ latest: null }] };
        if (text.includes('INSERT')) return { rows: [{ id: 7 }] };
        return { rows: [ingredient] };
      },
    };
    return { seen, db: { tx: async (fn: any) => fn(q) } as unknown as Db };
  };
  const actor = { id: 1, name: 'Owner' };
  const opening = { effectiveDate: '2026-01-01', quantity: '1', unit: 'kg' as const, totalCostCents: 100, reason: 'Opening balance' };
  const count = { kind: 'count_correction' as const, effectiveDate: '2026-01-01', quantity: '1', unit: 'kg' as const, reason: 'Counted' };
  const position = (seen: string[], part: string) => seen.findIndex((text) => text.includes(part));

  it('opening: locks first, then checks for a standing opening, and only then reads the rest', async () => {
    const { db: fake, seen } = fakeDb('g');
    await recordOpening(fake, 1, opening, actor);
    expect(seen[0]).toContain('FOR NO KEY UPDATE');
    expect(seen.filter((text) => text.includes('FOR NO KEY UPDATE'))).toHaveLength(1);
    expect(position(seen, "o.kind = 'opening'")).toBe(1);
    expect(position(seen, 'max(effective_date)')).toBeGreaterThan(1);
  });

  it('opening: uses the unit the lock read, and refuses a second one after the lock', async () => {
    const wrongUnit = fakeDb('mL');
    await expect(recordOpening(wrongUnit.db, 1, opening, actor)).rejects.toThrow('This ingredient is measured in mL');
    expect(wrongUnit.seen[0]).toContain('FOR NO KEY UPDATE');
    const second = fakeDb('g', { hasOpening: true });
    await expect(recordOpening(second.db, 1, opening, actor)).rejects.toThrow('already has an opening balance');
    expect(second.seen).toHaveLength(2);
    expect(second.seen[0]).toContain('FOR NO KEY UPDATE');
  });

  it('count: locks first, then sums the ledger', async () => {
    const { db: fake, seen } = fakeDb('g');
    await recordCorrection(fake, 1, count, actor);
    expect(seen[0]).toContain('FOR NO KEY UPDATE');
    expect(seen.filter((text) => text.includes('FOR NO KEY UPDATE'))).toHaveLength(1);
    expect(position(seen, 'sum(quantity_milli)')).toBe(1);
  });

  it('correction: uses the unit the lock read', async () => {
    const { db: fake, seen } = fakeDb('mL');
    await expect(recordCorrection(fake, 1, count, actor)).rejects.toThrow('This ingredient is measured in mL');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('FOR NO KEY UPDATE');
  });
});
