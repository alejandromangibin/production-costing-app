import type { z } from 'zod';
import { type BaseUnit, toSafeInteger } from '../calc/stock';
import type { Db, Queryable, Row } from '../db/index';
import { badRequest, conflict, notFound } from '../errors';
import type { ingredientCreate, ingredientUpdate } from '../schemas';
import type { Actor } from './runs';

/** What everyone in the business sees: quantities only (INV-14). */
export interface Ingredient {
  id: number;
  name: string;
  baseUnit: BaseUnit;
  /** Thousandths of the base unit. May be below zero (INV-06). */
  onHandMilli: number;
  lowStockMilli: number | null;
  active: boolean;
}

/** The owner also sees the average, in 1/10,000 centavo per base unit. Null until the first purchase. */
export interface IngredientWithCost extends Ingredient {
  avgCostE4: number | null;
}

const nullableInteger = (value: unknown) => (value === null ? null : toSafeInteger(value));

function toIngredient(r: Row): Ingredient {
  return {
    id: r.id as number,
    name: r.name as string,
    baseUnit: r.base_unit as BaseUnit,
    onHandMilli: toSafeInteger(r.on_hand_milli),
    lowStockMilli: nullableInteger(r.low_stock_milli),
    active: r.active as boolean,
  };
}

const toIngredientWithCost = (r: Row): IngredientWithCost => ({ ...toIngredient(r), avgCostE4: nullableInteger(r.avg_cost_e4) });

const COLUMNS = 'id, name, base_unit, on_hand_milli, low_stock_milli, active';
// Costs are left out of the query for staff, not removed afterwards, so they cannot leak through a new field.
const COST_COLUMNS = `${COLUMNS}, avg_cost_e4`;

export async function listIngredients(q: Queryable, includeInactive = false): Promise<Ingredient[]> {
  const r = await q.query(`SELECT ${COLUMNS} FROM ingredients ${includeInactive ? '' : 'WHERE active'} ORDER BY lower(name), id`);
  return r.rows.map(toIngredient);
}

export async function listIngredientsWithCost(q: Queryable, includeInactive = false): Promise<IngredientWithCost[]> {
  const r = await q.query(`SELECT ${COST_COLUMNS} FROM ingredients ${includeInactive ? '' : 'WHERE active'} ORDER BY lower(name), id`);
  return r.rows.map(toIngredientWithCost);
}

export async function getIngredient(q: Queryable, id: number): Promise<Ingredient> {
  const row = (await q.query(`SELECT ${COLUMNS} FROM ingredients WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound('Ingredient not found');
  return toIngredient(row);
}

export async function getIngredientWithCost(q: Queryable, id: number): Promise<IngredientWithCost> {
  const row = (await q.query(`SELECT ${COST_COLUMNS} FROM ingredients WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound('Ingredient not found');
  return toIngredientWithCost(row);
}

/** The name is unique per business, archived ingredients included, ignoring case. */
function nameTaken(err: any, name: string): unknown {
  if (err?.code === '23505' && err?.constraint === 'ingredients_tenant_name_key') {
    return badRequest(`There is already an ingredient called ${name}. It may be archived.`);
  }
  return err;
}

export async function createIngredient(db: Db, input: z.infer<typeof ingredientCreate>, actor: Actor): Promise<IngredientWithCost> {
  try {
    return await db.tx(async (q) => {
      const r = await q.query<{ id: number }>(
        `INSERT INTO ingredients (name, base_unit, created_by_user_id, created_by_name) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name, input.baseUnit, actor.id, actor.name],
      );
      return getIngredientWithCost(q, r.rows[0]!.id);
    });
  } catch (err) {
    throw nameTaken(err, input.name);
  }
}

/**
 * Rename, change the unit, archive or turn back on. An ingredient can be archived while it has stock (Q46).
 *
 * The row lock keeps the "no stock yet" check true until the change commits, but only because every stock
 * writer takes this same lock first (design note 4, rule 1). The foreign key from the ledger does not block
 * a writer that skips it: its FOR KEY SHARE does not conflict with FOR NO KEY UPDATE.
 */
export async function updateIngredient(db: Db, id: number, input: z.infer<typeof ingredientUpdate>): Promise<IngredientWithCost> {
  return db.tx(async (q) => {
    const found = (await q.query('SELECT base_unit FROM ingredients WHERE id = $1 FOR NO KEY UPDATE', [id])).rows[0];
    if (!found) throw notFound('Ingredient not found');
    const unitChanges = input.baseUnit !== undefined && input.baseUnit !== found.base_unit;
    if (unitChanges) {
      const moved = await q.query('SELECT 1 FROM stock_movements WHERE ingredient_id = $1 LIMIT 1', [id]);
      if (moved.rows.length) throw conflict('The unit cannot change once stock has been recorded for this ingredient.');
    }
    try {
      await q.query(
        `UPDATE ingredients SET
           name = COALESCE($2, name),
           base_unit = COALESCE($3, base_unit),
           active = COALESCE($4, active),
           low_stock_milli = CASE WHEN $5::boolean THEN NULL ELSE low_stock_milli END
         WHERE id = $1`,
        [id, input.name ?? null, input.baseUnit ?? null, input.active ?? null, unitChanges],
      );
    } catch (err) {
      throw nameTaken(err, input.name ?? '');
    }
    return getIngredientWithCost(q, id);
  });
}
