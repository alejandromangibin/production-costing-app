import type { z } from 'zod';
import type { Db, Queryable } from '../db/index';
import { camel } from '../db/rows';
import { badRequest, notFound } from '../errors';
import type { packSizeCreate, packSizeUpdate, productCreate, productUpdate } from '../schemas';
import type { Actor } from './runs';

export interface PackSize {
  id: number;
  productId: number;
  piecesPerPack: number;
  retailPriceCents: number;
  resellerPriceCents: number | null;
  packagingCostCents: number;
  isDefault: boolean;
  active: boolean;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  shelfLifeDays: number;
  notes: string;
  active: boolean;
  packSizes: PackSize[];
}

export async function listProducts(q: Queryable, includeInactive = false): Promise<Product[]> {
  const products = (
    await q.query(
      `SELECT id, code, name, shelf_life_days, notes, active FROM products
       ${includeInactive ? '' : 'WHERE active'} ORDER BY name, id`,
    )
  ).rows.map((r) => camel<Omit<Product, 'packSizes'>>(r));
  const sizes = (
    await q.query(
      `SELECT id, product_id, pieces_per_pack, retail_price_cents, reseller_price_cents,
              packaging_cost_cents, is_default, active
       FROM pack_sizes ${includeInactive ? '' : 'WHERE active'} ORDER BY pieces_per_pack`,
    )
  ).rows.map((r) => camel<PackSize>(r));
  return products.map((p) => ({ ...p, packSizes: sizes.filter((s) => s.productId === p.id) }));
}

export async function getProduct(q: Queryable, id: number): Promise<Product> {
  const all = await listProducts(q, true);
  const found = all.find((p) => p.id === id);
  if (!found) throw notFound('Product not found');
  return found;
}

// ---- Price history: one row per pack size whose prices or settings changed, with who and when ----

const TRACKED = ['retail_price_cents', 'reseller_price_cents', 'packaging_cost_cents', 'is_default', 'active'] as const;
type PackSizeState = Record<(typeof TRACKED)[number], unknown>;

/**
 * The product's pack sizes as they are now. With `lock`, the rows stay locked until the transaction
 * ends, so two people saving the same product wait for each other: otherwise one save could see the
 * other's change between its "before" and "after" and record it under the wrong name.
 */
async function packSizeStates(q: Queryable, productId: number, lock = false): Promise<Map<number, PackSizeState>> {
  // The product row is locked too, so this also holds for a product that has no pack sizes yet.
  if (lock) await q.query('SELECT id FROM products WHERE id = $1 FOR NO KEY UPDATE', [productId]);
  const rows = (
    await q.query(
      `SELECT id, ${TRACKED.join(', ')} FROM pack_sizes WHERE product_id = $1 ORDER BY id${lock ? ' FOR NO KEY UPDATE' : ''}`,
      [productId],
    )
  ).rows;
  return new Map(rows.map(({ id, ...state }) => [id as number, state as PackSizeState]));
}

/** Compare the product's pack sizes now with `before` and record every one that is new or changed. */
async function recordPackSizeChanges(q: Queryable, productId: number, before: Map<number, PackSizeState>, actor: Actor) {
  for (const [id, now] of await packSizeStates(q, productId)) {
    const was = before.get(id);
    if (was && TRACKED.every((field) => was[field] === now[field])) continue;
    await q.query(
      `INSERT INTO pack_size_changes (pack_size_id, kind, retail_price_cents, reseller_price_cents, packaging_cost_cents,
                                      is_default, active, changed_by_user_id, changed_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, was ? 'updated' : 'created', now.retail_price_cents, now.reseller_price_cents, now.packaging_cost_cents,
       now.is_default, now.active, actor.id, actor.name],
    );
  }
}

export interface PackSizeChange {
  id: number;
  packSizeId: number;
  piecesPerPack: number;
  kind: 'created' | 'updated';
  retailPriceCents: number;
  resellerPriceCents: number | null;
  packagingCostCents: number;
  isDefault: boolean;
  active: boolean;
  changedByName: string;
  changedAt: string;
}

/** A product's price history, newest first. */
export async function listPackSizeChanges(q: Queryable, productId: number): Promise<PackSizeChange[]> {
  await getProduct(q, productId);
  const rows = (
    await q.query(
      `SELECT c.id, c.pack_size_id, s.pieces_per_pack, c.kind, c.retail_price_cents, c.reseller_price_cents,
              c.packaging_cost_cents, c.is_default, c.active, c.changed_by_name, c.changed_at::text AS changed_at
       FROM pack_size_changes c JOIN pack_sizes s ON s.id = c.pack_size_id
       WHERE s.product_id = $1 ORDER BY c.changed_at DESC, c.id DESC LIMIT 200`,
      [productId],
    )
  ).rows;
  return rows.map((r) => camel<PackSizeChange>(r));
}

async function insertPackSize(q: Queryable, productId: number, s: z.infer<typeof packSizeCreate>): Promise<number> {
  if (s.isDefault) {
    await q.query('UPDATE pack_sizes SET is_default = false WHERE product_id = $1', [productId]);
  }
  const existing = await q.query('SELECT 1 FROM pack_sizes WHERE product_id = $1 AND active', [productId]);
  // The first active pack size becomes the default automatically.
  const makeDefault = s.isDefault || existing.rows.length === 0;
  try {
    const r = await q.query<{ id: number }>(
      `INSERT INTO pack_sizes (product_id, pieces_per_pack, retail_price_cents, reseller_price_cents,
                               packaging_cost_cents, is_default)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [productId, s.piecesPerPack, s.retailPriceCents, s.resellerPriceCents ?? null, s.packagingCostCents, makeDefault],
    );
    return r.rows[0]!.id;
  } catch (err: any) {
    if (err?.code === '23505') throw badRequest(`This product already has a ${s.piecesPerPack}-piece pack size.`);
    throw err;
  }
}

export async function createProduct(db: Db, input: z.infer<typeof productCreate>, actor: Actor): Promise<Product> {
  const sizes = new Set<number>();
  for (const s of input.packSizes) {
    if (sizes.has(s.piecesPerPack)) throw badRequest(`The ${s.piecesPerPack}-piece pack size is listed twice.`);
    sizes.add(s.piecesPerPack);
  }
  const id = await db.tx(async (q) => {
    let productId: number;
    try {
      const r = await q.query<{ id: number }>(
        'INSERT INTO products (code, name, shelf_life_days, notes) VALUES ($1, $2, $3, $4) RETURNING id',
        [input.code, input.name, input.shelfLifeDays, input.notes],
      );
      productId = r.rows[0]!.id;
    } catch (err: any) {
      if (err?.code === '23505') throw badRequest(`The code ${input.code} is already used by another product.`);
      throw err;
    }
    for (const s of input.packSizes) await insertPackSize(q, productId, s);
    await recordPackSizeChanges(q, productId, new Map(), actor);
    return productId;
  });
  return getProduct(db, id);
}

export async function updateProduct(db: Db, id: number, input: z.infer<typeof productUpdate>): Promise<Product> {
  await getProduct(db, id);
  await db.query(
    `UPDATE products SET
       name = COALESCE($2, name),
       shelf_life_days = COALESCE($3, shelf_life_days),
       notes = COALESCE($4, notes),
       active = COALESCE($5, active)
     WHERE id = $1`,
    [id, input.name ?? null, input.shelfLifeDays ?? null, input.notes ?? null, input.active ?? null],
  );
  return getProduct(db, id);
}

export async function addPackSize(db: Db, productId: number, input: z.infer<typeof packSizeCreate>, actor: Actor): Promise<Product> {
  await getProduct(db, productId);
  await db.tx(async (q) => {
    const before = await packSizeStates(q, productId, true);
    await insertPackSize(q, productId, input);
    // Also records another size that lost its default to the new one.
    await recordPackSizeChanges(q, productId, before, actor);
  });
  return getProduct(db, productId);
}

export async function updatePackSize(db: Db, id: number, input: z.infer<typeof packSizeUpdate>, actor: Actor): Promise<Product> {
  const found = (await db.query('SELECT product_id FROM pack_sizes WHERE id = $1', [id])).rows[0];
  if (!found) throw notFound('Pack size not found');
  const productId = found.product_id as number;
  await db.tx(async (q) => {
    const before = await packSizeStates(q, productId, true);
    if (input.isDefault) {
      await q.query('UPDATE pack_sizes SET is_default = false WHERE product_id = $1', [productId]);
    }
    await q.query(
      `UPDATE pack_sizes SET
         retail_price_cents = COALESCE($2, retail_price_cents),
         packaging_cost_cents = COALESCE($3, packaging_cost_cents),
         is_default = COALESCE($4, is_default),
         active = COALESCE($5, active)
       WHERE id = $1`,
      [id, input.retailPriceCents ?? null, input.packagingCostCents ?? null, input.isDefault ?? null, input.active ?? null],
    );
    // The reseller price can be cleared, so null must be distinguishable from "not sent".
    if (input.resellerPriceCents !== undefined) {
      await q.query('UPDATE pack_sizes SET reseller_price_cents = $2 WHERE id = $1', [id, input.resellerPriceCents]);
    }
    // An archived pack size cannot stay the default.
    await q.query('UPDATE pack_sizes SET is_default = false WHERE id = $1 AND NOT active', [id]);
    // If that left the product without a default, the smallest active pack size takes over.
    await q.query(
      `UPDATE pack_sizes SET is_default = true WHERE id = (
         SELECT id FROM pack_sizes WHERE product_id = $1 AND active ORDER BY pieces_per_pack LIMIT 1
       ) AND NOT EXISTS (SELECT 1 FROM pack_sizes WHERE product_id = $1 AND active AND is_default)`,
      [productId],
    );
    // Records this size and any other size whose default flag moved.
    await recordPackSizeChanges(q, productId, before, actor);
  });
  return getProduct(db, productId);
}
