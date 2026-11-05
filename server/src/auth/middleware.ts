import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';
import { localToday } from '../dates';
import type { Db } from '../db/index';
import { scopedDb } from '../db/scoped';
import { HttpError, forbidden, unauthorized } from '../errors';
import { findSession, type Session } from '../services/accounts';
import { type Access, accessFor } from '../services/billing';

export interface AuthContext extends Session {
  token: string;
  /** What the person's business may do today. Null for the platform admin. */
  access: Access | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** A database handle that can only see the logged-in business. Set by requireTenant. */
      tdb?: Db;
    }
  }
}

export function buildAuth(session: Session, token: string): AuthContext {
  return { ...session, token, access: session.tenant ? accessFor(session.tenant, localToday()) : null };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export interface AuthOptions {
  cookieSecure: boolean;
  /** Extra browser origins allowed to make changes (for the web dev server). */
  allowedOrigins?: string[];
}

export function createAuth(db: Db, opts: AuthOptions) {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and site-wide.
  const cookieName = opts.cookieSecure ? '__Host-sid' : 'sid';

  const setCookie = (res: Response, token: string, expires: Date) =>
    res.cookie(cookieName, token, { httpOnly: true, sameSite: 'lax', secure: opts.cookieSecure, path: '/', expires });
  const clearCookie = (res: Response) =>
    res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: opts.cookieSecure, path: '/' });

  /** Works out who is logged in (if anyone). Never rejects on its own. */
  const loadSession: RequestHandler = async (req, res, next) => {
    const token = readCookie(req.headers.cookie, cookieName);
    if (token) {
      const session = await findSession(db, token);
      if (session) {
        req.auth = buildAuth(session, token);
      } else {
        clearCookie(res);
      }
    }
    next();
  };

  /** Blocks changes made from another website while the person is logged in here. */
  const originCheck: RequestHandler = (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* invalid origin falls through to refusal */
      }
      const allowed = host === req.get('host') || (opts.allowedOrigins ?? []).includes(origin);
      if (!allowed) return next(new HttpError(403, 'This request came from another website and was refused.', 'bad_origin'));
    } else if (req.get('sec-fetch-site') === 'cross-site') {
      return next(new HttpError(403, 'This request came from another website and was refused.', 'bad_origin'));
    }
    next();
  };

  const requireUser: RequestHandler = (req, _res, next) => (req.auth ? next() : next(unauthorized()));

  const requireAdmin: RequestHandler = (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.user.role !== 'platform_admin') return next(forbidden());
    next();
  };

  /** For everything a business does: needs a business login, and gives the handler a database limited to that business. */
  const requireTenant: RequestHandler = (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    const { user, access } = req.auth;
    if (user.role === 'platform_admin' || !user.tenantId) return next(forbidden('The admin account has no business data. Use the Admin page.'));
    if (access?.level === 'blocked') return next(new HttpError(403, access.message ?? 'This account is suspended.', 'suspended'));
    req.tdb = scopedDb(db, user.tenantId);
    next();
  };

  /** For anything that adds or changes data. A lapsed business can still look, and its owner can download. */
  const requireWritable: RequestHandler = (req, _res, next) => {
    if (req.auth?.access && req.auth.access.level !== 'full') {
      return next(new HttpError(402, req.auth.access.message ?? 'Your subscription is not active.', 'read_only'));
    }
    next();
  };

  const requireOwner: RequestHandler = (req, _res, next) => {
    if (req.auth?.user.role !== 'owner') return next(forbidden('Only the business owner can do this.'));
    next();
  };

  return { cookieName, setCookie, clearCookie, loadSession, originCheck, requireUser, requireAdmin, requireTenant, requireWritable, requireOwner };
}

export type AuthKit = ReturnType<typeof createAuth>;

/** Build the full address of a one-time link. */
export function linkUrl(req: Request, token: string): string {
  const origin = config.appOrigin || `${req.protocol}://${req.get('host')}`;
  return `${origin}/set-password?token=${encodeURIComponent(token)}`;
}

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
