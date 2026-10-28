import type { z } from 'zod';
import type { Db, Queryable } from '../db/index';
import { camel } from '../db/rows';
import { badRequest, notFound } from '../errors';
import type { packSizeCreate, packSizeUpdate, productCreate, productUpdate } from '../schemas';

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

export async function createProduct(db: Db, input: z.infer<typeof productCreate>): Promise<Product> {
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

export async function addPackSize(db: Db, productId: number, input: z.infer<typeof packSizeCreate>): Promise<Product> {
  await getProduct(db, productId);
  await db.tx((q) => insertPackSize(q, productId, input));
  return getProduct(db, productId);
}

export async function updatePackSize(db: Db, id: number, input: z.infer<typeof packSizeUpdate>): Promise<Product> {
  const found = (await db.query('SELECT product_id FROM pack_sizes WHERE id = $1', [id])).rows[0];
  if (!found) throw notFound('Pack size not found');
  const productId = found.product_id as number;
  await db.tx(async (q) => {
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
  });
  return getProduct(db, productId);
}
