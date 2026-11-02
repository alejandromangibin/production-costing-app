import type { z } from 'zod';
import { calculateRun } from '../calc/engine';
import type { RunInput, RunResult } from '../calc/types';
import { addDays } from '../dates';
import type { Db, Queryable } from '../db/index';
import { camel } from '../db/rows';
import { badRequest, conflict, notFound } from '../errors';
import type { RunBody, runsQuery } from '../schemas';

interface ProductRow {
  id: number;
  code: string;
  name: string;
  shelfLifeDays: number;
  active: boolean;
}
interface PackSizeRow {
  id: number;
  productId: number;
  piecesPerPack: number;
  retailPriceCents: number;
  packagingCostCents: number;
  active: boolean;
}

export interface PreparedProduct {
  productId: number;
  code: string;
  name: string;
  productionDate: string;
  expiryDate: string;
}

export interface PreparedRun {
  input: RunInput;
  products: PreparedProduct[];
}

/** Check the entered run against the catalog and turn it into numbers for the calculation engine. */
async function prepare(q: Queryable, body: RunBody): Promise<PreparedRun> {
  const ids = body.products.map((p) => p.productId);
  const products = (
    await q.query('SELECT id, code, name, shelf_life_days, active FROM products WHERE id = ANY($1::int[])', [ids])
  ).rows.map((r) => camel<ProductRow>(r));
  const sizes = (
    await q.query(
      `SELECT id, product_id, pieces_per_pack, retail_price_cents, packaging_cost_cents, active
       FROM pack_sizes WHERE product_id = ANY($1::int[])`,
      [ids],
    )
  ).rows.map((r) => camel<PackSizeRow>(r));

  const prepared: PreparedProduct[] = [];
  const input: RunInput = { products: [], costs: [] };

  for (const p of body.products) {
    const product = products.find((x) => x.id === p.productId);
    if (!product) throw badRequest('A product in this run no longer exists.');
    if (!product.active) throw badRequest(`${product.name} is archived. Turn it back on in Products first.`);

    const productionDate = p.productionDate ?? body.runDate;
    const expiryDate = p.expiryDate ?? addDays(productionDate, product.shelfLifeDays);
    if (expiryDate < productionDate) {
      throw badRequest(`${product.name}: the expiry date cannot be earlier than the production date.`);
    }
    prepared.push({ productId: product.id, code: product.code, name: product.name, productionDate, expiryDate });

    input.products.push({
      productId: product.id,
      loosePieces: p.loosePieces,
      rejectedPieces: p.rejectedPieces,
      packings: p.packings.map((k) => {
        const size = sizes.find((s) => s.id === k.packSizeId && s.productId === product.id);
        if (!size) throw badRequest(`${product.name}: a pack size in this run does not belong to it.`);
        if (!size.active && k.packs > 0) {
          throw badRequest(`${product.name}: the ${size.piecesPerPack}-piece pack size is archived.`);
        }
        return {
          packSizeId: size.id,
          piecesPerPack: size.piecesPerPack,
          retailPriceCents: size.retailPriceCents,
          packagingCostCents: size.packagingCostCents,
          packs: k.packs,
        };
      }),
    });
  }

  input.costs = body.costs.map((c) => ({ ...c, targetProductIds: c.scope === 'shared' ? [] : c.targetProductIds }));
  return { input, products: prepared };
}

export interface RunPreview {
  result: RunResult;
  products: (PreparedProduct & { batchCode: string })[];
}

/** Next free batch code like 20261019-PORK, or 20261019-PORK-2 if that one exists. */
async function nextBatchCode(q: Queryable, productionDate: string, code: string, taken: Set<string>): Promise<string> {
  const base = `${productionDate.replaceAll('-', '')}-${code}`;
  const rows = (
    await q.query<{ batch_code: string }>('SELECT batch_code FROM run_products WHERE batch_code = $1 OR batch_code LIKE $2', [
      base,
      `${base}-%`,
    ])
  ).rows;
  const used = new Set([...rows.map((r) => r.batch_code), ...taken]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export async function previewRun(db: Queryable, body: RunBody): Promise<RunPreview> {
  const prepared = await prepare(db, body);
  const result = calculateRun(prepared.input);
  const taken = new Set<string>();
  const products = [];
  for (const p of prepared.products) {
    const batchCode = await nextBatchCode(db, p.productionDate, p.code, taken);
    taken.add(batchCode);
    products.push({ ...p, batchCode });
  }
  return { result, products };
}

/** The person doing something, as saved on the record (decision D-25). */
export interface Actor {
  id: number;
  name: string;
}

export async function saveRun(db: Db, body: RunBody, actor: Actor): Promise<number> {
  return db.tx(async (q) => {
    const prepared = await prepare(q, body);
    const result = calculateRun(prepared.input);

    const run = await q.query<{ id: number }>(
      'INSERT INTO runs (run_date, note, total_cost_cents, created_by_user_id, created_by_name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [body.runDate, body.note, result.totalCostCents, actor.id, actor.name],
    );
    const runId = run.rows[0]!.id;

    const runProductIds = new Map<number, number>();
    const taken = new Set<string>();
    for (let i = 0; i < prepared.products.length; i++) {
      const meta = prepared.products[i]!;
      const r = result.products[i]!;
      const batchCode = await nextBatchCode(q, meta.productionDate, meta.code, taken);
      taken.add(batchCode);
      const rp = await q.query<{ id: number }>(
        `INSERT INTO run_products
           (run_id, product_id, product_code, product_name, loose_pieces, rejected_pieces, packed_pieces,
            pieces_made, good_pieces, shared_share_cents, specific_cents, packaging_cents, total_cost_cents,
            cost_per_good_piece, batch_code, production_date, expiry_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          runId, meta.productId, meta.code, meta.name, r.loosePieces, r.rejectedPieces, r.packedPieces,
          r.piecesMade, r.goodPieces, r.sharedShareCents, r.specificCents, r.packagingCents, r.totalCostCents,
          r.costPerGoodPiece, batchCode, meta.productionDate, meta.expiryDate,
        ],
      );
      runProductIds.set(meta.productId, rp.rows[0]!.id);
      for (const k of r.packings) {
        await q.query(
          `INSERT INTO run_packings
             (run_product_id, pack_size_id, pieces_per_pack, retail_price_cents, packaging_cost_cents,
              packs, pack_cost_cents, margin_pct, markup_pct)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [rp.rows[0]!.id, k.packSizeId, k.piecesPerPack, k.retailPriceCents, k.packagingCostCents, k.packs,
           k.packCostCents, k.marginPct, k.markupPct],
        );
      }
    }

    for (const c of prepared.input.costs) {
      const cost = await q.query<{ id: number }>(
        'INSERT INTO run_costs (run_id, category, description, amount_cents, scope) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [runId, c.category, c.description, c.amountCents, c.scope],
      );
      if (c.scope === 'specific') {
        for (const productId of new Set(c.targetProductIds)) {
          await q.query('INSERT INTO run_cost_targets (run_cost_id, run_product_id) VALUES ($1, $2)', [
            cost.rows[0]!.id,
            runProductIds.get(productId),
          ]);
        }
      }
    }
    return runId;
  });
}

export async function getRun(q: Queryable, id: number) {
  const run = (
    await q.query(
      `SELECT id, run_date::text AS run_date, note, status, void_reason, voided_at::text AS voided_at,
              total_cost_cents, created_at::text AS created_at, created_by_name, voided_by_name
       FROM runs WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!run) throw notFound('Run not found');

  const products = (
    await q.query(
      `SELECT id, product_id, product_code, product_name, loose_pieces, rejected_pieces, packed_pieces,
              pieces_made, good_pieces, shared_share_cents, specific_cents, packaging_cents, total_cost_cents,
              cost_per_good_piece, batch_code, production_date::text AS production_date, expiry_date::text AS expiry_date
       FROM run_products WHERE run_id = $1 ORDER BY id`,
      [id],
    )
  ).rows.map((r) => camel(r));
  const packings = (
    await q.query(
      `SELECT k.id, k.run_product_id, k.pack_size_id, k.pieces_per_pack, k.retail_price_cents,
              k.packaging_cost_cents, k.packs, k.pack_cost_cents, k.margin_pct, k.markup_pct
       FROM run_packings k JOIN run_products p ON p.id = k.run_product_id
       WHERE p.run_id = $1 ORDER BY k.pieces_per_pack`,
      [id],
    )
  ).rows.map((r) => camel(r));
  const costs = (
    await q.query('SELECT id, category, description, amount_cents, scope FROM run_costs WHERE run_id = $1 ORDER BY id', [id])
  ).rows.map((r) => camel(r));
  const targets = (
    await q.query(
      `SELECT t.run_cost_id, t.run_product_id FROM run_cost_targets t
       JOIN run_costs c ON c.id = t.run_cost_id WHERE c.run_id = $1`,
      [id],
    )
  ).rows.map((r) => camel<{ runCostId: number; runProductId: number }>(r));

  return {
    ...camel(run),
    products: products.map((p: any) => ({ ...p, packings: packings.filter((k: any) => k.runProductId === p.id) })),
    costs: costs.map((c: any) => ({
      ...c,
      targetRunProductIds: targets.filter((t) => t.runCostId === c.id).map((t) => t.runProductId),
    })),
  };
}

function filters(f: z.infer<typeof runsQuery>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.from) add('r.run_date >= ?::date', f.from);
  if (f.to) add('r.run_date <= ?::date', f.to);
  if (f.status) add('r.status = ?', f.status);
  if (f.productId) add('EXISTS (SELECT 1 FROM run_products x WHERE x.run_id = r.id AND x.product_id = ?::int)', f.productId);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like);
    const n = `$${params.length}`;
    where.push(
      `(r.note ILIKE ${n} OR EXISTS (SELECT 1 FROM run_products x WHERE x.run_id = r.id
         AND (x.batch_code ILIKE ${n} OR x.product_name ILIKE ${n})))`,
    );
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listRuns(q: Queryable, f: z.infer<typeof runsQuery>) {
  const { sql, params } = filters(f);
  const rows = (
    await q.query(
      `SELECT r.id, r.run_date::text AS run_date, r.note, r.status, r.total_cost_cents,
              COALESCE((SELECT string_agg(x.product_name, ', ' ORDER BY x.id) FROM run_products x WHERE x.run_id = r.id), '') AS product_names,
              (SELECT COALESCE(SUM(x.good_pieces), 0)::int FROM run_products x WHERE x.run_id = r.id) AS good_pieces
       FROM runs r ${sql} ORDER BY r.run_date DESC, r.id DESC LIMIT 500`,
      params,
    )
  ).rows;
  return rows.map((r) => camel(r));
}

export async function voidRun(db: Db, id: number, reason: string, actor: Actor) {
  // One statement, so two clicks at once cannot both void the run (or overwrite who voided it).
  const voided = (
    await db.query(
      `UPDATE runs SET status = 'void', void_reason = $2, voided_at = now(), voided_by_user_id = $3, voided_by_name = $4
       WHERE id = $1 AND status = 'saved' RETURNING id`,
      [id, reason, actor.id, actor.name],
    )
  ).rows[0];
  if (!voided) {
    const run = (await db.query('SELECT status FROM runs WHERE id = $1', [id])).rows[0];
    if (!run) throw notFound('Run not found');
    throw conflict('This run is already voided.');
  }
  return getRun(db, id);
}

function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Stop spreadsheet programs from running text that starts like a formula.
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const pesos = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));

/** One row per pack size made. Batches with no packs get one row with the pack columns empty. */
export async function runsCsv(q: Queryable, f: z.infer<typeof runsQuery>): Promise<string> {
  const { sql, params } = filters(f);
  const rows = (
    await q.query(
      `SELECT r.id AS run_id, r.run_date::text AS run_date, r.status, r.note,
              p.product_name, p.batch_code, p.production_date::text AS production_date, p.expiry_date::text AS expiry_date,
              p.pieces_made, p.good_pieces, p.rejected_pieces, p.loose_pieces, p.total_cost_cents,
              k.pieces_per_pack, k.packs, k.retail_price_cents, k.pack_cost_cents, k.margin_pct, k.markup_pct
       FROM runs r
       JOIN run_products p ON p.run_id = r.id
       LEFT JOIN run_packings k ON k.run_product_id = p.id
       ${sql}
       ORDER BY r.run_date DESC, r.id DESC, p.id, k.pieces_per_pack`,
      params,
    )
  ).rows;
  const header = [
    'Run', 'Run date', 'Status', 'Note', 'Product', 'Batch code', 'Production date', 'Expiry date',
    'Pieces made', 'Good pieces', 'Rejected', 'Loose', 'Product cost (PHP)',
    'Pieces per pack', 'Packs', 'Retail price (PHP)', 'Cost per pack (PHP)', 'Margin %', 'Markup %',
  ];
  const lines = rows.map((r) =>
    [
      r.run_id, r.run_date, r.status, r.note, r.product_name, r.batch_code, r.production_date, r.expiry_date,
      r.pieces_made, r.good_pieces, r.rejected_pieces, r.loose_pieces, pesos(r.total_cost_cents),
      r.pieces_per_pack, r.packs, pesos(r.retail_price_cents), pesos(r.pack_cost_cents),
      r.margin_pct === null ? '' : Number(r.margin_pct).toFixed(1),
      r.markup_pct === null ? '' : Number(r.markup_pct).toFixed(1),
    ]
      .map(csvCell)
      .join(','),
  );
  // The leading mark lets Excel open the file with the right characters.
  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
