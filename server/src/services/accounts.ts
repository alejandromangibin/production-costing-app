import { config } from '../config';
import { addDays, localToday } from '../dates';
import type { Db, Queryable } from '../db/index';
import { camel } from '../db/rows';
import { badRequest, conflict, HttpError, notFound } from '../errors';
import { checkNewPassword, hashPassword, hashToken, newToken, verifyPassword } from '../auth/password';
import { type TenantRow, TENANT_COLUMNS, accessFor } from './billing';

export type Role = 'owner' | 'staff' | 'platform_admin';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  tenantId: number | null;
}

const USER_COLUMNS = 'id, tenant_id, email, name, role';

const LOGIN_FAILED = 'Wrong email or password.';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(db: Db, userId: number): Promise<{ token: string; expires: Date }> {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  await db.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), userId, expires.toISOString()]);
  // Tidy up old sessions now and then.
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, expires };
}

export interface Session {
  user: SessionUser;
  tenant: TenantRow | null;
}

/** Find who a login cookie belongs to. Null if unknown, expired, or the person was switched off. */
export async function findSession(db: Db, token: string): Promise<Session | null> {
  const id = hashToken(token);
  const row = (
    await db.query(
      `SELECT u.id, u.tenant_id, u.email, u.name, u.role, s.last_seen_at < now() - interval '1 minute' AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > now() AND u.active`,
      [id],
    )
  ).rows[0];
  if (!row) return null;
  if (row.stale) await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id]);
  const user = camel<SessionUser & { stale: boolean }>(row);
  const tenant = user.tenantId
    ? camel<TenantRow>((await db.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [user.tenantId])).rows[0]!)
    : null;
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId }, tenant };
}

export async function deleteSession(db: Db, token: string) {
  await db.query('DELETE FROM sessions WHERE id = $1', [hashToken(token)]);
}

async function deleteUserSessions(q: Queryable, userId: number, exceptId?: string) {
  await q.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)', [userId, exceptId ?? null]);
}

// ---------------------------------------------------------------------------
// Login and passwords
// ---------------------------------------------------------------------------

/** Check an email and password. The same message is used for every kind of failure. */
export async function login(db: Db, email: string, password: string): Promise<SessionUser> {
  const row = (await db.query(`SELECT ${USER_COLUMNS}, password_hash, active FROM users WHERE lower(email) = lower($1)`, [email])).rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? null);
  if (!row || !ok || !row.active) throw new HttpError(401, LOGIN_FAILED, 'bad_login');
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
  const u = camel<SessionUser>(row);
  return { id: u.id, email: u.email, name: u.name, role: u.role, tenantId: u.tenantId };
}

export async function changePassword(db: Db, userId: number, current: string, next: string, keepSessionToken?: string) {
  const row = (await db.query('SELECT email, password_hash FROM users WHERE id = $1', [userId])).rows[0];
  if (!row || !(await verifyPassword(current, row.password_hash))) throw badRequest('Your current password is not right.');
  checkNewPassword(next, row.email);
  const hash = await hashPassword(next);
  await db.tx(async (q) => {
    await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
    // Log out everywhere else.
    await deleteUserSessions(q, userId, keepSessionToken ? hashToken(keepSessionToken) : undefined);
  });
}

// ---------------------------------------------------------------------------
// One-time links (invite = first password, reset = new password)
// ---------------------------------------------------------------------------

async function issueToken(q: Queryable, userId: number, kind: 'invite' | 'reset'): Promise<string> {
  const token = newToken();
  const days = kind === 'invite' ? config.inviteDays : 1;
  // Only the newest link works.
  await q.query('UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await q.query('INSERT INTO user_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    userId,
    kind,
    hashToken(token),
    new Date(Date.now() + days * 86_400_000).toISOString(),
  ]);
  return token;
}

export async function tokenInfo(db: Db, token: string) {
  const row = (
    await db.query(
      `SELECT k.kind, u.email, u.name, t.name AS business_name
       FROM user_tokens k JOIN users u ON u.id = k.user_id LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE k.token_hash = $1 AND k.used_at IS NULL AND k.expires_at > now() AND u.active`,
      [hashToken(token)],
    )
  ).rows[0];
  if (!row) throw new HttpError(400, 'This link has expired or was already used. Ask for a new one.', 'bad_token');
  return camel<{ kind: 'invite' | 'reset'; email: string; name: string; businessName: string | null }>(row);
}

/** Use a link to set a password. Returns the person so they can be logged in straight away. */
export async function acceptToken(db: Db, token: string, password: string): Promise<SessionUser> {
  const info = await tokenInfo(db, token);
  checkNewPassword(password, info.email);
  const hash = await hashPassword(password);
  return db.tx(async (q) => {
    const used = (
      await q.query(
        `UPDATE user_tokens SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [hashToken(token)],
      )
    ).rows[0];
    if (!used) throw new HttpError(400, 'This link has expired or was already used. Ask for a new one.', 'bad_token');
    await q.query('UPDATE users SET password_hash = $2, last_login_at = now() WHERE id = $1', [used.user_id, hash]);
    await deleteUserSessions(q, used.user_id);
    const u = camel<SessionUser>((await q.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [used.user_id])).rows[0]!);
    return { id: u.id, email: u.email, name: u.name, role: u.role, tenantId: u.tenantId };
  });
}

/** A fresh one-time link for a user who forgot their password (or never used their invite). */
export async function createLinkFor(db: Db, userId: number, tenantId: number | null): Promise<{ token: string; kind: 'invite' | 'reset'; email: string }> {
  const user = (await db.query('SELECT email, password_hash, tenant_id, active FROM users WHERE id = $1', [userId])).rows[0];
  if (!user || user.tenant_id !== tenantId) throw notFound('Person not found');
  if (!user.active) throw badRequest('That person is switched off.');
  const kind = user.password_hash ? 'reset' : 'invite';
  return db.tx(async (q) => ({ token: await issueToken(q, userId, kind), kind, email: user.email }));
}

// ---------------------------------------------------------------------------
// Businesses and people
// ---------------------------------------------------------------------------

function uniqueEmailError(err: any): never {
  if (err?.code === '23505') throw conflict('Someone already has an account with that email address.');
  throw err;
}

export async function createTenantWithOwner(
  db: Db,
  input: { businessName: string; ownerEmail: string; ownerName: string; trialDays: number },
): Promise<{ tenant: TenantRow; ownerId: number; token: string }> {
  try {
    return await db.tx(async (q) => {
      const t = (
        await q.query(`INSERT INTO tenants (name, status, trial_ends_on) VALUES ($1, 'trial', $2) RETURNING ${TENANT_COLUMNS}`, [
          input.businessName,
          addDays(localToday(), input.trialDays),
        ])
      ).rows[0]!;
      const owner = (
        await q.query<{ id: number }>(
          `INSERT INTO users (tenant_id, email, name, role) VALUES ($1, $2, $3, 'owner') RETURNING id`,
          [t.id, input.ownerEmail, input.ownerName],
        )
      ).rows[0]!;
      return { tenant: camel<TenantRow>(t), ownerId: owner.id, token: await issueToken(q, owner.id, 'invite') };
    });
  } catch (err) {
    uniqueEmailError(err);
  }
}

/** For a business that has no owner yet (for example one migrated from the single-business version). */
export async function inviteOwner(db: Db, tenantId: number, input: { email: string; name: string }) {
  try {
    return await db.tx(async (q) => {
      const t = (await q.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rows[0];
      if (!t) throw notFound('Business not found');
      const has = (await q.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND role = 'owner'`, [tenantId])).rows[0];
      if (has) throw conflict('This business already has an owner. Use "Create sign-in link" for them instead.');
      const u = (
        await q.query<{ id: number }>(`INSERT INTO users (tenant_id, email, name, role) VALUES ($1, $2, $3, 'owner') RETURNING id`, [
          tenantId,
          input.email,
          input.name,
        ])
      ).rows[0]!;
      return { userId: u.id, token: await issueToken(q, u.id, 'invite') };
    });
  } catch (err) {
    uniqueEmailError(err);
  }
}

export async function inviteStaff(db: Db, tenantId: number, input: { email: string; name: string }) {
  try {
    return await db.tx(async (q) => {
      const u = (
        await q.query<{ id: number }>(`INSERT INTO users (tenant_id, email, name, role) VALUES ($1, $2, $3, 'staff') RETURNING id`, [
          tenantId,
          input.email,
          input.name,
        ])
      ).rows[0]!;
      return { userId: u.id, token: await issueToken(q, u.id, 'invite') };
    });
  } catch (err) {
    uniqueEmailError(err);
  }
}

export async function listTeam(db: Db, tenantId: number) {
  const rows = (
    await db.query(
      `SELECT id, email, name, role, active, (password_hash IS NOT NULL) AS has_password, last_login_at::text AS last_login_at
       FROM users WHERE tenant_id = $1 ORDER BY (role = 'owner') DESC, name, email`,
      [tenantId],
    )
  ).rows;
  return rows.map((r) => camel(r));
}

export async function setStaffActive(db: Db, tenantId: number, userId: number, active: boolean) {
  const u = (await db.query('SELECT role FROM users WHERE id = $1 AND tenant_id = $2', [userId, tenantId])).rows[0];
  if (!u) throw notFound('Person not found');
  if (u.role === 'owner') throw badRequest('The owner cannot be switched off.');
  await db.tx(async (q) => {
    await q.query('UPDATE users SET active = $2 WHERE id = $1', [userId, active]);
    if (!active) await deleteUserSessions(q, userId);
  });
}

export async function listTenantsForAdmin(db: Db) {
  const rows = (
    await db.query(
      `SELECT ${TENANT_COLUMNS},
         (SELECT id FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner') AS owner_id,
         (SELECT email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner') AS owner_email,
         (SELECT name FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner') AS owner_name,
         (SELECT (password_hash IS NOT NULL) FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner') AS owner_has_password,
         (SELECT count(*)::int FROM runs r WHERE r.tenant_id = t.id AND r.status = 'saved') AS saved_runs,
         (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active) AS people,
         (SELECT max(last_login_at)::text FROM users u WHERE u.tenant_id = t.id) AS last_login_at
       FROM tenants t ORDER BY t.created_at DESC, t.id DESC`,
    )
  ).rows;
  const today = localToday();
  return rows.map((r) => {
    const t = camel<any>(r);
    return { ...t, access: accessFor(t, today) };
  });
}

/** Create the platform admin (you) on first start. Does nothing if an admin already exists. */
export async function ensureAdmin(db: Db, email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const exists = (await db.query(`SELECT 1 FROM users WHERE role = 'platform_admin'`)).rows[0];
  if (exists) return false;
  checkNewPassword(password, email);
  await db.query(`INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (NULL, $1, 'Platform admin', 'platform_admin', $2)`, [
    email.trim().toLowerCase(),
    await hashPassword(password),
  ]);
  return true;
}
