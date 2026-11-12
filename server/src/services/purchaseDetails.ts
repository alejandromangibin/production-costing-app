import type { z } from 'zod';
import type { Db } from '../db/index';
import { badRequest, conflict, notFound } from '../errors';
import type { purchaseDetailsBody } from '../schemas';
import type { Actor } from './runs';
import { type MovementView, movementHistory } from './stockHistory';
import { lockIngredients } from './stockLedger';

/**
 * The owner corrects a purchase's supplier, reference or expiry date (INV-17). Nothing else about the line can change:
 * quantity, price and the stock maths are not touched, so on hand and the average stay exactly as they were.
 *
 * One transaction (design note 1.5): lock the ingredient, read the line, refuse what cannot be corrected, keep the values
 * from before in purchase_detail_changes with who and when, then update the three columns.
 */
export async function correctPurchaseDetails(
  db: Db,
  ingredientId: number,
  movementId: number,
  input: z.infer<typeof purchaseDetailsBody>,
  actor: Actor,
): Promise<MovementView> {
  const changedBy = actor.name.trim();
  if (!changedBy) throw new Error('A correction needs the name of the person making it.');
  const { supplier, reference } = input;
  const expiryDate = input.expiryDate ?? null;

  return db.tx(async (q) => {
    await lockIngredients(q, [ingredientId]);
    const current = (
      await q.query<{ kind: string; supplier: string; reference: string; expiry_date: string | null }>(
        'SELECT kind, supplier, reference, expiry_date::text AS expiry_date FROM stock_movements WHERE id = $1 AND ingredient_id = $2',
        [movementId, ingredientId],
      )
    ).rows[0];
    if (!current) throw notFound('Stock entry not found');
    if (current.kind !== 'purchase') throw badRequest('Only the details of a purchase can be corrected.');
    // The same rule the reversal uses (checkReversible): a line is reversed when another line of the ingredient points at it.
    const reversal = await q.query('SELECT 1 FROM stock_movements WHERE ingredient_id = $1 AND reverses_movement_id = $2 LIMIT 1', [ingredientId, movementId]);
    if (reversal.rows.length > 0) throw conflict('This purchase has been reversed, so its details can no longer be corrected.');
    if (current.supplier === supplier && current.reference === reference && current.expiry_date === expiryDate) {
      throw badRequest('Nothing to change: these details are the same as the ones already saved.');
    }

    await q.query(
      `INSERT INTO purchase_detail_changes (movement_id, supplier, reference, expiry_date, changed_by_user_id, changed_by_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [movementId, current.supplier, current.reference, current.expiry_date, actor.id, changedBy],
    );
    const updated = await q.query(
      "UPDATE stock_movements SET supplier = $2, reference = $3, expiry_date = $4 WHERE id = $1 AND ingredient_id = $5 AND kind = 'purchase' RETURNING id",
      [movementId, supplier, reference, expiryDate, ingredientId],
    );
    // Not reachable today (the line was just read under the lock). If it ever happens, this error rolls the transaction
    // back, so an audit row is never committed without its change.
    if (updated.rows.length !== 1) throw new Error('The purchase details were not updated.');

    const view = (await movementHistory(q, ingredientId)).movements.find((m) => m.id === movementId);
    if (!view) throw new Error('The corrected line was not found.');
    return view;
  });
}
