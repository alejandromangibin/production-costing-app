import { type LedgerLine, compareLedgerOrder, type MovementKind, replaySteps, toSafeInteger, unitPriceE4 } from '../calc/stock';
import type { Queryable } from '../db/index';
import { notFound } from '../errors';
import { type IngredientWithCost, getIngredientWithCost } from './ingredients';
import { reversibleMovementId } from './stockLedger';

/** One ledger line as the owner's history screens show it (INV-10, INV-08). */
export interface MovementView {
  id: number;
  kind: MovementKind;
  /** YYYY-MM-DD. */
  effectiveDate: string;
  /** Signed change in on hand, thousandths of the base unit. */
  quantityMilli: number;
  /** Purchases and opening balances only. */
  totalCostCents: number | null;
  /** Purchases and opening balances only: the line's own price per base unit, in 1/10,000 centavo. */
  unitPriceE4: number | null;
  supplier: string;
  reference: string;
  expiryDate: string | null;
  reason: string;
  enteredByName: string;
  enteredAt: string;
  /** The reversal that undid this line, or null. */
  reversedById: number | null;
  /** The line this one undoes (only a reversal), or null. */
  reversesMovementId: number | null;
  runId: number | null;
  /** The average a run line used. */
  unitCostE4: number | null;
  /** On hand and the average right after this line, with the ledger worked out in date order. Null for a line that was undone and for its reversal: they are left out of the working. */
  onHandAfterMilli: number | null;
  averageAfterE4: number | null;
  /**
   * Date of the oldest count that was entered before this line, is dated on or after it, and no longer matches the
   * ledger (D-44): counts need entering again from there, oldest first. Otherwise null.
   */
  needsRecount: string | null;
}

export interface MovementHistory {
  ingredient: IngredientWithCost;
  /** In the order they count: by date, a count last on its day (D-46), then by entry. */
  movements: MovementView[];
  /** The one line that can be reversed now, by the same rule as the reversal itself, or null. */
  reversibleMovementId: number | null;
}

interface CountRef {
  id: number;
  effectiveDate: string;
}

/**
 * The counts that no longer match the ledger (D-44). A count says what was on the shelf at the end of its date. It
 * stops matching when lines entered after it, and dated on or before its date, add up to something other than zero:
 * they moved on hand away from what was counted. A reversed line and its reversal both count in the sum and net out.
 * A count is left out when a later count has the same date: that one is the fresher answer for the day.
 */
export function countsOutOfDate(ledger: readonly { id: number; kind: string; effectiveDate: string; quantityMilli: number }[]): CountRef[] {
  const counts = ledger.filter((l) => l.kind === 'count_correction');
  return counts
    .filter((c) => !counts.some((later) => later.id > c.id && later.effectiveDate === c.effectiveDate))
    .filter((c) => ledger.reduce((sum, l) => (l.id > c.id && l.effectiveDate <= c.effectiveDate ? sum + l.quantityMilli : sum), 0) !== 0)
    .map((c) => ({ id: c.id, effectiveDate: c.effectiveDate }));
}

/**
 * The D-44 notice: a line gets one while a count entered before it, dated on or after it, no longer matches. The answer
 * is the date of the oldest such count, where entering counts again starts. A line with no quantity (a run that used
 * nothing) never gets one, and neither does the line itself.
 */
export function needsRecountDate(line: { id: number; effectiveDate: string; quantityMilli: number }, outOfDate: readonly CountRef[]): string | null {
  if (line.quantityMilli === 0) return null;
  let oldest: string | null = null;
  for (const c of outOfDate) {
    if (c.id >= line.id || c.effectiveDate < line.effectiveDate) continue;
    if (oldest === null || c.effectiveDate < oldest) oldest = c.effectiveDate;
  }
  return oldest;
}

/** Every ledger line of one ingredient with the average and on hand after each, for the owner only (design note 6). */
export async function movementHistory(q: Queryable, ingredientId: number): Promise<MovementHistory> {
  // Read-share lock first, as the stock check does: every stock writer locks this row (design note 4, rule 1), so none
  // can commit between the header and the lines. Without it, READ COMMITTED could show them from two moments.
  const locked = await q.query('SELECT id FROM ingredients WHERE id = $1 FOR SHARE', [ingredientId]);
  if (locked.rows.length === 0) throw notFound('Ingredient not found');
  const ingredient = await getIngredientWithCost(q, ingredientId);
  const rows = (
    await q.query(
      `SELECT id, kind, effective_date::text AS effective_date, quantity_milli, total_cost_cents, supplier, reference,
              expiry_date::text AS expiry_date, reason, entered_by_name, entered_at::text AS entered_at,
              reverses_movement_id, run_id, unit_cost_e4
       FROM stock_movements WHERE ingredient_id = $1`,
      [ingredientId],
    )
  ).rows;

  const ledger: LedgerLine[] = rows.map((r) => ({
    id: r.id as number,
    kind: r.kind as MovementKind,
    effectiveDate: r.effective_date as string,
    quantityMilli: toSafeInteger(r.quantity_milli),
    totalCostCents: r.total_cost_cents as number | null,
    reversesMovementId: r.reverses_movement_id as number | null,
  }));
  // The same replay the saved copy uses: one step function, so the figures here cannot differ from it.
  const after = new Map(replaySteps(ledger).map((s) => [s.line.id, s.after]));
  const reversedBy = new Map<number, number>();
  for (const l of ledger) if (l.reversesMovementId !== null) reversedBy.set(l.reversesMovementId, l.id);
  const byId = new Map(ledger.map((l) => [l.id, l]));
  const outOfDate = countsOutOfDate(ledger);

  const movements = rows.map((r): MovementView => {
    const id = r.id as number;
    const line = byId.get(id)!;
    const step = after.get(id);
    const costed = line.totalCostCents !== null;
    const cancelled = reversedBy.has(id) || line.reversesMovementId !== null;
    return {
      id,
      kind: line.kind,
      effectiveDate: line.effectiveDate,
      quantityMilli: line.quantityMilli,
      totalCostCents: line.totalCostCents,
      unitPriceE4: costed ? unitPriceE4(line.totalCostCents!, line.quantityMilli) : null,
      supplier: r.supplier as string,
      reference: r.reference as string,
      expiryDate: (r.expiry_date as string | null) ?? null,
      reason: r.reason as string,
      enteredByName: r.entered_by_name as string,
      enteredAt: r.entered_at as string,
      reversedById: reversedBy.get(id) ?? null,
      reversesMovementId: line.reversesMovementId,
      runId: (r.run_id as number | null) ?? null,
      unitCostE4: r.unit_cost_e4 === null ? null : toSafeInteger(r.unit_cost_e4),
      onHandAfterMilli: step ? step.onHandMilli : null,
      averageAfterE4: step ? step.avgE4 : null,
      needsRecount: cancelled ? null : needsRecountDate(line, outOfDate),
    };
  });
  movements.sort(compareLedgerOrder);
  return { ingredient, movements, reversibleMovementId: reversibleMovementId(ledger) };
}
