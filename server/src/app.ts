import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { createAuth } from './auth/middleware';
import { CalcError } from './calc/types';
import { config } from './config';
import type { Db } from './db/index';
import { HttpError } from './errors';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import { teamRoutes } from './routes/team';

export interface AppOptions {
  /** Folder with the built web app to serve. Skipped if it does not exist. */
  webDist?: string;
  /** Browser address of the web dev server, allowed to call the API while developing. Empty = none. */
  corsOrigin?: string;
  cookieSecure?: boolean;
  trustProxy?: boolean;
}

export function createApp(db: Db, opts: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy ?? config.trustProxy) app.set('trust proxy', 1);

  const corsOrigin = opts.corsOrigin ?? config.corsOrigin;
  const cookieSecure = opts.cookieSecure ?? config.cookieSecure;

  app.use((_req, res, next) => {
    // Basic hardening for a page that shows private business data.
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      ...(cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    next();
  });
  // Only the web dev server needs this; a hosted app serves its own pages, so it allows no other origin.
  if (corsOrigin) app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  const kit = createAuth(db, { cookieSecure, allowedOrigins: corsOrigin ? [corsOrigin] : [] });

  const api = express.Router();
  api.use((_req, res, next) => {
    // Private data must never be kept by a shared cache.
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.get('/health', (_req, res) => {
    res.json({ ok: true, database: db.kind });
  });
  api.use(kit.originCheck);
  api.use(kit.loadSession);
  api.use('/auth', authRoutes(db, kit));
  api.use('/admin', adminRoutes(db, kit));
  api.use('/team', teamRoutes(db, kit));
  api.use(dataRoutes(kit));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/api', api);

  // Serve the built web app when it exists (used after `npm run build`).
  const dist = opts.webDist ?? config.webDist;
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      res.status(400).json({ error: `${where}${first?.message ?? 'Invalid input'}`, issues: err.issues });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    } else if (err instanceof CalcError) {
      res.status(422).json({ error: err.message });
    } else if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'The request was not valid JSON.' });
    } else if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'That request is too large.' });
    } else if (err?.expose === true && err.status >= 400 && err.status < 500) {
      // Other client mistakes reported by middleware (the body parser: bad or unsupported compression or charset; static files: a failed precondition).
      res.status(err.status).json({ error: 'The request could not be read.' });
    } else if (err?.code === '23505') {
      res.status(409).json({ error: 'That already exists.' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on the server. Please try again, and tell support if it keeps happening.' });
    }
  };
  app.use(onError);

  return app;
}
