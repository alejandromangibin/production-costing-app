import { describe, expect, it } from 'vitest';
import {
  EMPTY_STOCK,
  MAX_AVG_E4,
  MAX_QUANTITY_MILLI,
  applyEntry,
  canUseFastPath,
  compareLedgerOrder,
  checkWholePieces,
  lineCostCents,
  parseQuantity,
  replay,
  replaySteps,
  toSafeInteger,
  type EntryUnit,
  type LedgerLine,
  type MovementKind,
  type StockEntry,
  type StockState,
} from '../src/calc/stock';
import { CalcError } from '../src/calc/types';

const purchase = (quantityMilli: number, totalCostCents: number): StockEntry => ({
  kind: 'purchase',
  quantityMilli,
  totalCostCents,
});
const use = (quantityMilli: number): StockEntry => ({ kind: 'run_use', quantityMilli: -quantityMilli, totalCostCents: null });

let nextId = 1;
const line = (effectiveDate: string, entry: StockEntry, reversesMovementId: number | null = null): LedgerLine => ({
  id: nextId++,
  effectiveDate,
  reversesMovementId,
  ...entry,
});
const reversal = (date: string, of: LedgerLine): LedgerLine =>
  line(date, { kind: 'purchase_reversal', quantityMilli: -of.quantityMilli, totalCostCents: null }, of.id);

/** 10 centavos per mL, i.e. P0.10/mL. */
const P0_10 = 100_000;

/** Expect a server error (plain Error, a 500), not a message for the person (CalcError, a 400). */
function expectServerError(fn: () => unknown, pattern?: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(CalcError);
  if (pattern) expect((thrown as Error).message).toMatch(pattern);
}

describe('average cost (INV-04, BR-19)', () => {
  it('reproduces the design note example: 496 mL at P0.10/mL plus 500 mL for P60 gives P0.11004/mL', () => {
    const after = applyEntry({ onHandMilli: 496_000, avgE4: P0_10 }, purchase(500_000, 6000));
    expect(after).toEqual({ onHandMilli: 996_000, avgE4: 110_040 });
  });

  it('starts at the price per unit of the first purchase or opening balance', () => {
    expect(applyEntry(EMPTY_STOCK, purchase(500_000, 5000))).toEqual({ onHandMilli: 500_000, avgE4: P0_10 });
    expect(applyEntry(EMPTY_STOCK, { kind: 'opening', quantityMilli: 1_000_000, totalCostCents: 100_000 })).toEqual({
      onHandMilli: 1_000_000,
      avgE4: 1_000_000,
    });
  });

  it('uses the purchase price when on hand is zero (Q33)', () => {
    expect(applyEntry({ onHandMilli: 0, avgE4: P0_10 }, purchase(500_000, 10_000))).toEqual({
      onHandMilli: 500_000,
      avgE4: 200_000,
    });
  });

  it('uses the purchase price when on hand is below zero (Q33)', () => {
    expect(applyEntry({ onHandMilli: -20_000, avgE4: P0_10 }, purchase(500_000, 10_000))).toEqual({
      onHandMilli: 480_000,
      avgE4: 200_000,
    });
  });

  it('uses the purchase price when there is stock but no average yet (Q49)', () => {
    const counted = applyEntry(EMPTY_STOCK, { kind: 'count_correction', quantityMilli: 300_000, totalCostCents: null });
    expect(counted).toEqual({ onHandMilli: 300_000, avgE4: null });
    expect(applyEntry(counted, purchase(500_000, 10_000))).toEqual({ onHandMilli: 800_000, avgE4: 200_000 });
  });

  it('is not changed by using stock, voids, spillage, spoilage or count corrections', () => {
    const kinds: [MovementKind, number][] = [
      ['run_use', -2000],
      ['run_use', 0],
      ['void_return', 2000],
      ['spillage', -1000],
      ['spoilage', -1000],
      ['count_correction', -5000],
      ['count_correction', 5000],
    ];
    for (const [kind, quantityMilli] of kinds) {
      expect(applyEntry({ onHandMilli: 10_000, avgE4: P0_10 }, { kind, quantityMilli, totalCostCents: null })).toEqual({
        onHandMilli: 10_000 + quantityMilli,
        avgE4: P0_10,
      });
    }
  });

  it('allows a free purchase (price zero), which lowers the average', () => {
    expect(applyEntry({ onHandMilli: 1000, avgE4: P0_10 }, purchase(1000, 0))).toEqual({ onHandMilli: 2000, avgE4: 50_000 });
  });

  it('rounds the average half up after every step', () => {
    // 1 centavo over 256 milli-units is 39,062.5 e4.
    expect(applyEntry(EMPTY_STOCK, purchase(256, 1)).avgE4).toBe(39_063);
    // 1 centavo over 3 milli-units is 3,333,333.33 e4.
    expect(applyEntry(EMPTY_STOCK, purchase(3, 1)).avgE4).toBe(3_333_333);
    // Weighted: (1 x 1 + 1 x 10^7) / 2 = 5,000,000.5 e4.
    expect(applyEntry({ onHandMilli: 1, avgE4: 1 }, purchase(1, 1)).avgE4).toBe(5_000_001);
  });

  it('shows on hand going down when a run uses stock (INV-03 example)', () => {
    const bought = applyEntry(EMPTY_STOCK, purchase(500_000, 5000));
    expect(applyEntry(bought, use(2000)).onHandMilli).toBe(498_000);
  });

  it('lets on hand go below zero (warned, not blocked, INV-06)', () => {
    expect(applyEntry({ onHandMilli: 1000, avgE4: P0_10 }, use(3000))).toEqual({ onHandMilli: -2000, avgE4: P0_10 });
  });

  it('refuses to apply a reversal as a step', () => {
    expect(() =>
      applyEntry({ onHandMilli: 1000, avgE4: P0_10 }, { kind: 'purchase_reversal', quantityMilli: -1000, totalCostCents: null }),
    ).toThrow(/replay/);
  });
});

describe('limits (design note 2.1)', () => {
  it('accepts a quantity of exactly 10,000,000 base units and refuses one milli more', () => {
    expect(applyEntry(EMPTY_STOCK, purchase(MAX_QUANTITY_MILLI, 1000)).onHandMilli).toBe(MAX_QUANTITY_MILLI);
    expect(() => applyEntry(EMPTY_STOCK, purchase(MAX_QUANTITY_MILLI + 1, 1000))).toThrow(CalcError);
    expect(() => applyEntry({ onHandMilli: 0, avgE4: null }, use(MAX_QUANTITY_MILLI + 1))).toThrow(CalcError);
  });

  it('accepts a total of P20,000,000 and refuses one centavo more', () => {
    expect(applyEntry(EMPTY_STOCK, purchase(MAX_QUANTITY_MILLI, 2_000_000_000)).avgE4).toBe(2_000_000);
    expect(() => applyEntry(EMPTY_STOCK, purchase(MAX_QUANTITY_MILLI, 2_000_000_001))).toThrow(
      'The total price can be at most P20,000,000.',
    );
  });

  it('accepts a unit price of exactly P1,000,000 and refuses one centavo more, with a plain message', () => {
    // 1 milli-unit for P1,000 is P1,000,000 per unit.
    expect(applyEntry(EMPTY_STOCK, purchase(1, 100_000)).avgE4).toBe(MAX_AVG_E4);
    expect(() => applyEntry(EMPTY_STOCK, purchase(1, 100_001))).toThrow(
      'The price per g, mL or piece can be at most P1,000,000. Check the quantity and the total.',
    );
  });

  it('refuses a negative or fractional total, and a missing one on a purchase or opening balance', () => {
    expect(() => applyEntry(EMPTY_STOCK, purchase(1000, -1))).toThrow(CalcError);
    expect(() => applyEntry(EMPTY_STOCK, purchase(1000, 1.5))).toThrow(CalcError);
    expect(() => applyEntry(EMPTY_STOCK, { kind: 'purchase', quantityMilli: 1000, totalCostCents: null })).toThrow(CalcError);
    expect(() => applyEntry(EMPTY_STOCK, { kind: 'opening', quantityMilli: 1000, totalCostCents: null })).toThrow(CalcError);
  });

  it('refuses a zero quantity the person typed with a plain message', () => {
    for (const entry of [
      purchase(0, 100),
      { kind: 'opening', quantityMilli: 0, totalCostCents: 100 },
      { kind: 'spillage', quantityMilli: 0, totalCostCents: null },
      { kind: 'spoilage', quantityMilli: 0, totalCostCents: null },
    ] satisfies StockEntry[]) {
      expect(() => applyEntry(EMPTY_STOCK, entry), entry.kind).toThrow(
        new CalcError('The quantity must be more than zero.'),
      );
    }
  });

  it('says "nothing to correct" for a count correction of zero (design note 2.6)', () => {
    expect(() =>
      applyEntry(EMPTY_STOCK, { kind: 'count_correction', quantityMilli: 0, totalCostCents: null }),
    ).toThrow(new CalcError('Nothing to correct: the count matches the recorded stock for that date.'));
  });

  it('treats a fractional quantity as a server error (typed quantities are always whole milli)', () => {
    expectServerError(() => applyEntry(EMPTY_STOCK, purchase(1.5, 10)));
  });

  it('refuses lines that break the kinds table (design note 1.4) as server errors', () => {
    const bad: StockEntry[] = [
      { kind: 'opening', quantityMilli: -1000, totalCostCents: 100 },
      { kind: 'purchase', quantityMilli: -1000, totalCostCents: 100 },
      { kind: 'run_use', quantityMilli: 1000, totalCostCents: null },
      { kind: 'void_return', quantityMilli: -1000, totalCostCents: null },
      { kind: 'spillage', quantityMilli: 1000, totalCostCents: null },
      { kind: 'spoilage', quantityMilli: 1000, totalCostCents: null },
      { kind: 'run_use', quantityMilli: -1000, totalCostCents: 100 },
      { kind: 'count_correction', quantityMilli: 1000, totalCostCents: 100 },
    ];
    for (const entry of bad) expectServerError(() => applyEntry({ onHandMilli: 5000, avgE4: P0_10 }, entry));
  });

  it('refuses an unknown kind, including names an object already has', () => {
    for (const kind of ['constructor', 'toString', 'refund']) {
      expectServerError(
        () => applyEntry({ onHandMilli: 5000, avgE4: P0_10 }, { kind: kind as MovementKind, quantityMilli: 1000, totalCostCents: null }),
        /Unknown movement kind/,
      );
    }
  });

  it('refuses a broken cached copy as a server error', () => {
    for (const state of [
      { onHandMilli: 1000, avgE4: -5_000_000 },
      { onHandMilli: 1000, avgE4: MAX_AVG_E4 + 1 },
      { onHandMilli: 1000, avgE4: 1.5 },
      { onHandMilli: 1.5, avgE4: P0_10 },
      { onHandMilli: Number.NaN, avgE4: null },
    ]) {
      expectServerError(() => applyEntry(state, purchase(1000, 1)));
      expectServerError(() => applyEntry(state, use(1000)));
    }
  });

  it('keeps the average within the limit at the extremes', () => {
    const top = applyEntry(EMPTY_STOCK, purchase(1, 100_000));
    const more = applyEntry(top, purchase(MAX_QUANTITY_MILLI, 2_000_000_000));
    expect(more.avgE4!).toBeLessThanOrEqual(MAX_AVG_E4);
    expect(applyEntry(top, purchase(1, 100_000)).avgE4).toBe(MAX_AVG_E4);
  });
});

describe('line cost (BR-20)', () => {
  it('reproduces the design note example: 2 mL at P0.10/mL costs 20 centavos', () => {
    expect(lineCostCents(2000, P0_10)).toBe(20);
  });

  it('rounds half up to the centavo, once per line', () => {
    // 5 units at 0.1 centavo is 0.5 centavo.
    expect(lineCostCents(5000, 1000)).toBe(1);
    expect(lineCostCents(4999, 1000)).toBe(0);
    // 996 mL at P0.11004/mL is P109.5998.
    expect(lineCostCents(996_000, 110_040)).toBe(10_960);
  });

  it('costs zero for a zero line', () => {
    expect(lineCostCents(0, P0_10)).toBe(0);
  });

  it('allows a line of exactly P20,000,000 and refuses one centavo more, with a plain message', () => {
    // 10^7 e4 is P10 per base unit, and 2,000,000 units at P10 is P20,000,000.
    expect(lineCostCents(2_000_000_000, 10_000_000)).toBe(2_000_000_000);
    expect(() => lineCostCents(2_000_000_001, 10_000_000)).toThrow(
      'This ingredient line would cost more than P20,000,000. Check the quantity.',
    );
    expect(() => lineCostCents(MAX_QUANTITY_MILLI, MAX_AVG_E4)).toThrow(CalcError);
  });

  it('refuses a quantity over the limit with a plain message', () => {
    expect(() => lineCostCents(MAX_QUANTITY_MILLI + 1, 1)).toThrow(CalcError);
  });

  it('treats a negative or fractional quantity, or a bad average, as a server error', () => {
    // A caller passing the signed run_use quantity (-2000) is a bug, not the person's mistake.
    expectServerError(() => lineCostCents(-2000, P0_10));
    expectServerError(() => lineCostCents(1.5, P0_10));
    expectServerError(() => lineCostCents(2000, -1));
    expectServerError(() => lineCostCents(2000, MAX_AVG_E4 + 1));
    expectServerError(() => lineCostCents(2000, 1.5));
  });
});

describe('replay in date order (Q38, Q45)', () => {
  it('works the average out in date order, not entry order', () => {
    const a = line('2026-11-05', purchase(1_000_000, 100_000)); // P1/g, entered first
    const b = line('2026-11-01', purchase(1_000_000, 200_000)); // P2/g, entered later but dated earlier
    const c = line('2026-11-03', use(1_000_000));
    // In date order: buy 1,000 g at P2, use 1,000 g (on hand 0), buy 1,000 g at P1 (on hand was 0, so P1).
    expect(replay([a, b, c])).toEqual({ onHandMilli: 1_000_000, avgE4: 1_000_000 });
    // The same lines in entry order would have given P1.50/g, then P1.50 again after the use.
    let fold: StockState = EMPTY_STOCK;
    for (const l of [a, b, c]) fold = applyEntry(fold, l);
    expect(fold.avgE4).toBe(1_500_000);
  });

  it('orders lines of the same day by entry order (id), whatever order they are given in', () => {
    const day = '2026-11-01';
    const first = { ...line(day, purchase(1000, 100)), id: 10 }; // 1 unit at P1
    const second = { ...line(day, use(1000)), id: 20 }; // on hand back to 0
    const third = { ...line(day, purchase(1000, 300)), id: 30 }; // 1 unit at P3, bought with nothing on hand
    // In id order the last purchase finds on hand at zero, so the average is its own price, P3.
    expect(replay([third, second, first])).toEqual({ onHandMilli: 1000, avgE4: 3_000_000 });
    expect(replay([second, first, third])).toEqual({ onHandMilli: 1000, avgE4: 3_000_000 });
    // Taken in the order given, the answer would differ, so this test can tell.
    let asGiven: StockState = EMPTY_STOCK;
    for (const l of [third, second, first]) asGiven = applyEntry(asGiven, l);
    expect(asGiven.avgE4).toBe(1_000_000);
  });

  it('gives the same result as applying lines one by one when they arrive in date order', () => {
    const lines = [
      line('2026-11-01', { kind: 'opening', quantityMilli: 496_000, totalCostCents: 4960 }),
      line('2026-11-02', purchase(500_000, 6000)),
      line('2026-11-02', use(2000)),
    ];
    let fold: StockState = EMPTY_STOCK;
    for (const l of lines) fold = applyEntry(fold, l);
    expect(replay(lines)).toEqual(fold);
    expect(fold).toEqual({ onHandMilli: 994_000, avgE4: 110_040 });
  });

  it('leaves out a reversed purchase and its reversal, as if it was never entered (INV-16)', () => {
    const opening = line('2026-11-01', { kind: 'opening', quantityMilli: 1_000_000, totalCostCents: 100_000 });
    const wrong = line('2026-11-02', purchase(1_000_000, 900_000));
    const back = reversal('2026-11-02', wrong);
    expect(replay([opening, wrong, back])).toEqual(replay([opening]));
    expect(replay([opening, wrong, back])).toEqual({ onHandMilli: 1_000_000, avgE4: 1_000_000 });
  });

  it('lets a wrong opening balance be reversed and entered again (Q51)', () => {
    const wrong = line('2026-11-01', { kind: 'opening', quantityMilli: 1_000_000, totalCostCents: 1_000_000 });
    const back = reversal('2026-11-01', wrong);
    const right = line('2026-11-01', { kind: 'opening', quantityMilli: 1_000_000, totalCostCents: 100_000 });
    expect(replay([wrong, back, right])).toEqual({ onHandMilli: 1_000_000, avgE4: 1_000_000 });
  });

  it('treats a broken reversal as a broken ledger (a server error)', () => {
    const p = line('2026-11-01', purchase(1000, 100));
    const u = line('2026-11-01', use(1000));
    expectServerError(() => replay([p, { ...reversal('2026-11-01', p), quantityMilli: -500 }]), /does not match/);
    // Reversing a run line: the reversal's own quantity (+1000) already breaks the kinds table.
    expectServerError(() => replay([p, u, reversal('2026-11-01', u)]), /is invalid|does not match/);
    expectServerError(() => replay([p, { ...reversal('2026-11-01', p), reversesMovementId: 999_999 }]), /does not match/);
    expectServerError(() => replay([p, { ...reversal('2026-11-01', p), reversesMovementId: null }]), /does not match/);
    expectServerError(() => replay([p, reversal('2026-11-01', p), reversal('2026-11-01', p)]), /more than once/);
    // A reversal is dated the purchase's own date (design note 1.4).
    expectServerError(() => replay([p, reversal('2026-12-01', p)]), /does not match/);
  });

  it('checks both lines of a reversed pair against the kinds table, though neither counts', () => {
    const badPurchase = line('2026-11-01', { kind: 'purchase', quantityMilli: -5, totalCostCents: null });
    const back = line('2026-11-01', { kind: 'purchase_reversal', quantityMilli: 5, totalCostCents: 999 }, badPurchase.id);
    expectServerError(() => replay([badPurchase, back]), new RegExp(`Ledger line (${badPurchase.id}|${back.id}) is invalid`));

    const p = line('2026-11-01', purchase(1000, 100));
    const backWithCost = line('2026-11-01', { kind: 'purchase_reversal', quantityMilli: -1000, totalCostCents: 100 }, p.id);
    expectServerError(() => replay([p, backWithCost]), new RegExp(`Ledger line ${backWithCost.id} is invalid`));
  });

  it('reports a stored line that breaks a limit as a broken ledger, naming the line', () => {
    const tooDear = line('2026-11-01', purchase(1, 200_000));
    expectServerError(() => replay([tooDear]), new RegExp(`Ledger line ${tooDear.id} is invalid: The price per g`));
  });

  it('gives every step with the average after it, for the price history (INV-10)', () => {
    const opening = line('2026-11-01', { kind: 'opening', quantityMilli: 496_000, totalCostCents: 49_600 });
    const bought = line('2026-11-03', purchase(500_000, 6000));
    const wrong = line('2026-11-04', purchase(1000, 100_000));
    const back = reversal('2026-11-04', wrong);
    const used = line('2026-11-02', use(2000)); // entered last, dated before the purchase
    const steps = replaySteps([opening, bought, wrong, back, used]);
    expect(steps.map((s) => s.line.id)).toEqual([opening.id, used.id, bought.id]);
    expect(steps.map((s) => s.after)).toEqual([
      { onHandMilli: 496_000, avgE4: 1_000_000 },
      { onHandMilli: 494_000, avgE4: 1_000_000 },
      // (494 x P1 + P60) / 994 = P0.557344...
      { onHandMilli: 994_000, avgE4: 557_344 },
    ]);
    expect(replay([opening, bought, wrong, back, used])).toEqual(steps[2]!.after);
    expect(replaySteps([])).toEqual([]);
  });

  it('returns empty stock for an empty ledger, as a copy a caller cannot use to change EMPTY_STOCK', () => {
    const empty = replay([]);
    expect(empty).toEqual(EMPTY_STOCK);
    expect(empty).not.toBe(EMPTY_STOCK);
    empty.onHandMilli = 5;
    expect(replay([])).toEqual({ onHandMilli: 0, avgE4: null });
    expect(Object.isFrozen(EMPTY_STOCK)).toBe(true);
  });

  it('treats two lines with the same id as a broken ledger', () => {
    const p = line('2026-11-01', purchase(1000, 100));
    expectServerError(() => replay([p, { ...p }]), new RegExp(`Ledger line ${p.id} appears twice`));
  });

  it('does not change the order of the lines it was given', () => {
    const lines = [line('2026-11-03', purchase(1000, 100)), line('2026-11-01', purchase(1000, 300))];
    const ids = lines.map((l) => l.id);
    replay(lines);
    expect(lines.map((l) => l.id)).toEqual(ids);
  });
});

describe('fast path or replay (design note 2.3)', () => {
  it('uses the fast path for a line dated on or after the latest line, and for the first line', () => {
    expect(canUseFastPath('purchase', '2026-11-03', null, null)).toBe(true);
    expect(canUseFastPath('purchase', '2026-11-03', '2026-11-03', null)).toBe(true);
    expect(canUseFastPath('run_use', '2026-11-04', '2026-11-03', '2026-11-03')).toBe(true);
  });

  it('replays a non-count line dated on the date of a count, which now comes after it (D-46), but not a count itself', () => {
    expect(canUseFastPath('purchase', '2026-11-03', '2026-11-03', '2026-11-03')).toBe(false);
    expect(canUseFastPath('spillage', '2026-11-03', '2026-11-03', '2026-11-03')).toBe(false);
    expect(canUseFastPath('run_use', '2026-11-03', '2026-11-03', '2026-11-03')).toBe(false);
    expect(canUseFastPath('count_correction', '2026-11-03', '2026-11-03', '2026-11-03')).toBe(true);
    // A count on an earlier date does not matter to a later line, nor to one on the latest date.
    expect(canUseFastPath('purchase', '2026-11-04', '2026-11-04', '2026-11-03')).toBe(true);
    expect(canUseFastPath('purchase', '2026-11-03', '2026-11-03', '2026-11-02')).toBe(true);
    expect(canUseFastPath('count_correction', '2026-11-02', '2026-11-03', '2026-11-02')).toBe(false);
  });

  it('puts a count after every other kind on its date, then by id (D-46)', () => {
    const rows = [
      { id: 1, kind: 'count_correction', effectiveDate: '2026-11-03' },
      { id: 2, kind: 'purchase', effectiveDate: '2026-11-03' },
      { id: 3, kind: 'count_correction', effectiveDate: '2026-11-03' },
      { id: 4, kind: 'spillage', effectiveDate: '2026-11-03' },
      { id: 5, kind: 'purchase', effectiveDate: '2026-11-02' },
      { id: 6, kind: 'count_correction', effectiveDate: '2026-11-02' },
    ];
    expect([...rows].sort(compareLedgerOrder).map((r) => r.id)).toEqual([5, 6, 2, 4, 1, 3]);
  });

  it('replays a same-day purchase before the count made earlier that day', () => {
    // Buy 1000 for P1000 (1,000,000 e4 per unit) on day 1; a count on day 2 stores -200; a purchase on day 2 is entered after it.
    const buy1 = line('2026-11-01', purchase(1_000_000, 100_000));
    const count = line('2026-11-02', { kind: 'count_correction', quantityMilli: -200_000, totalCostCents: null });
    const buy2 = line('2026-11-02', purchase(1_000_000, 300_000));
    // Purchase first: (1,000,000 x 1,000,000 + 300,000 x 10^7) / 2,000,000 = 2,000,000; then the count: 1,800,000 on hand.
    expect(replay([buy1, count, buy2])).toEqual({ onHandMilli: 1_800_000, avgE4: 2_000_000 });
    expect(replaySteps([buy1, count, buy2]).map((s) => s.line.id)).toEqual([buy1.id, buy2.id, count.id]);
  });

  it('replays for a back-dated line and for every reversal', () => {
    expect(canUseFastPath('purchase', '2026-11-02', '2026-11-03', null)).toBe(false);
    expect(canUseFastPath('purchase_reversal', '2026-11-03', '2026-11-03', null)).toBe(false);
    expect(canUseFastPath('purchase_reversal', '2026-11-03', null, null)).toBe(false);
  });

  it('always agrees with a full replay, over many random ledgers', () => {
    // A seeded 32-bit generator (mulberry32), so a failure can be reproduced.
    let seed = 20261103;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const seen = { dates: new Set<string>(), positiveCounts: 0, negativeCounts: 0, weighted: 0, backDated: 0, sameDay: 0 };
    const kinds: MovementKind[] = ['purchase', 'purchase', 'run_use', 'run_use', 'void_return', 'spillage', 'count_correction'];

    for (let ledger = 0; ledger < 300; ledger++) {
      const lines: LedgerLine[] = [];
      let cached: StockState = EMPTY_STOCK;
      let latest: string | null = null;
      let latestCount: string | null = null;
      for (let step = 0; step < 25; step++) {
        // Mostly the same day as the latest line or the next, sometimes any earlier or later day.
        const latestDay = latest === null ? 1 : Number(latest.slice(8));
        const day = rand(10) < 7 ? Math.min(20, latestDay + rand(2)) : 1 + rand(20);
        const date = `2026-11-${String(day).padStart(2, '0')}`;
        const lastPurchase = [...lines].reverse().find((l) => l.kind === 'purchase');
        const reversed = new Set(lines.map((l) => l.reversesMovementId));
        let next: LedgerLine;
        if (rand(10) === 0 && lastPurchase && !reversed.has(lastPurchase.id)) {
          next = reversal(lastPurchase.effectiveDate, lastPurchase);
        } else {
          const kind = kinds[rand(kinds.length)]!;
          // At least 1 unit, so any total up to P20,000 stays under the per-unit price limit.
          const q = 1000 + rand(5_000_000);
          const entry: StockEntry =
            kind === 'purchase'
              ? purchase(q, rand(2_000_000))
              : kind === 'run_use' || kind === 'spillage'
                ? { kind, quantityMilli: -Math.ceil(q / 4), totalCostCents: null }
                : kind === 'count_correction'
                  ? { kind, quantityMilli: rand(2) ? q : -q, totalCostCents: null }
                  : { kind, quantityMilli: q, totalCostCents: null };
          next = line(date, entry);
        }
        const fast = canUseFastPath(next.kind, next.effectiveDate, latest, latestCount);
        seen.dates.add(next.effectiveDate);
        if (next.kind === 'count_correction') seen[next.quantityMilli > 0 ? 'positiveCounts' : 'negativeCounts']++;
        if (fast && next.kind === 'purchase' && cached.onHandMilli > 0 && cached.avgE4 !== null) seen.weighted++;
        if (!fast) seen.backDated++;
        if (lines.some((l) => l.effectiveDate === next.effectiveDate)) seen.sameDay++;
        lines.push(next);
        cached = fast ? applyEntry(cached, next) : replay(lines);
        if (latest === null || next.effectiveDate > latest) latest = next.effectiveDate;
        if (next.kind === 'count_correction' && (latestCount === null || next.effectiveDate > latestCount)) latestCount = next.effectiveDate;
      }
      expect(cached).toEqual(replay(lines));
      // The order the database returns lines in must not matter.
      const shuffled = [...lines];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(replay(shuffled)).toEqual(cached);
      // On hand is the plain sum of the ledger, whatever the order.
      expect(cached.onHandMilli).toBe(lines.reduce((a, l) => a + l.quantityMilli, 0));
    }
    // The generator really covers the cases this test claims.
    expect(seen.dates.size).toBe(20);
    expect(Math.min(seen.positiveCounts, seen.negativeCounts)).toBeGreaterThan(300);
    expect(seen.weighted).toBeGreaterThan(500);
    expect(seen.backDated).toBeGreaterThan(1000);
    expect(seen.sameDay).toBeGreaterThan(1000);
  });
});

describe('typed quantities (Q42, Q53)', () => {
  it('converts kg and L to g and mL exactly, by integer arithmetic', () => {
    expect(parseQuantity('1.25', 'kg', 'g')).toBe(1_250_000);
    expect(parseQuantity('0.1', 'L', 'mL')).toBe(100_000);
    expect(parseQuantity('1.005', 'kg', 'g')).toBe(1_005_000);
    expect(parseQuantity('0.000001', 'kg', 'g')).toBe(1);
    expect(parseQuantity('2.5', 'mL', 'mL')).toBe(2500);
    expect(parseQuantity('0.001', 'g', 'g')).toBe(1);
    expect(parseQuantity('3', 'pc', 'pc')).toBe(3000);
    expect(parseQuantity(' 7 ', 'g', 'g')).toBe(7000);
    expect(parseQuantity('0', 'g', 'g')).toBe(0);
    expect(parseQuantity('007.50', 'g', 'g')).toBe(7500);
  });

  it('refuses too many decimals instead of rounding', () => {
    expect(() => parseQuantity('0.0000001', 'kg', 'g')).toThrow('A quantity in kg can have at most 6 decimals.');
    expect(() => parseQuantity('2.0005', 'mL', 'mL')).toThrow('A quantity in mL can have at most 3 decimals.');
    expect(() => parseQuantity('2.5', 'pc', 'pc')).toThrow('Pieces must be whole numbers.');
    expect(() => parseQuantity('2.0', 'pc', 'pc')).toThrow('Pieces must be whole numbers.');
  });

  it('refuses a unit that does not match the ingredient', () => {
    expect(() => parseQuantity('1', 'L', 'g')).toThrow('This ingredient is measured in g, so it cannot be entered in L.');
    expect(() => parseQuantity('1', 'kg', 'pc')).toThrow(CalcError);
    expect(() => parseQuantity('1', 'g', 'mL')).toThrow(CalcError);
    expect(() => parseQuantity('1', 'lb' as EntryUnit, 'g')).toThrow(CalcError);
    expect(() => parseQuantity('1', 'constructor' as EntryUnit, 'g')).toThrow(CalcError);
  });

  it('refuses anything that is not a plain number', () => {
    for (const text of ['', ' ', '-1', '+1', '1,000', '1e3', '.5', '5.', '1.2.3', 'abc', 'Infinity', '0x10', '½', '１２', '٣']) {
      expect(() => parseQuantity(text, 'g', 'g'), text).toThrow('Enter the quantity as a number, for example 2.5.');
    }
  });

  it('refuses a value that is not text, and very long text, with a plain message', () => {
    for (const value of [2.5, null, undefined, {}, ['1']]) {
      expect(() => parseQuantity(value, 'g', 'g'), String(value)).toThrow(
        new CalcError('Enter the quantity as a number, for example 2.5.'),
      );
    }
    expect(() => parseQuantity('1'.repeat(31), 'g', 'g')).toThrow(CalcError);
    expect(() => parseQuantity('9'.repeat(1_000_000), 'g', 'g')).toThrow(CalcError);
  });

  it('accepts up to 10,000,000 base units and refuses more, naming the unit', () => {
    expect(parseQuantity('10000000', 'g', 'g')).toBe(MAX_QUANTITY_MILLI);
    expect(parseQuantity('10000', 'kg', 'g')).toBe(MAX_QUANTITY_MILLI);
    expect(() => parseQuantity('10000000.001', 'g', 'g')).toThrow('A quantity can be at most 10,000,000 g per entry.');
    expect(() => parseQuantity('10000.000001', 'kg', 'g')).toThrow(
      'A quantity can be at most 10,000,000 g (10,000 kg) per entry.',
    );
    expect(() => parseQuantity('10001', 'L', 'mL')).toThrow('A quantity can be at most 10,000,000 mL (10,000 L) per entry.');
    expect(() => parseQuantity('10000001', 'pc', 'pc')).toThrow('A quantity can be at most 10,000,000 pc per entry.');
    expect(() => parseQuantity('99999999999999999999999', 'g', 'g')).toThrow(CalcError);
  });

  it('checks that stored piece quantities are whole pieces', () => {
    expect(() => checkWholePieces(3000, 'pc')).not.toThrow();
    expect(() => checkWholePieces(-3000, 'pc')).not.toThrow();
    expect(() => checkWholePieces(2500, 'pc')).toThrow('Pieces must be whole numbers.');
    expect(() => checkWholePieces(-1500, 'pc')).toThrow(CalcError);
    expect(() => checkWholePieces(2500, 'g')).not.toThrow();
  });
});

describe('reading bigint values from the database', () => {
  it('accepts strings, numbers and BigInts that are whole and safe', () => {
    expect(toSafeInteger('123')).toBe(123);
    expect(toSafeInteger('-5')).toBe(-5);
    expect(toSafeInteger('0')).toBe(0);
    expect(toSafeInteger(42)).toBe(42);
    expect(toSafeInteger(10_000_000_000n)).toBe(10_000_000_000);
    expect(toSafeInteger(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses values outside the safe range, fractions and non-numbers', () => {
    for (const v of [
      '9007199254740992',
      2n ** 60n,
      -(2n ** 60n),
      2 ** 60,
      '1.5',
      '1.000',
      1.5,
      '',
      ' 1',
      null,
      undefined,
      NaN,
      {},
    ]) {
      expect(() => toSafeInteger(v), String(v)).toThrow();
    }
  });
});
