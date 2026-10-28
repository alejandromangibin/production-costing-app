import { daysBetween } from '../dates';
import type { Queryable } from '../db/index';
import { camel } from '../db/rows';

/** How many batches the expiry board shows: those not yet expired, and those already expired. */
export const EXPIRY_LIMITS = { current: 500, expired: 100 };

/**
 * Batches from saved runs, soonest expiry first, with days remaining counted from `today`.
 *
 * Batches not yet expired and batches already expired are fetched separately, so years of old
 * expired batches can never push current ones off the board. Of the expired ones, the most
 * recently expired are kept. `moreCurrent` / `moreExpired` say whether a limit cut the list short.
 */
export async function expiryBoard(q: Queryable, today: string, limits = EXPIRY_LIMITS) {
  const select = `SELECT p.id AS run_product_id, p.run_id, p.batch_code, p.product_id, p.product_name,
              p.production_date::text AS production_date, p.expiry_date::text AS expiry_date,
              p.good_pieces, r.run_date::text AS run_date
       FROM run_products p JOIN runs r ON r.id = p.run_id
       WHERE r.status = 'saved'`;
  // One extra row each, to tell whether there are more.
  const current = (
    await q.query(`${select} AND p.expiry_date >= $1::date ORDER BY p.expiry_date ASC, p.id ASC LIMIT $2`, [today, limits.current + 1])
  ).rows;
  const expired = (
    await q.query(`${select} AND p.expiry_date < $1::date ORDER BY p.expiry_date DESC, p.id DESC LIMIT $2`, [today, limits.expired + 1])
  ).rows;
  const rows = [...expired.slice(0, limits.expired).reverse(), ...current.slice(0, limits.current)];
  return {
    batches: rows.map((r) => ({ ...camel<any>(r), daysRemaining: daysBetween(today, r.expiry_date) })),
    moreCurrent: current.length > limits.current,
    moreExpired: expired.length > limits.expired,
  };
}

/**
 * For every product and pack size: the cost from the most recent saved run, and the margin that cost
 * gives at the price set today. Voided runs are ignored.
 */
export async function marginsView(q: Queryable) {
  const rows = (
    await q.query(
      `SELECT DISTINCT ON (p.product_id, k.pieces_per_pack)
              p.product_id, p.product_name, p.product_code, k.pieces_per_pack,
              r.id AS run_id, r.run_date::text AS run_date, p.batch_code,
              k.pack_cost_cents, k.retail_price_cents AS run_retail_price_cents,
              k.margin_pct AS run_margin_pct, k.markup_pct AS run_markup_pct,
              s.retail_price_cents AS current_retail_price_cents, COALESCE(s.active, false) AS pack_active
       FROM run_packings k
       JOIN run_products p ON p.id = k.run_product_id
       JOIN runs r ON r.id = p.run_id
       LEFT JOIN pack_sizes s ON s.id = k.pack_size_id
       WHERE r.status = 'saved'
       ORDER BY p.product_id, k.pieces_per_pack, r.run_date DESC, r.id DESC`,
    )
  ).rows;
  return rows
    .map((r) => {
      const cost = r.pack_cost_cents as number;
      const price = r.current_retail_price_cents as number | null;
      const profit = price === null ? null : price - cost;
      return {
        ...camel<any>(r),
        currentMarginPct: price === null || price === 0 ? null : (profit! / price) * 100,
        currentMarkupPct: price === null || cost === 0 ? null : (profit! / cost) * 100,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.piecesPerPack - b.piecesPerPack);
}
