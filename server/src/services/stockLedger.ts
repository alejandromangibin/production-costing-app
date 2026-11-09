import type { z } from 'zod';
import {
  type BaseUnit,
  type LedgerLine,
  MAX_QUANTITY_MILLI,
  type StockEntry,
  type StockState,
  applyEntry,
  canUseFastPath,
  checkEntry,
  checkWholePieces,
  parseQuantity,
  replay,
  toSafeInteger,
} from '../calc/stock';
import { CalcError } from '../calc/types';
import { localToday } from '../dates';
import type { Db, Queryable } from '../db/index';
import { badRequest, conflict, notFound } from '../errors';
import type { correctionBody, openingBody, purchaseBody, reversalBody } from '../schemas';
import { type Ingredient, type IngredientWithCost, getIngredient, getIngredientWithCost } from './ingredients';
import type { Actor } from './runs';

/** An ingredient row as read under its lock: the only figures a stock change may use (design note 4, rule 1). */
export interface LockedIngredient {
  id: number;
  baseUnit: BaseUnit;
  active: boolean;
  state: StockState;
}

/**
 * Lock ingredients in ascending id order, so two saves cannot deadlock, and read them. Everything that
 * changes stock starts here: on hand, the average, the unit and whether it is archived are read only
 * after the lock, and an id the business cannot see is "not found".
 */
export async function lockIngredients(q: Queryable, ids: number[]): Promise<Map<number, LockedIngredient>> {
  const wanted = [...new Set(ids)].sort((a, b) => a - b);
  const rows = (
    await q.query(
      `SELECT id, base_unit, active, on_hand_milli, avg_cost_e4 FROM ingredients
       WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE`,
      [wanted],
    )
  ).rows;
  if (rows.length !== wanted.length) throw notFound('Ingredient not found');
  return new Map(
    rows.map((r) => [
      r.id as number,
      {
        id: r.id as number,
        baseUnit: r.base_unit as BaseUnit,
        active: r.active as boolean,
        state: {
          onHandMilli: toSafeInteger(r.on_hand_milli),
          avgE4: r.avg_cost_e4 === null ? null : toSafeInteger(r.avg_cost_e4),
        },
      },
    ]),
  );
}

/** Every ledger line of one ingredient, as the replay needs them. */
async function ledgerLines(q: Queryable, ingredientId: number): Promise<LedgerLine[]> {
  const rows = (
    await q.query(
      `SELECT id, kind, effective_date::text AS effective_date, quantity_milli, total_cost_cents, reverses_movement_id
       FROM stock_movements WHERE ingredient_id = $1`,
      [ingredientId],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id as number,
    kind: r.kind,
    effectiveDate: r.effective_date as string,
    quantityMilli: toSafeInteger(r.quantity_milli),
    totalCostCents: r.total_cost_cents as number | null,
    reversesMovementId: r.reverses_movement_id as number | null,
  }));
}

export interface NewLine extends StockEntry {
  effectiveDate: string;
  supplier?: string;
  reference?: string;
  expiryDate?: string | null;
  reason?: string;
  reversesMovementId?: number;
}

/**
 * Add one ledger line to a locked ingredient and bring its cached copy up to date (design note 2.3):
 * one step when the line is dated on or after the ledger's latest line, otherwise a replay of the whole
 * ledger in date order. The average's version goes up only when the average really changes.
 *
 * `ingredient.state` is kept up to date, so several lines for one ingredient can go through one lock
 * (two lines of the same ingredient on a run, Q44). Refusals are CalcErrors: pass them through plainRefusal.
 */
export async function addLedgerLine(q: Queryable, ingredient: LockedIngredient, line: NewLine, actor: Actor): Promise<number> {
  checkEntry(line);
  checkWholePieces(line.quantityMilli, ingredient.baseUnit);
  const enteredBy = actor.name.trim();
  if (!enteredBy) throw new Error('A ledger line needs the name of the person entering it.');
  const latest = (
    await q.query<{ latest: string | null }>(
      'SELECT max(effective_date)::text AS latest FROM stock_movements WHERE ingredient_id = $1',
      [ingredient.id],
    )
  ).rows[0]!.latest;
  const fast = canUseFastPath(line.kind, line.effectiveDate, latest);

  const inserted = await q.query<{ id: number }>(
    `INSERT INTO stock_movements (ingredient_id, kind, effective_date, quantity_milli, total_cost_cents,
                                  supplier, reference, expiry_date, reason, reverses_movement_id, entered_by_user_id, entered_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [ingredient.id, line.kind, line.effectiveDate, line.quantityMilli, line.totalCostCents,
     line.supplier ?? '', line.reference ?? '', line.expiryDate ?? null, line.reason ?? '', line.reversesMovementId ?? null, actor.id, enteredBy],
  );

  const after = fast ? applyEntry(ingredient.state, line) : replay(await ledgerLines(q, ingredient.id));
  await q.query(
    `UPDATE ingredients SET on_hand_milli = $2, avg_cost_e4 = $3, avg_version = avg_version + $4 WHERE id = $1`,
    [ingredient.id, after.onHandMilli, after.avgE4, after.avgE4 === ingredient.state.avgE4 ? 0 : 1],
  );
  ingredient.state = after;
  return inserted.rows[0]!.id;
}

/** The stock maths words its refusals for the person, so they go out as a plain 400 (design note 2.1). */
export function plainRefusal(err: unknown): unknown {
  return err instanceof CalcError ? badRequest(err.message) : err;
}

export interface PurchaseResult {
  movementId: number;
  ingredient: Ingredient;
}

/**
 * Record a purchase (INV-02): lock, check, add the line, update on hand and the average, all or nothing.
 * Staff and owner can record; `withCost` decides whether the answer shows the average. The quantity is
 * worked out after the lock, from the unit the ingredient has then.
 */
export async function recordPurchase(
  db: Db,
  ingredientId: number,
  input: z.infer<typeof purchaseBody>,
  actor: Actor,
  withCost: boolean,
): Promise<PurchaseResult> {
  if (input.effectiveDate > localToday()) throw badRequest('The purchase date cannot be in the future.');
  try {
    return await db.tx(async (q) => {
      const ingredient = (await lockIngredients(q, [ingredientId])).get(ingredientId)!;
      if (!ingredient.active) throw conflict('This ingredient is archived, so it cannot be bought. The owner can turn it back on.');
      const quantityMilli = parseQuantity(input.quantity, input.unit, ingredient.baseUnit);
      const movementId = await addLedgerLine(
        q,
        ingredient,
        {
          kind: 'purchase',
          quantityMilli,
          totalCostCents: input.totalCostCents,
          effectiveDate: input.effectiveDate,
          supplier: input.supplier,
          reference: input.reference,
          expiryDate: input.expiryDate,
        },
        actor,
      );
      return { movementId, ingredient: await (withCost ? getIngredientWithCost : getIngredient)(q, ingredientId) };
    });
  } catch (err) {
    throw plainRefusal(err);
  }
}

export interface OwnerStockResult {
  movementId: number;
  /** The signed change stored on the line, thousandths: for a count, the difference and not the number typed. */
  quantityMilli: number;
  ingredient: IngredientWithCost;
}

/** Whether the ingredient has an opening balance that has not been reversed. */
async function hasStandingOpening(q: Queryable, ingredientId: number): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM stock_movements o
     WHERE o.ingredient_id = $1 AND o.kind = 'opening'
       AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = o.id)
     LIMIT 1`,
    [ingredientId],
  );
  return r.rows.length > 0;
}

/**
 * Record an opening balance (INV-08): quantity and what it cost, entered once per ingredient (Q46). A
 * reversed one no longer counts, so a wrong one can be entered again (Q51). Owner only. Corrections
 * also work on an archived ingredient (Q50), and an opening balance is one of them.
 */
export async function recordOpening(db: Db, ingredientId: number, input: z.infer<typeof openingBody>, actor: Actor): Promise<OwnerStockResult> {
  if (input.effectiveDate > localToday()) throw badRequest('The date cannot be in the future.');
  try {
    return await db.tx(async (q) => {
      const ingredient = (await lockIngredients(q, [ingredientId])).get(ingredientId)!;
      if (await hasStandingOpening(q, ingredientId)) throw conflict('This ingredient already has an opening balance.');
      const quantityMilli = parseQuantity(input.quantity, input.unit, ingredient.baseUnit);
      const movementId = await addLedgerLine(
        q,
        ingredient,
        {
          kind: 'opening',
          quantityMilli,
          totalCostCents: input.totalCostCents,
          effectiveDate: input.effectiveDate,
          reason: input.reason,
        },
        actor,
      );
      return { movementId, quantityMilli, ingredient: await getIngredientWithCost(q, ingredientId) };
    });
  } catch (err) {
    throw plainRefusal(err);
  }
}

/** What the ledger says was on hand at the end of a day. */
async function onHandAtEndOf(q: Queryable, ingredientId: number, date: string): Promise<number> {
  const r = await q.query<{ total: unknown }>(
    'SELECT COALESCE(sum(quantity_milli), 0) AS total FROM stock_movements WHERE ingredient_id = $1 AND effective_date <= $2',
    [ingredientId, date],
  );
  return toSafeInteger(r.rows[0]!.total);
}

/**
 * Record spillage, spoilage or a stock-count correction (INV-08). Owner only, always with a reason.
 *
 * For a count the owner types what they counted, and only the difference is stored: the count minus the
 * ledger as of the end of that date (Q52). Lines dated later are unaffected. A count equal to the ledger is
 * refused as "nothing to correct".
 *
 * These lines carry no cost, so dated on or after the latest line they leave the average alone. Back-dated,
 * they change how much stock later purchases are averaged against, so the replay can move the average
 * (design note 2.3).
 */
export async function recordCorrection(db: Db, ingredientId: number, input: z.infer<typeof correctionBody>, actor: Actor): Promise<OwnerStockResult> {
  if (input.effectiveDate > localToday()) throw badRequest('The date cannot be in the future.');
  try {
    return await db.tx(async (q) => {
      const ingredient = (await lockIngredients(q, [ingredientId])).get(ingredientId)!;
      const typedMilli = parseQuantity(input.quantity, input.unit, ingredient.baseUnit);
      let quantityMilli = -typedMilli;
      if (input.kind === 'count_correction') {
        quantityMilli = typedMilli - (await onHandAtEndOf(q, ingredientId, input.effectiveDate));
        if (Math.abs(quantityMilli) > MAX_QUANTITY_MILLI) {
          throw badRequest(`The difference from the recorded stock can be at most 10,000,000 ${ingredient.baseUnit} per entry.`);
        }
      }
      const movementId = await addLedgerLine(
        q,
        ingredient,
        { kind: input.kind, quantityMilli, totalCostCents: null, effectiveDate: input.effectiveDate, reason: input.reason },
        actor,
      );
      return { movementId, quantityMilli, ingredient: await getIngredientWithCost(q, ingredientId) };
    });
  } catch (err) {
    throw plainRefusal(err);
  }
}

/**
 * The rule for reversing a line (D-42, D-43, D-45), in one place: reverseEntry applies it and the history screen
 * asks it which line can be reversed now. Returns the line, or throws the refusal the person sees.
 */
export function checkReversible(lines: readonly LedgerLine[], movementId: number): LedgerLine {
  const target = lines.find((l) => l.id === movementId);
  if (!target) throw notFound('Stock entry not found');
  if (target.kind !== 'purchase' && target.kind !== 'opening') throw badRequest('Only a purchase or an opening balance can be reversed.');
  const reversed = new Set(lines.map((l) => l.reversesMovementId));
  if (reversed.has(target.id)) throw conflict('This entry has already been reversed.');

  const standing = lines.filter((l) => l.kind !== 'purchase_reversal' && !reversed.has(l.id));
  if (standing.some((l) => l.id > target.id)) {
    throw conflict('Only the last entry made for this ingredient can be reversed. Use a count correction instead.');
  }
  return target;
}

/** The id of the one line that checkReversible accepts now, or null. Only the newest purchase or opening not yet reversed can pass. */
export function reversibleMovementId(lines: readonly LedgerLine[]): number | null {
  const reversed = new Set(lines.map((l) => l.reversesMovementId));
  const candidate = lines
    .filter((l) => (l.kind === 'purchase' || l.kind === 'opening') && !reversed.has(l.id))
    .reduce<LedgerLine | null>((best, l) => (best === null || l.id > best.id ? l : best), null);
  if (!candidate) return null;
  try {
    return checkReversible(lines, candidate.id).id;
  } catch {
    return null;
  }
}

/**
 * Undo a purchase or opening balance entered by mistake (INV-16, Q51). Owner only, with a reason.
 *
 * It must be the last entry made for the ingredient, whatever its date: an opening balance (D-42) or a purchase
 * (D-45). Both are often dated before a line already recorded, and a wrong cost could otherwise never be taken
 * out of the average. Lines already undone do not count (D-43). Anything else is fixed with a count
 * correction. The reversal takes the line's own date and the ledger is worked out again without the pair, so
 * stock and the average end up as if it had never been entered. Saved runs keep the cost they used.
 */
export async function reverseEntry(
  db: Db,
  ingredientId: number,
  movementId: number,
  input: z.infer<typeof reversalBody>,
  actor: Actor,
): Promise<OwnerStockResult> {
  try {
    return await db.tx(async (q) => {
      const ingredient = (await lockIngredients(q, [ingredientId])).get(ingredientId)!;
      const target = checkReversible(await ledgerLines(q, ingredientId), movementId);

      const reversalId = await addLedgerLine(
        q,
        ingredient,
        {
          kind: 'purchase_reversal',
          quantityMilli: -target.quantityMilli,
          totalCostCents: null,
          effectiveDate: target.effectiveDate,
          reason: input.reason,
          reversesMovementId: target.id,
        },
        actor,
      );
      return { movementId: reversalId, quantityMilli: -target.quantityMilli, ingredient: await getIngredientWithCost(q, ingredientId) };
    });
  } catch (err) {
    throw plainRefusal(err);
  }
}
