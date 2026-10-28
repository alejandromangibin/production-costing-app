import { Router } from 'express';
import { FailureLimiter } from '../auth/rateLimit';
import { type AuthKit, buildAuth } from '../auth/middleware';
import { type Db } from '../db/index';
import { HttpError } from '../errors';
import { acceptBody, loginBody, passwordBody } from '../schemas';
import { acceptToken, changePassword, createSession, deleteSession, findSession, login, tokenInfo } from '../services/accounts';

function mePayload(auth: NonNullable<Express.Request['auth']>) {
  const { user, tenant, access } = auth;
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          trialEndsOn: tenant.trialEndsOn,
          paidThrough: tenant.paidThrough,
          access: access!,
        }
      : null,
  };
}

export function authRoutes(db: Db, kit: AuthKit) {
  const r = Router();
  // 8 wrong passwords per email and 40 per address, per 15 minutes.
  const byEmail = new FailureLimiter(8, 15 * 60_000);
  const byAddress = new FailureLimiter(40, 15 * 60_000);

  r.post('/login', async (req, res) => {
    const body = loginBody.parse(req.body);
    const ipKey = req.ip ?? 'unknown';
    const wait = Math.max(byEmail.retryAfterSeconds(body.email), byAddress.retryAfterSeconds(ipKey));
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      const minutes = Math.ceil(wait / 60);
      throw new HttpError(429, `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'rate_limited');
    }
    let user;
    try {
      user = await login(db, body.email, body.password);
    } catch (err) {
      byEmail.fail(body.email);
      byAddress.fail(ipKey);
      throw err;
    }
    byEmail.clear(body.email);
    const { token, expires } = await createSession(db, user.id);
    kit.setCookie(res, token, expires);
    const session = (await findSession(db, token))!;
    res.json(mePayload(buildAuth(session, token)));
  });

  r.post('/logout', async (req, res) => {
    if (req.auth) await deleteSession(db, req.auth.token);
    kit.clearCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', kit.requireUser, (req, res) => {
    res.json(mePayload(req.auth!));
  });

  // The page behind an invite or reset link asks who the link is for.
  r.get('/token-info', async (req, res) => {
    res.json(await tokenInfo(db, String(req.query.token ?? '')));
  });

  r.post('/accept', async (req, res) => {
    const body = acceptBody.parse(req.body);
    const user = await acceptToken(db, body.token, body.password);
    const { token, expires } = await createSession(db, user.id);
    kit.setCookie(res, token, expires);
    res.json({ ok: true });
  });

  r.post('/password', kit.requireUser, async (req, res) => {
    const body = passwordBody.parse(req.body);
    await changePassword(db, req.auth!.user.id, body.currentPassword, body.newPassword, req.auth!.token);
    res.json({ ok: true });
  });

  return r;
}
