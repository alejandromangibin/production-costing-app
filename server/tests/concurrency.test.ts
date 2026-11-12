import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replay, toSafeInteger } from '../src/calc/stock';
import { addDays, localToday } from '../src/dates';
import type { Db, Queryable } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { createIngredient, getIngredient, updateIngredient } from '../src/services/ingredients';
import { correctPurchaseDetails } from '../src/services/purchaseDetails';
import { type LockedIngredient, type NewLine, addLedgerLine, lockIngredients, recordCorrection, recordOpening, recordPurchase, reverseEntry } from '../src/services/stockLedger';
import { type Agent, type App, createBusiness, makeApp, openTestDb, resetData } from './helpers';

/**
 * Two people saving at the same moment (task P4-11, design note section 4). The built-in database has one
 * connection, so nothing ever waits there: these tests only run on a real server, in `npm run test:postgres`.
 *
 * Most hold one save open on purpose, start a second, check that it really waits, then let the first finish.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('two people at once, on a real PostgreSQL server', () => {
  const actor = { id: 1, name: 'Owner' };
  /** Statements a waiting save is stuck on. */
  const AT_THE_LOCK = '%FOR NO KEY UPDATE%';
  const AT_THE_UPDATE = '%UPDATE ingredients%';
  let db: Db;
  let app: App;
  let owner: Agent;
  let scoped: Db;
  let soy: number;
  let vinegar: number;

  interface Hold {
    ready: Promise<void>;
    release: () => void;
    done: Promise<void>;
  }
  const holds: Hold[] = [];
  const running: Promise<unknown>[] = [];

  /** Keep hold of work in progress, so that it always ends before the next test empties the tables. */
  function track<T>(work: Promise<T>): Promise<T> {
    running.push(work.catch(() => undefined));
    return work;
  }

  beforeAll(async () => {
    db = await openTestDb();
    app = makeApp(db);
  });
  beforeEach(async () => {
    await resetData(db);
    expect(await waiting('%')).toBe(0);
    const business = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    owner = business.agent;
    scoped = scopedDb(db, business.tenantId);
    soy = (await createIngredient(scoped, { name: 'Soy sauce', baseUnit: 'mL' }, actor)).id;
    vinegar = (await createIngredient(scoped, { name: 'Vinegar', baseUnit: 'mL' }, actor)).id;
  });
  // A test that fails half-way must not leave a transaction open: it would block every test after it.
  afterEach(async () => {
    for (const held of holds) held.release();
    await Promise.allSettled([...holds.map((held) => held.done), ...running]);
    holds.length = 0;
    running.length = 0;
  });
  afterAll(async () => {
    await db?.close();
  });

  const today = () => localToday();
  const purchase = (quantity: string, totalCostCents: number, id = soy, effectiveDate = today()) =>
    track(recordPurchase(scoped, id, { effectiveDate, quantity, unit: 'mL', totalCostCents, supplier: '', reference: '' }, actor, true));
  const line = (quantityMilli: number, totalCostCents: number): NewLine => ({ kind: 'purchase', quantityMilli, totalCostCents, effectiveDate: today() });

  /**
   * Take the ingredient locks in a transaction and keep them until `release`, as a save part-way through
   * does, then run `after`. It gives up after 10 seconds, failing the test: something has waited that should not have.
   */
  function hold(
    ids: number[],
    work?: (q: Queryable, locked: Map<number, LockedIngredient>) => Promise<unknown>,
    after?: (q: Queryable) => Promise<unknown>,
  ): Hold {
    let release!: () => void;
    let giveUp!: (reason: Error) => void;
    let held!: () => void;
    let failed!: (reason: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve;
      giveUp = reject;
    });
    gate.catch(() => undefined); // the limit can fire before anything is waiting on the gate
    const ready = new Promise<void>((resolve, reject) => {
      held = resolve;
      failed = reject;
    });
    const limit = setTimeout(() => giveUp(new Error('Held too long: something waited that should not have.')), 10_000);
    const done = scoped
      .tx(async (q) => {
        const locked = await lockIngredients(q, ids);
        await work?.(q, locked);
        held();
        await gate;
        await after?.(q);
      })
      .finally(() => clearTimeout(limit));
    done.catch(failed);
    const handle = { ready, release, done };
    holds.push(handle);
    return handle;
  }

  /** How many connections are stuck waiting for a lock, on a statement like `statement`. Must use the plain handle. */
  async function waiting(statement: string): Promise<number> {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [statement],
    );
    return r.rows[0]!.n;
  }

  /** Wait until a connection is really stuck waiting for a lock on such a statement. */
  async function someoneIsWaiting(statement = AT_THE_LOCK) {
    for (let tries = 0; tries < 100; tries++) {
      if ((await waiting(statement)) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Nobody was waiting for a lock on ${statement}.`);
  }

  async function stored(id = soy) {
    const r = (await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4, avg_version FROM ingredients WHERE id = $1', [id])).rows[0];
    return {
      onHandMilli: toSafeInteger(r.on_hand_milli),
      avgE4: r.avg_cost_e4 === null ? null : toSafeInteger(r.avg_cost_e4),
      version: r.avg_version as number,
    };
  }
  async function ledger(id = soy) {
    const rows = (await scoped.query<any>(`SELECT *, effective_date::text AS day FROM stock_movements WHERE ingredient_id = $1 ORDER BY id`, [id])).rows;
    return rows.map((l) => ({
      id: l.id as number,
      kind: l.kind,
      effectiveDate: l.day as string,
      quantityMilli: toSafeInteger(l.quantity_milli),
      totalCostCents: l.total_cost_cents as number | null,
      reversesMovementId: l.reverses_movement_id as number | null,
    }));
  }
  async function expectCopyMatchesLedger(id = soy) {
    const { version: _version, ...cached } = await stored(id);
    expect(cached).toEqual(replay(await ledger(id)));
  }
  const names = async () => (await scoped.query<{ name: string }>('SELECT name FROM ingredients ORDER BY id')).rows.map((r) => r.name);

  describe('saves on one ingredient take turns (rule 1)', () => {
    it('makes the second save wait, then work from the figures the first one left', async () => {
      const first = hold([soy], async (q, locked) => addLedgerLine(q, locked.get(soy)!, line(100_000, 1000), actor));
      await first.ready;
      let finished = false;
      const second = track(purchase('100', 3000).finally(() => (finished = true)));
      await someoneIsWaiting();
      expect(finished).toBe(false);
      first.release();
      await first.done;
      await second;
      // A stale read would have seen nothing on hand and used the second purchase's own price, P0.30.
      expect(await stored()).toEqual({ onHandMilli: 200_000, avgE4: 200_000, version: 2 });
      await expectCopyMatchesLedger();
    });

    it('loses nothing when many saves arrive together, and ledger ids rise in the order lines were written', async () => {
      const prices = Array.from({ length: 30 }, (_, i) => 1000 + i * 137);
      const results = await Promise.all(prices.map((price) => purchase('100', price)));
      // Each save read on hand under its own lock. Taken by ledger id, the figures must climb one step at a time.
      const byId = [...results].sort((a, b) => a.movementId - b.movementId);
      expect(byId.map((r) => r.ingredient.onHandMilli)).toEqual(prices.map((_, i) => (i + 1) * 100_000));
      await expectCopyMatchesLedger();
      expect((await stored()).onHandMilli).toBe(3_000_000);
    });

    it('keeps the copy equal to the ledger when back-dated saves arrive together', async () => {
      const days = [-1, -9, 0, -4, -9, -2, 0, -7, -3, -5, -1, -8, -6, 0, -2, -4];
      await Promise.all(days.map((d, i) => purchase(String(100 + i * 11), 1000 + i * 321, soy, addDays(today(), d))));
      await expectCopyMatchesLedger();
      expect((await stored()).onHandMilli).toBe((await ledger()).reduce((sum, l) => sum + l.quantityMilli, 0));
    });

    it('lets go of the lock when a save fails, with nothing stored', async () => {
      const failing = scoped.tx(async (q) => {
        await addLedgerLine(q, (await lockIngredients(q, [soy])).get(soy)!, line(100_000, 1000), actor);
        throw new Error('power cut');
      });
      await expect(failing).rejects.toThrow('power cut');
      expect(await stored()).toEqual({ onHandMilli: 0, avgE4: null, version: 0 });
      await purchase('100', 3000);
      expect(await stored()).toEqual({ onHandMilli: 100_000, avgE4: 300_000, version: 1 });
      expect(await ledger()).toHaveLength(1);
    });
  });

  describe('nobody waits who does not need to', () => {
    it('does not hold up another ingredient', async () => {
      const first = hold([soy]);
      await first.ready;
      await purchase('100', 1000, vinegar);
      expect((await stored(vinegar)).onHandMilli).toBe(100_000);
      first.release();
      await first.done;
    });

    it('does not hold up someone reading the list, who sees the last saved figures', async () => {
      await purchase('100', 1000);
      const first = hold([soy], async (q, locked) => addLedgerLine(q, locked.get(soy)!, line(100_000, 3000), actor));
      await first.ready;
      expect((await getIngredient(scoped, soy)).onHandMilli).toBe(100_000);
      first.release();
      await first.done;
      expect((await getIngredient(scoped, soy)).onHandMilli).toBe(200_000);
    });
  });

  describe('changing an ingredient while stock is being saved', () => {
    it('refuses a unit change that had to wait for the first stock line', async () => {
      const first = hold([soy], async (q, locked) => addLedgerLine(q, locked.get(soy)!, line(100_000, 1000), actor));
      await first.ready;
      const outcome = track(updateIngredient(scoped, soy, { baseUnit: 'g' })).then(() => 'changed', (e) => e.message);
      await someoneIsWaiting();
      first.release();
      await first.done;
      expect(await outcome).toBe('The unit cannot change once stock has been recorded for this ingredient.');
      expect((await getIngredient(scoped, soy)).baseUnit).toBe('mL');
    });

    it('works a purchase out in the new unit if it had to wait for a unit change', async () => {
      const change = hold([soy], async (q) => q.query(`UPDATE ingredients SET base_unit = 'g' WHERE id = $1`, [soy]));
      await change.ready;
      const outcome = purchase('100', 1000).then(() => 'bought', (e) => e.message);
      await someoneIsWaiting();
      change.release();
      await change.done;
      expect(await outcome).toBe('This ingredient is measured in g, so it cannot be entered in mL.');
      expect(await ledger()).toEqual([]);
    });

    it('refuses a purchase that had to wait for the ingredient to be archived', async () => {
      const archive = hold([soy], async (q) => q.query('UPDATE ingredients SET active = false WHERE id = $1', [soy]));
      await archive.ready;
      const outcome = purchase('100', 1000).then(() => 'bought', (e) => e.message);
      await someoneIsWaiting();
      archive.release();
      await archive.done;
      expect(await outcome).toMatch(/archived/);
      expect(await ledger()).toEqual([]);
    });
  });

  describe('once-only entries', () => {
    const opening = { effectiveDate: '2026-01-01', quantity: '1000', unit: 'mL' as const, totalCostCents: 10000, reason: 'Opening balance' };

    it('refuses an opening balance that had to wait for another one', async () => {
      const first = hold([soy], async (q, locked) =>
        addLedgerLine(q, locked.get(soy)!, { kind: 'opening', quantityMilli: 1_000_000, totalCostCents: 10000, effectiveDate: '2026-01-01', reason: 'Opening balance' }, actor),
      );
      await first.ready;
      const outcome = track(recordOpening(scoped, soy, opening, actor)).then(() => 'stored', (e) => e.message);
      await someoneIsWaiting();
      first.release();
      await first.done;
      expect(await outcome).toBe('This ingredient already has an opening balance.');
      expect(await ledger()).toHaveLength(1);
      expect((await stored()).onHandMilli).toBe(1_000_000);
    });

    it('works a count out from the ledger as it stands after waiting', async () => {
      await recordOpening(scoped, soy, opening, actor);
      const first = hold([soy], async (q, locked) =>
        addLedgerLine(q, locked.get(soy)!, { kind: 'count_correction', quantityMilli: -100_000, totalCostCents: null, effectiveDate: today(), reason: 'Counted' }, actor),
      );
      await first.ready;
      const count = { kind: 'count_correction' as const, effectiveDate: today(), quantity: '900', unit: 'mL' as const, reason: 'Counted' };
      const outcome = track(recordCorrection(scoped, soy, count, actor)).then(() => 'stored', (e) => e.message);
      await someoneIsWaiting();
      first.release();
      await first.done;
      expect(await outcome).toBe('Nothing to correct: the count matches the recorded stock for that date.');
      expect(await ledger()).toHaveLength(2);
      expect((await stored()).onHandMilli).toBe(900_000);
    });
  });

  describe('reversals', () => {
    it('refuses a reversal that had to wait for a newer stock line', async () => {
      const { movementId } = await purchase('100', 1000);
      const first = hold([soy], async (q, locked) => addLedgerLine(q, locked.get(soy)!, line(100_000, 3000), actor));
      await first.ready;
      const outcome = track(reverseEntry(scoped, soy, movementId, { reason: 'Wrong entry' }, actor)).then(() => 'reversed', (e) => e.message);
      await someoneIsWaiting();
      first.release();
      await first.done;
      expect(await outcome).toBe('Only the last entry made for this ingredient can be reversed. Use a count correction instead.');
      expect(await ledger()).toHaveLength(2);
      await expectCopyMatchesLedger();
    });

    it('refuses the second of two people reversing the same line', async () => {
      const { movementId } = await purchase('100', 1000);
      const first = hold([soy], async (q, locked) =>
        addLedgerLine(q, locked.get(soy)!, { kind: 'purchase_reversal', quantityMilli: -100_000, totalCostCents: null, effectiveDate: today(), reason: 'Wrong entry', reversesMovementId: movementId }, actor),
      );
      await first.ready;
      const outcome = track(reverseEntry(scoped, soy, movementId, { reason: 'Wrong entry' }, actor)).then(() => 'reversed', (e) => e.message);
      await someoneIsWaiting();
      first.release();
      await first.done;
      expect(await outcome).toBe('This entry has already been reversed.');
      expect(await ledger()).toHaveLength(2);
      expect((await stored()).onHandMilli).toBe(0);
      await expectCopyMatchesLedger();
    });

    it('keeps the copy equal to the ledger whichever of a reversal and a purchase gets there first', async () => {
      await purchase('100', 1000);
      const { movementId } = await purchase('100', 9000);
      const [undo, bought] = await Promise.allSettled([track(reverseEntry(scoped, soy, movementId, { reason: 'Wrong entry' }, actor)), purchase('100', 3000)]);
      expect(bought.status).toBe('fulfilled');
      await expectCopyMatchesLedger();
      // First, the reversal goes through; second, the purchase is newer and the reversal is refused, for that reason only.
      if (undo.status === 'rejected') {
        expect(undo.reason.message).toBe('Only the last entry made for this ingredient can be reversed. Use a count correction instead.');
      }
      expect((await stored()).onHandMilli).toBe(undo.status === 'fulfilled' ? 200_000 : 300_000);
    });
  });

  describe("correcting a purchase's details (INV-17)", () => {
    const bought = () =>
      track(recordPurchase(scoped, soy, { effectiveDate: today(), quantity: '100', unit: 'mL', totalCostCents: 1000, supplier: 'Mang Tony', reference: 'OR-7' }, actor, true)).then((r) => r.movementId);
    const details = (supplier: string, reference: string, expiryDate: string | null) => ({ supplier, reference, expiryDate });
    const auditRows = async () =>
      (await scoped.query<any>(`SELECT supplier, reference, expiry_date::text AS expiry_date FROM purchase_detail_changes ORDER BY id`)).rows;
    const current = async (id: number) =>
      (await scoped.query<any>(`SELECT supplier, reference, expiry_date::text AS expiry_date FROM stock_movements WHERE id = $1`, [id])).rows[0];

    it('refuses a correction that had to wait for a reversal of the same purchase, and writes no audit row', async () => {
      const movementId = await bought();
      const first = hold([soy], async (q, locked) =>
        addLedgerLine(q, locked.get(soy)!, { kind: 'purchase_reversal', quantityMilli: -100_000, totalCostCents: null, effectiveDate: today(), reason: 'Wrong entry', reversesMovementId: movementId }, actor),
      );
      await first.ready;
      const outcome = track(correctPurchaseDetails(scoped, soy, movementId, details('Aling Rosa', 'OR-7', null), actor)).then(() => 'corrected', (e) => e.message);
      await someoneIsWaiting();
      first.release();
      await first.done;
      expect(await outcome).toBe('This purchase has been reversed, so its details can no longer be corrected.');
      expect(await auditRows()).toEqual([]);
      expect(await current(movementId)).toEqual({ supplier: 'Mang Tony', reference: 'OR-7', expiry_date: null });
    });

    it("makes the second of two corrections of the same line wait, and keeps the first one's new values in its audit row", async () => {
      const movementId = await bought();
      const first = hold([soy], async (q) => {
        await q.query(
          `INSERT INTO purchase_detail_changes (movement_id, supplier, reference, expiry_date, changed_by_user_id, changed_by_name)
           VALUES ($1, 'Mang Tony', 'OR-7', NULL, 1, 'Owner')`,
          [movementId],
        );
        await q.query(`UPDATE stock_movements SET supplier = 'First', reference = 'R1', expiry_date = '2027-01-01' WHERE id = $1`, [movementId]);
      });
      await first.ready;
      const outcome = track(correctPurchaseDetails(scoped, soy, movementId, details('Second', 'R2', null), actor)).then(() => 'corrected', (e) => e.message);
      await someoneIsWaiting();
      first.release();
      await first.done;
      expect(await outcome).toBe('corrected');
      expect(await auditRows()).toEqual([
        { supplier: 'Mang Tony', reference: 'OR-7', expiry_date: null },
        { supplier: 'First', reference: 'R1', expiry_date: '2027-01-01' },
      ]);
      expect(await current(movementId)).toEqual({ supplier: 'Second', reference: 'R2', expiry_date: null });
      await expectCopyMatchesLedger();
    });
  });

  describe('names', () => {
    it('makes a rename wait for another rename to the same name, then refuses it plainly', async () => {
      const first = hold([], async (q) => q.query(`UPDATE ingredients SET name = 'Sauce' WHERE id = $1`, [soy]));
      await first.ready;
      const outcome = track(updateIngredient(scoped, vinegar, { name: 'sauce' })).then(() => 'renamed', (e) => e.message);
      await someoneIsWaiting(AT_THE_UPDATE);
      first.release();
      await first.done;
      expect(await outcome).toBe('There is already an ingredient called sauce. It may be archived.');
      expect(await names()).toEqual(['Sauce', 'Vinegar']);
    });

    it('answers plainly and changes nothing when the database stops a save to end a deadlock', async () => {
      const stop = new Error('undo the holder');
      // Frees the name "Soy sauce" in a transaction, then asks for the row the rename below has locked.
      const holder = hold(
        [],
        async (q) => q.query(`UPDATE ingredients SET name = 'Temp' WHERE id = $1`, [soy]),
        async (q) => {
          await q.query('SELECT id FROM ingredients WHERE id = $1 FOR NO KEY UPDATE', [vinegar]);
          throw stop;
        },
      );
      await holder.ready;
      // It locks its own row, then waits to find out whether "Soy sauce" is really free.
      const rename = track(owner.patch(`/api/ingredients/${vinegar}`).send({ name: 'Soy sauce' }).then((r) => r));
      await someoneIsWaiting(AT_THE_UPDATE);
      holder.release();
      const r = await rename;
      // The rename waited first, so its deadlock check fires first and it is the one stopped. Only a stall longer
      // than deadlock_timeout between those two waits would stop the holder instead, and give a 400 here.
      const timeout = (await db.query<{ deadlock_timeout: string }>('SHOW deadlock_timeout')).rows[0]!.deadlock_timeout;
      expect(r.status, `deadlock_timeout is ${timeout}`).toBe(409);
      expect(r.body.error).toBe('Someone else was saving at the same moment. Please try again.');
      await expect(holder.done).rejects.toBe(stop);
      expect(await names()).toEqual(['Soy sauce', 'Vinegar']);
    });

    it('keeps both names when two ingredients try to swap names at once (a smoke test)', async () => {
      for (let round = 0; round < 12; round++) {
        const [a, b] = await Promise.all([
          track(owner.patch(`/api/ingredients/${soy}`).send({ name: 'Vinegar' }).then((r) => r)),
          track(owner.patch(`/api/ingredients/${vinegar}`).send({ name: 'Soy sauce' }).then((r) => r)),
        ]);
        expect([400, 409], `round ${round}`).toContain(a.status);
        expect([400, 409], `round ${round}`).toContain(b.status);
      }
      expect(await names()).toEqual(['Soy sauce', 'Vinegar']);
    });
  });

  describe('how PostgreSQL itself behaves, which the design relies on', () => {
    const lockedAlready = (id: number, mode = 'FOR NO KEY UPDATE') =>
      scoped.tx((q) => q.query(`SELECT id FROM ingredients WHERE id = $1 ${mode} NOWAIT`, [id])).then(
        () => false,
        (e) => {
          if (e.code === '55P03') return true;
          throw e;
        },
      );

    it('locks rows in ascending id order, whatever order they are asked for', async () => {
      const [low, high] = [soy, vinegar].sort((x, y) => x - y) as [number, number];
      // Rewriting the lower row puts it after the higher one on disk, as real stock saves do all the time.
      await scoped.query('UPDATE ingredients SET low_stock_milli = 1 WHERE id = $1', [low]);
      // Read the table in disk order, so that only the sort in the lock query can put the rows in id order.
      const diskOrder = 'SET LOCAL enable_indexscan = off; SET LOCAL enable_indexonlyscan = off; SET LOCAL enable_bitmapscan = off';
      const unsorted = await scoped.tx(async (q) => {
        await q.exec(diskOrder);
        return (await q.query<{ id: number }>('SELECT id FROM ingredients')).rows.map((r) => r.id);
      });
      expect(unsorted).toEqual([high, low]); // otherwise this test would prove nothing
      const lockBoth = () =>
        track(
          scoped.tx(async (q) => {
            await q.exec(diskOrder);
            return lockIngredients(q, [high, low]);
          }),
        );

      const holdingHigh = hold([high]);
      await holdingHigh.ready;
      const both = lockBoth();
      await someoneIsWaiting();
      expect(await lockedAlready(low)).toBe(true); // it took the lower id, then stopped at the higher one
      holdingHigh.release();
      await holdingHigh.done;
      await both;

      const holdingLow = hold([low]);
      await holdingLow.ready;
      const again = lockBoth();
      await someoneIsWaiting();
      expect(await lockedAlready(high)).toBe(false); // it stopped at the lower id, before touching the higher one
      holdingLow.release();
      await holdingLow.done;
      await again;
    });

    it('copes with saves asking for the same ingredients in opposite orders (a smoke test: the test above is the proof)', async () => {
      for (let round = 0; round < 10; round++) {
        await Promise.all([
          track(scoped.tx((q) => lockIngredients(q, [soy, vinegar]))),
          track(scoped.tx((q) => lockIngredients(q, [vinegar, soy]))),
        ]);
      }
    });

    it('does not make a writer wait through the foreign key alone: every stock writer must take the lock', async () => {
      const first = hold([soy]);
      await first.ready;
      expect(await lockedAlready(soy)).toBe(true);
      await scoped.query(
        `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, reason, entered_by_user_id, entered_by_name)
         VALUES ($1, 'spillage', '2026-01-01', -1000, 'Skipped the lock', 1, 'Owner')`,
        [soy],
      );
      expect(await ledger()).toHaveLength(1);
      first.release();
      await first.done;
    });

    it('has a new ledger line take a key share lock on its ingredient, which only a stronger lock runs into', async () => {
      const writer = hold([], async (q) =>
        q.query(
          `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, reason, entered_by_user_id, entered_by_name)
           VALUES ($1, 'spillage', '2026-01-01', -1000, 'Open', 1, 'Owner')`,
          [soy],
        ),
      );
      await writer.ready;
      expect(await lockedAlready(soy, 'FOR UPDATE')).toBe(true);
      expect(await lockedAlready(soy, 'FOR NO KEY UPDATE')).toBe(false);
      writer.release();
      await writer.done;
    });
  });
});
