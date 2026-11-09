import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replay, replaySteps, toSafeInteger } from '../src/calc/stock';
import { addDays, localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { type Agent, type App, at01Body, createBusiness, makeApp, makeCatalog, openTestDb, resetData } from './helpers';

/**
 * Back-dated entries (P4-33; INV-04, BR-19, Q38, Q45): the average is worked out in date order, whatever the
 * order things were typed in, and saved runs keep the cost they used. Run lines are written directly here:
 * runs start using stock in a later task.
 */

let db: Db;
let app: App;
let owner: Agent;
let scoped: Db;
let soy: number;

const today = () => localToday();
const day = (offset: number) => addDays(today(), offset);

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
  owner = a.agent;
  scoped = scopedDb(db, a.tenantId);
  soy = (await owner.post('/api/ingredients').send({ name: 'Soy sauce', baseUnit: 'mL' }).expect(201)).body.id;
});
afterAll(async () => {
  await db?.close();
});

const buy = (quantity: string, totalCostCents: number, effectiveDate: string) =>
  owner.post(`/api/ingredients/${soy}/purchases`).send({ effectiveDate, quantity, unit: 'mL', totalCostCents }).expect(201);
const open = (quantity: string, totalCostCents: number, effectiveDate: string) =>
  owner.post(`/api/ingredients/${soy}/opening`).send({ effectiveDate, quantity, unit: 'mL', totalCostCents, reason: 'Opening balance' }).expect(201);
const correct = (kind: string, quantity: string, effectiveDate: string) =>
  owner.post(`/api/ingredients/${soy}/corrections`).send({ kind, effectiveDate, quantity, unit: 'mL', reason: 'Checked' }).expect(201);

async function stored() {
  const r = (await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4, avg_version FROM ingredients WHERE id = $1', [soy])).rows[0];
  return {
    onHandMilli: toSafeInteger(r.on_hand_milli),
    avgE4: r.avg_cost_e4 === null ? null : toSafeInteger(r.avg_cost_e4),
    version: r.avg_version as number,
  };
}
async function ledger() {
  const rows = (await scoped.query<any>(`SELECT *, effective_date::text AS day FROM stock_movements WHERE ingredient_id = $1 ORDER BY id`, [soy])).rows;
  return rows.map((l) => ({
    id: l.id as number,
    kind: l.kind,
    effectiveDate: l.day as string,
    quantityMilli: toSafeInteger(l.quantity_milli),
    totalCostCents: l.total_cost_cents as number | null,
    reversesMovementId: l.reverses_movement_id as number | null,
  }));
}

/** BR-19 worked out separately from the app's stock maths, in plain BigInt, as a check on it. */
function byHand(lines: Awaited<ReturnType<typeof ledger>>) {
  const undone = new Set(lines.map((l) => l.reversesMovementId));
  const ordered = lines
    .filter((l) => l.kind !== 'purchase_reversal' && !undone.has(l.id))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id - b.id);
  let onHand = 0n;
  let average: bigint | null = null;
  for (const l of ordered) {
    const quantity = BigInt(l.quantityMilli);
    if (l.totalCostCents !== null) {
      const cost = BigInt(l.totalCostCents) * 10_000_000n;
      const blended = onHand > 0n && average !== null;
      const top: bigint = blended ? onHand * average! + cost : cost;
      const bottom: bigint = blended ? onHand + quantity : quantity;
      average = (2n * top + bottom) / (2n * bottom);
    }
    onHand += quantity;
  }
  return { onHandMilli: Number(onHand), avgE4: average === null ? null : Number(average) };
}

async function expectCopyToBeRight() {
  const { version: _version, ...cached } = await stored();
  const lines = await ledger();
  expect(cached).toEqual(byHand(lines));
  expect(cached).toEqual(replay(lines));
  expect(cached.onHandMilli).toBe(lines.reduce((sum, l) => sum + l.quantityMilli, 0));
}

/** Add a run's stock line directly, and bring the copy up to date as the save will. */
async function runLine(kind: 'run_use' | 'void_return', runId: number, runCostId: number, quantityMilli: number, effectiveDate: string, unitCostE4: number | null) {
  await scoped.query(
    `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, run_id, run_cost_id, unit_cost_e4, entered_by_user_id, entered_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'Owner')`,
    [soy, kind, effectiveDate, quantityMilli, runId, runCostId, unitCostE4],
  );
  const after = replay(await ledger());
  await scoped.query('UPDATE ingredients SET on_hand_milli = $2, avg_cost_e4 = $3 WHERE id = $1', [soy, after.onHandMilli, after.avgE4]);
}

async function makeRun() {
  const catalog = await makeCatalog(owner);
  const run = (await owner.post('/api/runs').send(at01Body(catalog, day(-20))).expect(201)).body;
  const costs = await scoped.query<{ id: number }>('SELECT id FROM run_costs WHERE run_id = $1 ORDER BY id', [run.id]);
  return { runId: run.id as number, runCostId: costs.rows[0]!.id };
}

describe('saved runs keep the cost they used (Q45)', () => {
  it('leaves the run, its cost lines and its stock line untouched when a back-dated purchase moves the average', async () => {
    await buy('1000', 10000, day(-10)); // P0.10
    const { runId, runCostId } = await makeRun();
    await runLine('run_use', runId, runCostId, -500_000, day(-5), 100_000);
    const before = {
      detail: (await owner.get(`/api/runs/${runId}`)).body,
      costs: (await scoped.query('SELECT * FROM run_costs WHERE run_id = $1 ORDER BY id', [runId])).rows,
      line: (await scoped.query(`SELECT * FROM stock_movements WHERE kind = 'run_use'`)).rows,
    };

    await buy('1000', 30000, day(-8)); // P0.30, entered late: the average before the run was really P0.20
    expect(await stored()).toMatchObject({ onHandMilli: 1_500_000, avgE4: 200_000 });

    expect((await owner.get(`/api/runs/${runId}`)).body).toEqual(before.detail);
    expect((await scoped.query('SELECT * FROM run_costs WHERE run_id = $1 ORDER BY id', [runId])).rows).toEqual(before.costs);
    expect((await scoped.query(`SELECT * FROM stock_movements WHERE kind = 'run_use'`)).rows).toEqual(before.line);
    await expectCopyToBeRight();
  });

  it('counts a run\'s stock at its own date, so a purchase after it is averaged against what was left', async () => {
    await buy('1000', 10000, day(-10)); // 1,000 at P0.10
    const { runId, runCostId } = await makeRun();
    await runLine('run_use', runId, runCostId, -800_000, day(-5), 100_000); // 200 left
    await buy('200', 6000, day(-1)); // 200 at P0.30: (200 x P0.10 + P60) / 400 = P0.20
    expect(await stored()).toMatchObject({ onHandMilli: 400_000, avgE4: 200_000 });
    // Back-dated before the run: 1,000 more at P0.10 leaves 1,200 after the run, so the last purchase weighs less:
    // (1,200 x P0.10 + P60) / 1,400 = P0.128571.
    await buy('1000', 10000, day(-7));
    expect(await stored()).toMatchObject({ onHandMilli: 1_400_000, avgE4: 128_571 });
    await expectCopyToBeRight();
  });

  it('keeps a voided run\'s return in date order', async () => {
    await buy('1000', 10000, day(-10));
    const { runId, runCostId } = await makeRun();
    await runLine('run_use', runId, runCostId, -400_000, day(-6), 100_000);
    await runLine('void_return', runId, runCostId, 400_000, day(-2), null);
    await buy('1000', 30000, day(-4));
    await expectCopyToBeRight();
    expect(await stored()).toMatchObject({ onHandMilli: 2_000_000 });
  });

  it('copes with a ledger line dated after today, and a return dated before it (the real future-dated run is P4-17)', async () => {
    await buy('1000', 10000, day(-3));
    const { runId, runCostId } = await makeRun();
    await runLine('run_use', runId, runCostId, -400_000, day(5), 100_000);
    await runLine('void_return', runId, runCostId, 400_000, today(), null);
    // Today is before the latest line now, so this purchase replays the ledger rather than taking the short way.
    await buy('1000', 30000, today());
    await expectCopyToBeRight();
    expect((await stored()).onHandMilli).toBe(2_000_000);
  });
});

describe('stock running out part-way through history (Q33, Q49)', () => {
  it('uses the purchase\'s own price where stock was at zero on that date', async () => {
    await buy('1000', 40000, day(-3));
    await buy('1000', 10000, day(-9));
    await correct('spillage', '1000', day(-7)); // back-dated: the shelf was empty before the last purchase
    expect(await stored()).toMatchObject({ onHandMilli: 1_000_000, avgE4: 400_000 });
    await expectCopyToBeRight();
  });

  it('turns a blended average into the purchase\'s own price when a back-dated loss empties the shelf first', async () => {
    await buy('1000', 10000, day(-9));
    await buy('1000', 30000, day(-3));
    expect((await stored()).avgE4).toBe(200_000);
    await correct('spoilage', '1200', day(-5)); // below zero on that date
    expect(await stored()).toMatchObject({ onHandMilli: 800_000, avgE4: 300_000 });
    await expectCopyToBeRight();
  });

  it('turns the purchase\'s own price into a blend when a back-dated purchase fills the shelf first', async () => {
    await buy('100', 1000, day(-9));
    await correct('spillage', '100', day(-7));
    await buy('100', 3000, day(-3));
    expect((await stored()).avgE4).toBe(300_000);
    await buy('100', 1000, day(-5)); // now there was stock on hand at P0.10 when the last one arrived
    expect(await stored()).toMatchObject({ onHandMilli: 200_000, avgE4: 200_000 });
    await expectCopyToBeRight();
  });

  it('gives stock with no average its first price from whichever cost line comes first by date', async () => {
    await correct('count_correction', '300', day(-4)); // stock, but no average yet
    await buy('100', 3000, day(-2));
    expect((await stored()).avgE4).toBe(300_000); // Q49: its own price
    await buy('100', 1000, day(-6)); // dated before the count: now the first price is P0.10
    await expectCopyToBeRight();
    // 100 at P0.10, plus the 300 found, plus 100 at P0.30: (400 x P0.10 + P30) / 500 = P0.14.
    expect(await stored()).toMatchObject({ onHandMilli: 500_000, avgE4: 140_000 });
  });
});

describe('where a back-dated line lands', () => {
  it('goes after lines of the same date, and before later dates', async () => {
    await buy('100', 1000, day(-9));
    await buy('100', 5000, day(-5));
    await buy('100', 9000, day(-1));
    const added = (await buy('100', 2000, day(-5))).body.movementId;
    const steps = replaySteps(await ledger());
    expect(steps[2]!.line.id).toBe(added);
    expect(steps.map((s) => s.line.effectiveDate)).toEqual([day(-9), day(-5), day(-5), day(-1)]);
    await expectCopyToBeRight();
  });

  it('leaves a reversed pair out when it lands around it', async () => {
    await buy('100', 1000, day(-5));
    const wrong = (await buy('100', 90000, day(-1))).body.movementId;
    await owner.post(`/api/ingredients/${soy}/movements/${wrong}/reversal`).send({ reason: 'Wrong entry' }).expect(201);
    await buy('100', 3000, day(-3));
    expect(await stored()).toMatchObject({ onHandMilli: 200_000, avgE4: 200_000 });
    await expectCopyToBeRight();
  });

  it('can go before everything, however far back', async () => {
    await buy('100', 3000, day(-1));
    await buy('100', 1000, '2001-02-03');
    expect((await ledger()).map((l) => l.effectiveDate)).toEqual([day(-1), '2001-02-03']);
    expect(replaySteps(await ledger()).map((s) => s.after.avgE4)).toEqual([100_000, 200_000]);
    await expectCopyToBeRight();
  });

  it('changes the average shown after later purchases, for the price history (INV-10, design note 10)', async () => {
    await buy('1000', 10000, day(-9));
    await buy('1000', 30000, day(-3));
    const before = replaySteps(await ledger()).map((s) => s.after.avgE4);
    expect(before).toEqual([100_000, 200_000]);
    await buy('2000', 60000, day(-6));
    expect(replaySteps(await ledger()).map((s) => s.after.avgE4)).toEqual([100_000, 233_333, 250_000]);
  });
});

describe('a stock count stays the difference it stored (design note 2.6, 10)', () => {
  it('does not rework an old count when something is back-dated before it', async () => {
    await open('1000', 10000, day(-20));
    await correct('count_correction', '900', day(-5)); // stored as -100
    await buy('500', 5000, day(-10)); // entered afterwards, dated before the count
    const lines = await ledger();
    expect(lines.find((l) => l.kind === 'count_correction')!.quantityMilli).toBe(-100_000);
    // So the ledger now says 1,400 at the end of that day, although 900 was counted.
    expect((await stored()).onHandMilli).toBe(1_400_000);
    await correct('count_correction', '1000', today());
    expect((await stored()).onHandMilli).toBe(1_000_000);
    await expectCopyToBeRight();
  });

  /** An empty shelf at the count, then a late entry dated before it, then a purchase at P0.50. */
  async function staleCount() {
    await open('1000', 10000, day(-20));
    await correct('count_correction', '0', day(-10));
    await buy('1000', 30000, day(-15)); // entered late, dated before the count
    await buy('100', 5000, day(-5));
    // The ledger thinks 1,000 was still on the shelf: (1,000 x P0.20 + P50) / 1,100.
    expect(await stored()).toMatchObject({ onHandMilli: 1_100_000, avgE4: 227_273 });
  }

  it('corrects stock but not the average with a count dated today', async () => {
    await staleCount();
    await correct('count_correction', '100', today());
    expect(await stored()).toMatchObject({ onHandMilli: 100_000, avgE4: 227_273 });
    await expectCopyToBeRight();
  });

  it('repairs both stock and the average with a recount on the old date', async () => {
    await staleCount();
    await correct('count_correction', '0', day(-10));
    // The shelf was empty, so the last purchase's own price stands (Q33).
    expect(await stored()).toMatchObject({ onHandMilli: 100_000, avgE4: 500_000 });
    await expectCopyToBeRight();
  });

  it('needs any later count entered again too, oldest first, after a recount on the old date', async () => {
    await staleCount();
    await correct('count_correction', '100', today());
    await correct('count_correction', '0', day(-10));
    expect((await stored()).onHandMilli).toBe(-900_000); // the recount is dated before today's count
    await correct('count_correction', '100', today());
    expect(await stored()).toMatchObject({ onHandMilli: 100_000, avgE4: 500_000 });
    await expectCopyToBeRight();
  });

  it('repairs two later counts oldest first, and the last one may have nothing left to correct', async () => {
    await staleCount();
    await correct('count_correction', '80', day(-3));
    await correct('count_correction', '100', today());
    await correct('count_correction', '0', day(-10));
    await correct('count_correction', '80', day(-3));
    const last = await owner.post(`/api/ingredients/${soy}/corrections`).send({ kind: 'count_correction', effectiveDate: today(), quantity: '100', unit: 'mL', reason: 'Checked' });
    expect(last.status).toBe(400);
    expect(last.body.error).toBe('Nothing to correct: the count matches the recorded stock for that date.');
    expect(await stored()).toMatchObject({ onHandMilli: 100_000, avgE4: 500_000 });
    await expectCopyToBeRight();
  });

  it('can go below zero when the cause of a count is entered afterwards, until a recount on that date', async () => {
    await buy('1000', 10000, day(-10));
    await correct('count_correction', '200', day(-5));
    await correct('spoilage', '800', day(-7)); // the cause of the difference, entered after the count
    expect((await stored()).onHandMilli).toBe(-600_000);
    await correct('count_correction', '200', day(-5));
    expect((await stored()).onHandMilli).toBe(200_000);
    await expectCopyToBeRight();
  });
});

describe('any mix, checked against BR-19 worked out separately', () => {
  it('stays right after every line of a long mixed history', async () => {
    let seed = 20261107;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    let versions = 0;
    let lastAverage: number | null = null;
    for (let step = 0; step < 160; step++) {
      const date = day(-rand(40));
      const amount = ((1000 + rand(5000)) / 1000).toFixed(3);
      const which = rand(10);
      if (which < 6) await buy(amount, rand(5000), date);
      else if (which < 8) await correct(which === 6 ? 'spillage' : 'spoilage', amount, date);
      else {
        const counted = rand(9000);
        await correct('count_correction', (counted / 1000).toFixed(3), date);
        const upToThatDay = (await ledger()).filter((l) => l.effectiveDate <= date).reduce((sum, l) => sum + l.quantityMilli, 0);
        expect(upToThatDay, `step ${step}`).toBe(counted);
      }
      await expectCopyToBeRight();
      const now = await stored();
      if (now.avgE4 !== lastAverage) versions++;
      lastAverage = now.avgE4;
      expect(now.version, `step ${step}`).toBe(versions);
    }
    expect(versions).toBeGreaterThan(40);
  }, 120_000);
});

describe('a long ledger (design note 11)', () => {
  it('replays 20,000 lines for one back-dated purchase in a few seconds at most', async () => {
    await scoped.query(
      `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, total_cost_cents, entered_by_user_id, entered_by_name)
       SELECT $1, 'purchase', $2::date - (n % 365), 1000 + n % 7, 10 + n % 13, 1, 'Owner' FROM generate_series(1, 20000) AS n`,
      [soy, day(-1)],
    );
    const copy = replay(await ledger());
    await scoped.query('UPDATE ingredients SET on_hand_milli = $2, avg_cost_e4 = $3 WHERE id = $1', [soy, copy.onHandMilli, copy.avgE4]);
    const started = Date.now();
    await buy('100', 1000, day(-200));
    expect(Date.now() - started).toBeLessThan(5000);
    await expectCopyToBeRight();
  }, 60_000);
});
