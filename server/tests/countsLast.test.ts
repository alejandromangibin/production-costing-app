import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replay, toSafeInteger } from '../src/calc/stock';
import { addDays, localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { type Agent, type App, createBusiness, makeApp, openTestDb, resetData } from './helpers';

// D-46: on one date a stock count is replayed after every other kind, so a purchase entered after a count on the
// same date is averaged before the count takes stock away, which is how the count meant it (QA, P4-12).

let db: Db;
let app: App;
let owner: Agent;
let scoped: Db;
let flour: number;

const day = (offset: number) => addDays(localToday(), offset);

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
  owner = a.agent;
  scoped = scopedDb(db, a.tenantId);
  flour = (await owner.post('/api/ingredients').send({ name: 'Flour', baseUnit: 'g' }).expect(201)).body.id;
});
afterAll(async () => {
  await db?.close();
});

const buy = async (quantity: string, totalCostCents: number, effectiveDate: string) =>
  (await owner.post(`/api/ingredients/${flour}/purchases`).send({ effectiveDate, quantity, unit: 'kg', totalCostCents }).expect(201)).body.movementId as number;
const post = (kind: string, quantity: string, effectiveDate: string) =>
  owner.post(`/api/ingredients/${flour}/corrections`).send({ kind, effectiveDate, quantity, unit: 'kg', reason: 'Checked' });
const stored = async () => {
  const r = (await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4 FROM ingredients WHERE id = $1', [flour])).rows[0];
  return { onHandMilli: toSafeInteger(r.on_hand_milli), avgE4: r.avg_cost_e4 === null ? null : toSafeInteger(r.avg_cost_e4) };
};
const freshReplay = async () => {
  const rows = (await scoped.query<any>(`SELECT *, effective_date::text AS day FROM stock_movements WHERE ingredient_id = $1`, [flour])).rows;
  return replay(
    rows.map((l) => ({
      id: l.id,
      kind: l.kind,
      effectiveDate: l.day,
      quantityMilli: toSafeInteger(l.quantity_milli),
      totalCostCents: l.total_cost_cents,
      reversesMovementId: l.reverses_movement_id,
    })),
  );
};
const history = async () => (await owner.get(`/api/ingredients/${flour}/movements`).expect(200)).body;

describe('a count comes last on its date (D-46)', () => {
  // QA's example from P4-12, in kg (the ingredient is kept in g, so 1 kg = 1,000,000 milli; an average is e4 per g):
  //   1  buy 10 kg for P1,000.00 (P100/kg) dated -5:           on hand 10 kg, average 100,000 e4 (P100/kg)
  //   2  count 8 kg dated -2: the ledger says 10 kg, so it stores -2 kg
  //   3  buy 5 kg for P750.00 (P150/kg) dated -2, entered after the count.
  // Old order (by id on a date): the count first, so the purchase met 8 kg:
  //   (8,000,000 x 100,000 + 75,000 x 10^7) / 13,000,000 = 1.55 x 10^12 / 1.3 x 10^7 = 119,230.77 -> 119,231 (P119.23/kg)
  // New order: the purchase first, so it meets the 10 kg, and the count comes after it:
  //   (10,000,000 x 100,000 + 75,000 x 10^7) / 15,000,000 = 1.75 x 10^12 / 1.5 x 10^7 = 116,666.67 -> 116,667 (P116.67/kg)
  //   on hand 10 + 5 - 2 = 13 kg (the count is now 5 kg out, because the purchase was not there when it was typed)
  //   4  count 8 kg again, dated -2: the ledger says 13 kg at the end of the day, so it stores -5 kg, on hand 8 kg.
  it('averages a same-day purchase against the stock before the count, and the count again puts stock right', async () => {
    await buy('10', 100_000, day(-5));
    const count1 = await post('count_correction', '8', day(-2)).expect(201);
    expect(count1.body.quantityMilli).toBe(-2_000_000);
    const purchaseId = await buy('5', 75_000, day(-2));
    expect(await stored()).toEqual({ onHandMilli: 13_000_000, avgE4: 116_667 });

    // The count is out of date until it is entered again, so the purchase carries the notice.
    expect((await history()).movements.find((m: any) => m.id === purchaseId).needsRecount).toBe(day(-2));

    const count2 = await post('count_correction', '8', day(-2)).expect(201);
    expect(count2.body.quantityMilli).toBe(-5_000_000);
    expect(await stored()).toEqual({ onHandMilli: 8_000_000, avgE4: 116_667 });
    expect(await freshReplay()).toEqual(await stored());

    // The history shows the new order: the purchase before both counts, the counts in the order they were entered.
    const h = await history();
    expect(h.movements.map((m: any) => [m.kind, m.effectiveDate])).toEqual([
      ['purchase', day(-5)],
      ['purchase', day(-2)],
      ['count_correction', day(-2)],
      ['count_correction', day(-2)],
    ]);
    expect(h.movements.map((m: any) => m.id)).toEqual([1, purchaseId, 2, count2.body.movementId]);
    expect(h.movements.map((m: any) => m.onHandAfterMilli)).toEqual([10_000_000, 15_000_000, 13_000_000, 8_000_000]);
    expect(h.movements.map((m: any) => m.averageAfterE4)).toEqual([100_000, 116_667, 116_667, 116_667]);
    expect(h.movements.map((m: any) => m.needsRecount)).toEqual([null, null, null, null]);
  });

  // Every way a line can arrive next to a count (fast path or full replay), checked against a replay from scratch after each save.
  it('gives the same stored copy from the fast path or the replay as a fresh replay of the ledger', async () => {
    const steps: [string, () => Promise<unknown>][] = [
      ['buy', () => buy('10', 100_000, day(-5))],
      ['count on a new latest date (fast)', () => post('count_correction', '9', day(-2)).expect(201)],
      ['purchase on the count date, after it (replay)', () => buy('5', 75_000, day(-2))],
      ['spillage on the count date, after it (replay)', () => post('spillage', '0.5', day(-2)).expect(201)],
      ['count on the same date again (fast)', () => post('count_correction', '12', day(-2)).expect(201)],
      ['purchase on a later date (fast)', () => buy('2', 40_000, day(-1))],
      ['count on a later date (fast)', () => post('count_correction', '13', day(-1)).expect(201)],
      ['spoilage on the later count date, after it (replay)', () => post('spoilage', '1', day(-1)).expect(201)],
      ['count before the latest date (replay)', () => post('count_correction', '7', day(-4)).expect(201)],
    ];
    for (const [name, step] of steps) {
      await step();
      expect(await stored(), name).toEqual(await freshReplay());
    }
    // On hand is a plain sum of the ledger whatever the order, so the final copy must equal it.
    const rows = (await scoped.query<any>(`SELECT quantity_milli FROM stock_movements WHERE ingredient_id = $1`, [flour])).rows;
    expect((await stored()).onHandMilli).toBe(rows.reduce((sum: number, r: any) => sum + toSafeInteger(r.quantity_milli), 0));
  });

  it('keeps two counts on one date in the order they were entered', async () => {
    await buy('10', 100_000, day(-10));
    const a = (await post('count_correction', '9', day(-3)).expect(201)).body;
    const b = (await post('count_correction', '8', day(-3)).expect(201)).body;
    expect(a.quantityMilli).toBe(-1_000_000);
    expect(b.quantityMilli).toBe(-1_000_000);
    const h = await history();
    expect(h.movements.map((m: any) => m.id)).toEqual([1, a.movementId, b.movementId]);
    expect(h.movements.map((m: any) => m.onHandAfterMilli)).toEqual([10_000_000, 9_000_000, 8_000_000]);
    expect(await stored()).toEqual({ onHandMilli: 8_000_000, avgE4: 100_000 });
  });

  // The "count dated today" shortcut, from backdating.test.ts: an empty shelf at the count, a late entry dated before
  // it, and a purchase at P0.50 averaged against stock that was not there. A count today fixes stock but not the average.
  // Recounting on the old date fixes both (see the same file). Worked there by hand.
  it('still leaves the average wrong after a count dated today, when a purchase was averaged in between', async () => {
    await buy('1', 10_000, day(-20)); // 1 kg for P100: 100,000 e4
    await post('count_correction', '0', day(-10)).expect(201); // stores -1 kg
    await buy('1', 30_000, day(-15)); // entered late, dated before the count: 1 kg for P300
    await buy('0.1', 5_000, day(-5)); // 0.1 kg for P50 (P500/kg): averaged against the 1 kg the ledger thinks is left
    // Worked: 1 kg at 100,000; 2 kg at (10^6 x 100,000 + 30,000 x 10^7) / 2 x 10^6 = 200,000; the count (stores -1 kg of the 2 kg)
    // leaves 1 kg; then (10^6 x 200,000 + 5,000 x 10^7) / 1.1 x 10^6 = 227,272.7 -> 227,273, not the true 500,000.
    expect((await stored()).avgE4).toBe(227_273);
    await post('count_correction', '0.1', localToday()).expect(201);
    expect((await stored()).onHandMilli).toBe(100_000);
    expect((await stored()).avgE4).toBe(227_273);
    // Counting again on the old date puts the average right too: the shelf was empty, so the last price stands (Q33).
    await post('count_correction', '0', day(-10)).expect(201);
    await post('count_correction', '0.1', localToday()).expect(201);
    expect(await stored()).toEqual({ onHandMilli: 100_000, avgE4: 500_000 });
    expect(await freshReplay()).toEqual(await stored());
  });
});
