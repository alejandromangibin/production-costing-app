import request from 'supertest';
import { useFastPasswordHashingForTests } from '../src/auth/password';
import { type AppOptions, createApp } from '../src/app';
import { type Db, openDb } from '../src/db/index';
import { migrate } from '../src/db/migrate';
import { acceptToken, createTenantWithOwner, ensureAdmin } from '../src/services/accounts';

useFastPasswordHashingForTests();

export const PASSWORD = 'correct horse battery';

/**
 * One database per test file (starting one is slow), emptied before every test.
 * Normally an in-memory PGlite. Set TEST_DATABASE_URL to run on a real PostgreSQL
 * (WARNING: that database's public schema is wiped).
 */
export async function openTestDb(): Promise<Db> {
  const db = await openDb({ memory: true, databaseUrl: process.env.TEST_DATABASE_URL });
  if (db.kind === 'postgres') await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  return db;
}

export async function resetData(db: Db) {
  await db.exec(
    `TRUNCATE sessions, user_tokens, payments, run_cost_targets, run_costs, run_packings, run_products, runs,
              pack_sizes, products, users, tenants RESTART IDENTITY CASCADE`,
  );
}

export function makeApp(db: Db, opts: AppOptions = {}) {
  return createApp(db, { webDist: '/nonexistent', cookieSecure: false, ...opts });
}

export type App = ReturnType<typeof makeApp>;
export type Agent = ReturnType<typeof request.agent>;

/** A business with an owner who has chosen a password and is logged in. */
export async function createBusiness(app: App, db: Db, name: string, email: string, opts: { trialDays?: number } = {}) {
  const created = await createTenantWithOwner(db, {
    businessName: name,
    ownerEmail: email,
    ownerName: `${name} Owner`,
    trialDays: opts.trialDays ?? 30,
  });
  await acceptToken(db, created.token, PASSWORD);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return { agent, tenantId: created.tenant.id, ownerId: created.ownerId, email };
}

export async function createAdminAgent(app: App, db: Db, email = 'admin@platform.test') {
  await ensureAdmin(db, email, PASSWORD);
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return agent;
}

// ---- Sample catalog used by several tests ----

export async function makeCatalog(api: Agent) {
  const pork = (
    await api.post('/api/products').send({
      code: 'pork',
      name: 'Pork Siomai',
      shelfLifeDays: 90,
      packSizes: [{ piecesPerPack: 12, retailPriceCents: 7000, packagingCostCents: 500 }],
    })
  ).body;
  const jap = (
    await api.post('/api/products').send({
      code: 'JAP',
      name: 'Japanese Siomai',
      shelfLifeDays: 60,
      packSizes: [
        { piecesPerPack: 12, retailPriceCents: 11000, packagingCostCents: 500 },
        { piecesPerPack: 20, retailPriceCents: 17500, packagingCostCents: 700 },
      ],
    })
  ).body;
  return { pork, jap };
}

export const size = (product: any, pieces: number) => product.packSizes.find((s: any) => s.piecesPerPack === pieces);

/** The AT-01 run from the functional requirements. */
export function at01Body(c: { pork: any; jap: any }, runDate = '2026-10-19') {
  return {
    runDate,
    note: 'AT-01',
    products: [
      { productId: c.pork.id, loosePieces: 6, rejectedPieces: 4, packings: [{ packSizeId: size(c.pork, 12).id, packs: 20 }] },
      {
        productId: c.jap.id,
        loosePieces: 18,
        rejectedPieces: 12,
        packings: [
          { packSizeId: size(c.jap, 12).id, packs: 50 },
          { packSizeId: size(c.jap, 20).id, packs: 6 },
        ],
      },
    ],
    costs: [
      { category: 'ingredient', description: 'Base', amountCents: 280000, scope: 'shared' },
      { category: 'ingredient', description: 'Japanese only', amountCents: 60000, scope: 'specific', targetProductIds: [c.jap.id] },
    ],
  };
}
