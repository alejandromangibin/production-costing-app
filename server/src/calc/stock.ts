import { divRoundHalfUp } from './allocate';
import { CalcError } from './types';

/**
 * Ingredient stock maths (design note docs/inventory-data-design.md, section 2).
 *
 * Units, all whole numbers:
 * - quantities in thousandths of the base unit (`milli`): 2.5 mL is 2500;
 * - the average in ten-thousandths of a centavo per base unit (`e4`): P0.11004/mL is 110,040;
 * - money in centavos (`cents`).
 *
 * All multiplication and division is done in BigInt, rounding half up. `applyEntry` is the only code
 * that changes on hand and the average; the fast path and the replay both use it, so they agree to the
 * last digit.
 */

export type BaseUnit = 'g' | 'mL' | 'pc';
/** What the owner or staff typed the quantity in. kg and L are converted to g and mL (Q42). */
export type EntryUnit = BaseUnit | 'kg' | 'L';

export type MovementKind =
  | 'opening'
  | 'purchase'
  | 'purchase_reversal'
  | 'run_use'
  | 'void_return'
  | 'spillage'
  | 'spoilage'
  | 'count_correction';

/** At most 10,000,000 base units per entry. */
export const MAX_QUANTITY_MILLI = 10_000_000_000;
/** At most P20,000,000 per purchase or per ingredient line, the app's money limit. */
export const MAX_AMOUNT_CENTS = 2_000_000_000;
/** At most P1,000,000 per base unit. An average is a mix of unit prices, so it stays within this too. */
export const MAX_AVG_E4 = 1_000_000_000_000;
/** total_cost_cents <= this x quantity_milli is the same P1,000,000-per-unit limit, in whole numbers. */
export const MAX_CENTS_PER_MILLI = 100_000;

/** milli x e4 / 10^7 = centavos. */
const SCALE = 10_000_000n;

export interface StockState {
  onHandMilli: number;
  /** Null until the first purchase or opening balance. */
  avgE4: number | null;
}

export interface StockEntry {
  kind: MovementKind;
  /** Signed change in on hand, as stored on the ledger line. */
  quantityMilli: number;
  /** Set on opening balances and purchases only. */
  totalCostCents: number | null;
}

/** A ledger line as the replay needs it. */
export interface LedgerLine extends StockEntry {
  id: number;
  /** YYYY-MM-DD. */
  effectiveDate: string;
  reversesMovementId: number | null;
}

export const EMPTY_STOCK: Readonly<StockState> = Object.freeze({ onHandMilli: 0, avgE4: null });

/** The sign each kind's quantity has (design note 1.4), and whether zero is allowed. Null: either sign, never zero. */
function quantitySign(kind: MovementKind): { sign: 1 | -1; zeroAllowed: boolean } | null {
  switch (kind) {
    case 'opening':
    case 'purchase':
      return { sign: 1, zeroAllowed: false };
    case 'void_return':
      return { sign: 1, zeroAllowed: true };
    case 'run_use':
      return { sign: -1, zeroAllowed: true };
    case 'purchase_reversal':
    case 'spillage':
    case 'spoilage':
      return { sign: -1, zeroAllowed: false };
    case 'count_correction':
      return null;
    default:
      throw new Error(`Unknown movement kind: ${String(kind)}`);
  }
}

const isCostKind = (kind: MovementKind) => kind === 'opening' || kind === 'purchase';

function toSafe(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${what} is outside the safe integer range.`);
  }
  return Number(value);
}

/**
 * Check one entry against the limits in design note 2.1 and the kinds table in 1.4.
 * Throws CalcError (shown to the person) for anything they could have typed, and a plain Error for what
 * only a server bug can produce: the server sets the sign, and parseQuantity always returns whole numbers.
 */
export function checkEntry(entry: StockEntry): void {
  const q = entry.quantityMilli;
  const rule = quantitySign(entry.kind);
  if (!Number.isSafeInteger(q)) throw new Error(`A quantity must be a whole number of thousandths, not ${q}.`);
  if (q === 0 && !rule?.zeroAllowed) {
    throw new CalcError(
      entry.kind === 'count_correction' ? 'Nothing to correct: the count matches the recorded stock for that date.' : 'The quantity must be more than zero.',
    );
  }
  if (Math.abs(q) > MAX_QUANTITY_MILLI) throw new CalcError('A quantity can be at most 10,000,000 base units per entry.');
  if (rule && q !== 0 && Math.sign(q) !== rule.sign) throw new Error(`A ${entry.kind} line cannot have quantity ${q}.`);

  const total = entry.totalCostCents;
  if (!isCostKind(entry.kind)) {
    if (total !== null) throw new Error(`A ${entry.kind} line has no total cost.`);
    return;
  }
  if (total === null || !Number.isSafeInteger(total) || total < 0) {
    throw new CalcError('The total price must be a whole number of centavos, zero or more.');
  }
  if (total > MAX_AMOUNT_CENTS) throw new CalcError('The total price can be at most P20,000,000.');
  if (BigInt(total) > BigInt(MAX_CENTS_PER_MILLI) * BigInt(q)) {
    throw new CalcError('The price per g, mL or piece can be at most P1,000,000. Check the quantity and the total.');
  }
}

/** Quantities in pieces are whole pieces, a multiple of 1000 milli (Q53). A database CHECK cannot see the unit. */
export function checkWholePieces(quantityMilli: number, baseUnit: BaseUnit): void {
  if (baseUnit === 'pc' && quantityMilli % 1000 !== 0) throw new CalcError('Pieces must be whole numbers.');
}

/** The cached copy fed to the fast path must be sane; anything else is a broken database row. */
function checkState(state: StockState): void {
  if (!Number.isSafeInteger(state.onHandMilli)) throw new Error(`On hand is not a safe integer: ${state.onHandMilli}`);
  const avg = state.avgE4;
  if (avg !== null && (!Number.isSafeInteger(avg) || avg < 0 || avg > MAX_AVG_E4)) {
    throw new Error(`The average is outside its limits: ${avg}`);
  }
}

/**
 * Apply one ledger line to on hand and the average (design note 2.2, BR-19).
 *
 * - Opening balance or purchase, with stock on hand and an average: the weighted average,
 *   (on hand x average + total) / (on hand + quantity).
 * - Opening balance or purchase, when on hand is zero or below (Q33) or there is no average yet (Q49):
 *   the entry's own price per unit.
 * - Every other kind changes on hand only.
 *
 * The average is rounded half up to e4 after every step. A purchase reversal is never applied as a step:
 * the ledger is replayed without the reversed line (design note 2.3).
 */
export function applyEntry(state: StockState, entry: StockEntry): StockState {
  if (entry.kind === 'purchase_reversal') {
    throw new Error('A reversal is not applied as a step; replay the ledger instead.');
  }
  checkState(state);
  checkEntry(entry);
  const onHand = BigInt(state.onHandMilli);
  const qty = BigInt(entry.quantityMilli);
  const newOnHand = toSafe(onHand + qty, 'On hand');
  if (!isCostKind(entry.kind)) return { onHandMilli: newOnHand, avgE4: state.avgE4 };

  const totalScaled = BigInt(entry.totalCostCents!) * SCALE;
  const avg =
    onHand > 0n && state.avgE4 !== null
      ? divRoundHalfUp(onHand * BigInt(state.avgE4) + totalScaled, onHand + qty)
      : divRoundHalfUp(totalScaled, qty);
  if (avg < 0n || avg > BigInt(MAX_AVG_E4)) throw new Error('The average is outside its limits.');
  return { onHandMilli: newOnHand, avgE4: Number(avg) };
}

/**
 * The cost of using `quantityMilli` (zero or more) at average `avgE4` (BR-20), rounded half up to the
 * centavo once per line.
 */
export function lineCostCents(quantityMilli: number, avgE4: number): number {
  // The caller passes the quantity used, not the signed ledger quantity.
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli < 0) {
    throw new Error(`A quantity used must be a whole number, zero or more, not ${quantityMilli}.`);
  }
  if (quantityMilli > MAX_QUANTITY_MILLI) throw new CalcError('A quantity can be at most 10,000,000 base units per entry.');
  if (!Number.isSafeInteger(avgE4) || avgE4 < 0 || avgE4 > MAX_AVG_E4) {
    throw new Error('The average is outside its limits.');
  }
  const cents = divRoundHalfUp(BigInt(quantityMilli) * BigInt(avgE4), SCALE);
  if (cents > BigInt(MAX_AMOUNT_CENTS)) {
    throw new CalcError('This ingredient line would cost more than P20,000,000. Check the quantity.');
  }
  return Number(cents);
}

/** A stored line that breaks the rules is a broken ledger (a server error), never the person's mistake. */
function invalidLine(line: LedgerLine, e: unknown): Error {
  return new Error(`Ledger line ${line.id} is invalid: ${e instanceof Error ? e.message : String(e)}`);
}

function checkStoredLine(line: LedgerLine): void {
  try {
    checkEntry(line);
  } catch (e) {
    throw invalidLine(line, e);
  }
}

/**
 * Replay the whole ledger of one ingredient and return every step: each line that counts, in the order
 * it counts, with on hand and the average after it (design note 2.3). The price history (INV-10) and the
 * stock check (2.4) use the steps; `replay` uses the last one.
 *
 * Lines are taken in date order, then entry order (id). A reversed line and its reversal are both left
 * out. The ledger is assumed to hold one ingredient only. A reversal must point at an opening balance or
 * purchase in the list, with the opposite quantity and the same date, at most once. Anything else is a
 * broken ledger and throws a plain Error naming the line.
 */
export function replaySteps(lines: readonly LedgerLine[]): { line: LedgerLine; after: StockState }[] {
  const reversed = new Set<number>();
  const byId = new Map<number, LedgerLine>();
  for (const l of lines) {
    if (byId.has(l.id)) throw new Error(`Ledger line ${l.id} appears twice.`);
    byId.set(l.id, l);
  }
  for (const l of lines) {
    if (l.kind !== 'purchase_reversal') continue;
    checkStoredLine(l);
    const target = l.reversesMovementId === null ? undefined : byId.get(l.reversesMovementId);
    if (
      !target ||
      !isCostKind(target.kind) ||
      target.quantityMilli !== -l.quantityMilli ||
      target.effectiveDate !== l.effectiveDate
    ) {
      throw new Error(`Reversal ${l.id} does not match the line it reverses.`);
    }
    checkStoredLine(target);
    if (reversed.has(target.id)) throw new Error(`Line ${target.id} is reversed more than once.`);
    reversed.add(target.id);
  }

  const ordered = lines
    .filter((l) => l.kind !== 'purchase_reversal' && !reversed.has(l.id))
    .sort((a, b) => (a.effectiveDate === b.effectiveDate ? a.id - b.id : a.effectiveDate < b.effectiveDate ? -1 : 1));
  const steps: { line: LedgerLine; after: StockState }[] = [];
  let state = EMPTY_STOCK;
  for (const line of ordered) {
    try {
      state = applyEntry(state, line);
    } catch (e) {
      throw invalidLine(line, e);
    }
    steps.push({ line, after: state });
  }
  return steps;
}

/** On hand and the average from the whole ledger of one ingredient: the last step of `replaySteps`. */
export function replay(lines: readonly LedgerLine[]): StockState {
  const steps = replaySteps(lines);
  return steps.length ? steps[steps.length - 1]!.after : { ...EMPTY_STOCK };
}

/**
 * Whether a new line can be applied to the cached copy (the fast path), or the whole ledger must be
 * replayed: any back-dated line, and every reversal (design note 2.3). `latestDate` is the latest
 * effective date already in the ingredient's ledger, null when it is empty.
 */
export function canUseFastPath(kind: MovementKind, effectiveDate: string, latestDate: string | null): boolean {
  if (kind === 'purchase_reversal') return false;
  return latestDate === null || effectiveDate >= latestDate;
}

const DECIMALS: Record<EntryUnit, number> = { g: 3, mL: 3, pc: 0, kg: 6, L: 6 };
const BASE_OF: Record<EntryUnit, BaseUnit> = { g: 'g', mL: 'mL', pc: 'pc', kg: 'g', L: 'mL' };
/** Milli-base-units per one entry unit. */
const MILLI_PER: Record<EntryUnit, bigint> = { g: 1000n, mL: 1000n, pc: 1000n, kg: 1_000_000n, L: 1_000_000n };

/**
 * Turn a typed quantity such as "1.25" kg into thousandths of the ingredient's base unit, using only
 * integer arithmetic on the digits (Q42). Too many decimals is refused, not rounded: at most 3 for g and mL,
 * 6 for kg and L, and none for pieces (Q53). Returns zero or more; whether zero is allowed is up to the caller.
 */
export function parseQuantity(text: unknown, unit: EntryUnit, baseUnit: BaseUnit): number {
  if (!Object.hasOwn(BASE_OF, unit) || BASE_OF[unit] !== baseUnit) {
    throw new CalcError(`This ingredient is measured in ${baseUnit}, so it cannot be entered in ${unit}.`);
  }
  // A quantity within the limit needs at most 15 characters; refusing long text early keeps BigInt cheap.
  const m = typeof text === 'string' && text.length <= 30 ? /^(\d+)(?:\.(\d+))?$/.exec(text.trim()) : null;
  if (!m) throw new CalcError('Enter the quantity as a number, for example 2.5.');
  const [, whole, fraction = ''] = m;
  const decimals = DECIMALS[unit];
  if (fraction.length > decimals) {
    throw new CalcError(
      decimals === 0
        ? 'Pieces must be whole numbers.'
        : `A quantity in ${unit} can have at most ${decimals} decimals.`,
    );
  }
  // 10^decimals digits make one entry unit; MILLI_PER is a multiple of that for every unit.
  const digits = BigInt(whole! + fraction.padEnd(decimals, '0'));
  const milli = (digits * MILLI_PER[unit]) / 10n ** BigInt(decimals);
  if (milli > BigInt(MAX_QUANTITY_MILLI)) {
    const big = unit === baseUnit ? '' : ` (10,000 ${unit})`;
    throw new CalcError(`A quantity can be at most 10,000,000 ${baseUnit}${big} per entry.`);
  }
  return Number(milli);
}

/**
 * Read a bigint or numeric value back from the database as a JavaScript integer. node-postgres returns
 * bigint and numeric as strings; PGlite returns a number when it is safe and a BigInt otherwise.
 */
export function toSafeInteger(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`Not a safe integer: ${value}`);
    return value;
  }
  if (typeof value === 'bigint') return toSafe(value, String(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return toSafe(BigInt(value), value);
  throw new Error(`Not an integer value: ${String(value)}`);
}
