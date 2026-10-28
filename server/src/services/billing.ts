import { config } from '../config';
import { daysBetween } from '../dates';
import type { Db } from '../db/index';
import { camel } from '../db/rows';
import { badRequest, notFound } from '../errors';

export type AccessLevel = 'full' | 'read_only' | 'blocked';

export interface Access {
  level: AccessLevel;
  /** Shown to the business when something needs their attention. Null when all is well. */
  message: string | null;
  /** Days until the trial ends or the subscription is due (negative if overdue). Null if not applicable. */
  daysLeft: number | null;
}

export interface TenantRow {
  id: number;
  name: string;
  status: 'trial' | 'active' | 'cancelled' | 'suspended';
  trialEndsOn: string;
  paidThrough: string | null;
  notes: string;
  createdAt: string;
}

/**
 * What a business may do today.
 *   full       everything
 *   read_only  can look, search and download, but cannot add or change anything
 *   blocked    cannot use the app (suspended by you)
 *
 * A paid business keeps full access for a few days after the paid-through date (grace period).
 */
export function accessFor(
  t: Pick<TenantRow, 'status' | 'trialEndsOn' | 'paidThrough'>,
  today: string,
  graceDays: number = config.graceDays,
): Access {
  switch (t.status) {
    case 'suspended':
      return { level: 'blocked', message: 'This account is suspended. Please contact support.', daysLeft: null };
    case 'cancelled':
      return {
        level: 'read_only',
        message: 'Your subscription is cancelled. You can view and download your data, but not add or change anything.',
        daysLeft: null,
      };
    case 'trial': {
      const daysLeft = daysBetween(today, t.trialEndsOn);
      if (daysLeft < 0) {
        return {
          level: 'read_only',
          message: 'Your free trial has ended. You can view and download your data. Contact us to subscribe and keep adding runs.',
          daysLeft,
        };
      }
      return {
        level: 'full',
        message: daysLeft <= 7 ? `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.` : null,
        daysLeft,
      };
    }
    case 'active': {
      if (!t.paidThrough) {
        return { level: 'read_only', message: 'No payment is recorded yet. Please contact us.', daysLeft: null };
      }
      const daysLeft = daysBetween(today, t.paidThrough);
      if (daysLeft >= 0) {
        return {
          level: 'full',
          message: daysLeft <= 7 ? `Your subscription is due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.` : null,
          daysLeft,
        };
      }
      if (-daysLeft <= graceDays) {
        return {
          level: 'full',
          message: `Your payment is overdue. Please pay within ${graceDays + daysLeft} day${graceDays + daysLeft === 1 ? '' : 's'} to avoid losing the ability to add runs.`,
          daysLeft,
        };
      }
      return {
        level: 'read_only',
        message: 'Your subscription has lapsed. You can view and download your data. Contact us to renew.',
        daysLeft,
      };
    }
  }
}

/** Add whole months to YYYY-MM-DD. A day that does not exist in the new month becomes its last day. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ny}-${pad(nm)}-${pad(Math.min(d, lastDay))}`;
}

export interface PaymentInput {
  amountCents: number;
  method: string;
  reference: string;
  paidOn: string;
  months: number;
  note: string;
}

export const TENANT_COLUMNS = `id, name, status, trial_ends_on::text AS trial_ends_on, paid_through::text AS paid_through, notes, created_at::text AS created_at`;

export async function getTenant(db: Db, id: number): Promise<TenantRow> {
  const row = (await db.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [id])).rows[0];
  if (!row) throw notFound('Business not found');
  return camel<TenantRow>(row);
}

/**
 * Record a payment and extend the subscription. If the business is still paid up, the new months
 * are added after the current paid-through date; otherwise they start from the payment date.
 * A suspended business stays suspended until you change that yourself.
 */
export async function recordPayment(db: Db, tenantId: number, input: PaymentInput, recordedBy: number): Promise<TenantRow> {
  await db.tx(async (q) => {
    const row = (await q.query('SELECT status, paid_through::text AS paid_through FROM tenants WHERE id = $1 FOR UPDATE', [tenantId])).rows[0];
    if (!row) throw notFound('Business not found');
    const from = row.paid_through && row.paid_through > input.paidOn ? row.paid_through : input.paidOn;
    const paidThrough = addMonths(from, input.months);
    await q.query(
      `INSERT INTO payments (tenant_id, amount_cents, method, reference, paid_on, months, note, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, input.amountCents, input.method, input.reference, input.paidOn, input.months, input.note, recordedBy],
    );
    await q.query(
      `UPDATE tenants SET paid_through = $2, status = CASE WHEN status = 'suspended' THEN status ELSE 'active' END WHERE id = $1`,
      [tenantId, paidThrough],
    );
  });
  return getTenant(db, tenantId);
}

export async function listPayments(db: Db, tenantId: number) {
  const rows = (
    await db.query(
      `SELECT id, amount_cents, method, reference, paid_on::text AS paid_on, months, note, created_at::text AS created_at
       FROM payments WHERE tenant_id = $1 ORDER BY paid_on DESC, id DESC`,
      [tenantId],
    )
  ).rows;
  return rows.map((r) => camel(r));
}

export async function updateTenant(
  db: Db,
  id: number,
  patch: { name?: string; status?: TenantRow['status']; trialEndsOn?: string; notes?: string },
): Promise<TenantRow> {
  await getTenant(db, id);
  if (patch.status === 'active') {
    const t = await getTenant(db, id);
    if (!t.paidThrough) throw badRequest('Record a payment first: a business becomes active when it pays.');
  }
  await db.query(
    `UPDATE tenants SET name = COALESCE($2, name), status = COALESCE($3, status),
       trial_ends_on = COALESCE($4::date, trial_ends_on), notes = COALESCE($5, notes) WHERE id = $1`,
    [id, patch.name ?? null, patch.status ?? null, patch.trialEndsOn ?? null, patch.notes ?? null],
  );
  return getTenant(db, id);
}
