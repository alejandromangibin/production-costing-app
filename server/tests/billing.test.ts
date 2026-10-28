import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTimeZone } from '../src/config';
import { addDays, localTimeStamp, localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { accessFor, addMonths } from '../src/services/billing';
import { type App, at01Body, createAdminAgent, createBusiness, makeApp, makeCatalog, openTestDb, resetData } from './helpers';

let db: Db;
let app: App;

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(() => resetData(db));
afterAll(async () => {
  await db?.close();
});

describe("business dates follow Manila time, not the server's clock", () => {
  // Hosted servers usually run on UTC. Run these tests that way, whatever this computer uses.
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  afterEach(() => vi.useRealTimers());

  it('a new day starts at midnight in Manila (16:00 UTC)', () => {
    expect(localToday(new Date('2026-10-27T15:59:59Z'), 'Asia/Manila')).toBe('2026-10-27');
    expect(localToday(new Date('2026-10-27T16:00:00Z'), 'Asia/Manila')).toBe('2026-10-28');
    expect(localToday(new Date('2026-12-31T16:30:00Z'), 'Asia/Manila')).toBe('2027-01-01');
    expect(localToday(new Date('2026-10-27T16:00:00Z'), 'UTC')).toBe('2026-10-27');
    // The default is the configured zone (Asia/Manila).
    expect(localToday(new Date('2026-10-27T16:00:00Z'))).toBe('2026-10-28');
  });

  it('backup file names use Manila date and time together', () => {
    const at = new Date('2026-10-27T19:05:09Z'); // 3:05:09 am on Oct 28 in Manila
    expect(`${localToday(at, 'Asia/Manila')}-${localTimeStamp(at, 'Asia/Manila')}`).toBe('2026-10-28-030509');
    expect(localTimeStamp(new Date('2026-10-27T16:00:00Z'), 'Asia/Manila')).toBe('000000'); // midnight is 00, not 24
  });

  it('refuses an unknown time zone setting with a clear message', () => {
    expect(resolveTimeZone(undefined)).toBe('Asia/Manila');
    expect(resolveTimeZone('')).toBe('Asia/Manila');
    expect(resolveTimeZone('UTC')).toBe('UTC');
    expect(() => resolveTimeZone('Mars/Base')).toThrow('APP_TIME_ZONE "Mars/Base" is not a time zone');
  });

  it('a trial ends at midnight Manila time', async () => {
    const { agent, tenantId } = await createBusiness(app, db, 'Night Shift', 'night@a.test');
    await db.query(`UPDATE tenants SET trial_ends_on = '2026-10-27' WHERE id = $1`, [tenantId]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T15:59:00Z')); // 11:59 pm on Oct 27 in Manila
    expect((await agent.get('/api/auth/me')).body.tenant.access.level).toBe('full');
    vi.setSystemTime(new Date('2026-10-27T16:01:00Z')); // 12:01 am on Oct 28 in Manila, still Oct 27 in UTC
    expect((await agent.get('/api/auth/me')).body.tenant.access.level).toBe('read_only');
  });

  it('the expiry board counts days left from Manila today when the browser sends no date', async () => {
    const { agent } = await createBusiness(app, db, 'Late Batch', 'late@a.test');
    const c = await makeCatalog(agent);
    await agent.post('/api/runs').send(at01Body(c, '2026-08-01')).expect(201);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T16:30:00Z')); // 12:30 am on Sep 30 in Manila, still Sep 29 in UTC. In the past, so the sign-in cookie stays valid.
    const board = (await agent.get('/api/batches/expiry')).body;
    expect(board.today).toBe('2026-09-30');
    expect(board.batches.find((b: any) => b.expiryDate === '2026-09-30').daysRemaining).toBe(0);
  });

  it("a new business's trial is counted from Manila's date", async () => {
    const admin = await createAdminAgent(app, db);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T17:00:00Z')); // 1 am on Oct 28 in Manila
    const r = await admin.post('/api/admin/tenants').send({ businessName: 'Early Bird', ownerEmail: 'early@a.test', ownerName: 'Ana', trialDays: 14 });
    expect(r.status).toBe(201);
    expect(r.body.tenant.trialEndsOn).toBe('2026-11-11');
  });
});

describe('what a business may do (accessFor)', () => {
  const t = (status: any, trialEndsOn = '2026-11-01', paidThrough: string | null = null) => ({ status, trialEndsOn, paidThrough });
  const today = '2026-10-20';

  it('trial: full until the trial ends, then read-only', () => {
    expect(accessFor(t('trial', '2026-11-30'), today)).toMatchObject({ level: 'full', message: null, daysLeft: 41 });
    expect(accessFor(t('trial', '2026-10-25'), today)).toMatchObject({ level: 'full', daysLeft: 5 });
    expect(accessFor(t('trial', '2026-10-25'), today).message).toMatch(/ends in 5 days/);
    expect(accessFor(t('trial', '2026-10-21'), today).message).toMatch(/ends in 1 day\./);
    expect(accessFor(t('trial', today), today)).toMatchObject({ level: 'full', daysLeft: 0 });
    expect(accessFor(t('trial', '2026-10-19'), today)).toMatchObject({ level: 'read_only' });
  });

  it('paid: full until paid-through, a grace period after, then read-only', () => {
    expect(accessFor(t('active', '2026-01-01', '2026-12-01'), today)).toMatchObject({ level: 'full', message: null });
    expect(accessFor(t('active', '2026-01-01', '2026-10-23'), today).message).toMatch(/due in 3 days/);
    expect(accessFor(t('active', '2026-01-01', '2026-10-20'), today)).toMatchObject({ level: 'full', daysLeft: 0 });
    const grace = accessFor(t('active', '2026-01-01', '2026-10-17'), today, 7);
    expect(grace.level).toBe('full');
    expect(grace.message).toMatch(/overdue/);
    expect(accessFor(t('active', '2026-01-01', '2026-10-13'), today, 7).level).toBe('full'); // exactly 7 days late
    expect(accessFor(t('active', '2026-01-01', '2026-10-12'), today, 7)).toMatchObject({ level: 'read_only' });
    expect(accessFor(t('active', '2026-01-01', null), today).level).toBe('read_only');
  });

  it('cancelled is read-only, suspended is blocked', () => {
    expect(accessFor(t('cancelled', '2026-12-01', '2027-01-01'), today).level).toBe('read_only');
    expect(accessFor(t('suspended', '2026-12-01', '2027-01-01'), today).level).toBe('blocked');
  });
});

describe('addMonths', () => {
  it('adds months and clamps to the end of shorter months', () => {
    expect(addMonths('2026-10-20', 1)).toBe('2026-11-20');
    expect(addMonths('2026-10-20', 3)).toBe('2027-01-20');
    expect(addMonths('2026-12-31', 2)).toBe('2027-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 12)).toBe('2027-11-30');
    expect(addMonths('2026-01-15', 36)).toBe('2029-01-15');
  });
});

describe('subscription gating through the API', () => {
  async function lapse(tenantId: number) {
    await db.query(`UPDATE tenants SET status = 'trial', trial_ends_on = $2 WHERE id = $1`, [tenantId, addDays(localToday(), -1)]);
  }

  it('a lapsed business can look, preview, search and download, but cannot add or change', async () => {
    const { agent, tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const c = await makeCatalog(agent);
    const run = (await agent.post('/api/runs').send(at01Body(c))).body;
    await lapse(tenantId);

    expect((await agent.get('/api/auth/me')).body.tenant.access.level).toBe('read_only');
    for (const path of ['/api/products', '/api/runs', `/api/runs/${run.id}`, '/api/margins', '/api/export', '/api/runs/export.csv', '/api/batches/expiry']) {
      expect((await agent.get(path)).status, path).toBe(200);
    }
    expect((await agent.post('/api/runs/preview').send(at01Body(c))).status).toBe(200);

    const blocked = [
      await agent.post('/api/runs').send(at01Body(c, '2026-11-02')),
      await agent.post(`/api/runs/${run.id}/void`).send({ reason: 'x' }),
      await agent.post('/api/products').send({ code: 'NEW', name: 'New', shelfLifeDays: 5 }),
      await agent.patch(`/api/products/${c.pork.id}`).send({ name: 'Changed' }),
      await agent.post('/api/team').send({ email: 'x@a.test', name: 'X' }),
    ];
    for (const r of blocked) {
      expect(r.status).toBe(402);
      expect(r.body.code).toBe('read_only');
      expect(r.body.error).toMatch(/trial has ended/);
    }
    expect((await agent.get(`/api/runs/${run.id}`)).body.status).toBe('saved');
    expect((await agent.get('/api/runs')).body).toHaveLength(1);
  });

  it('a payment from the admin restores full access immediately', async () => {
    const admin = await createAdminAgent(app, db);
    const { agent, tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    await lapse(tenantId);
    expect((await agent.post('/api/products').send({ code: 'A', name: 'A', shelfLifeDays: 1 })).status).toBe(402);

    const paid = await admin.post(`/api/admin/tenants/${tenantId}/payments`).send({
      amountCents: 150000,
      method: 'GCash',
      reference: 'REF123',
      paidOn: localToday(),
      months: 1,
    });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('active');
    expect(paid.body.paidThrough).toBe(addMonths(localToday(), 1));
    expect((await agent.post('/api/products').send({ code: 'A', name: 'A', shelfLifeDays: 1 })).status).toBe(201);
  });

  it('payments extend from the paid-through date while still paid, otherwise from the payment date', async () => {
    const admin = await createAdminAgent(app, db);
    const { tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const pay = (body: object) => admin.post(`/api/admin/tenants/${tenantId}/payments`).send({ amountCents: 100000, months: 1, ...body });

    expect((await pay({ paidOn: '2026-10-20' })).body.paidThrough).toBe('2026-11-20');
    expect((await pay({ paidOn: '2026-10-25', months: 2 })).body.paidThrough).toBe('2027-01-20'); // extends from Nov 20
    // A late payer starts again from the payment date.
    await db.query(`UPDATE tenants SET paid_through = '2026-01-10' WHERE id = $1`, [tenantId]);
    expect((await pay({ paidOn: '2026-10-25' })).body.paidThrough).toBe('2026-11-25');

    const history = (await admin.get(`/api/admin/tenants/${tenantId}/payments`)).body;
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ months: 1, amountCents: 100000 });
  });

  it('a suspended business is locked out of its data, and a payment does not undo a suspension', async () => {
    const admin = await createAdminAgent(app, db);
    const { agent, tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    await admin.patch(`/api/admin/tenants/${tenantId}`).send({ status: 'suspended' }).expect(200);

    const r = await agent.get('/api/products');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('suspended');
    expect((await agent.get('/api/auth/me')).body.tenant.access.level).toBe('blocked');

    const paid = await admin.post(`/api/admin/tenants/${tenantId}/payments`).send({ amountCents: 1, paidOn: localToday(), months: 1 });
    expect(paid.body.status).toBe('suspended');
    await admin.patch(`/api/admin/tenants/${tenantId}`).send({ status: 'active' }).expect(200);
    expect((await agent.get('/api/products')).status).toBe(200);
  });

  it('cannot mark a business active before any payment, and validates admin input', async () => {
    const admin = await createAdminAgent(app, db);
    const { tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    expect((await admin.patch(`/api/admin/tenants/${tenantId}`).send({ status: 'active' })).status).toBe(400);
    expect((await admin.patch(`/api/admin/tenants/${tenantId}`).send({ status: 'nonsense' })).status).toBe(400);
    expect((await admin.post(`/api/admin/tenants/${tenantId}/payments`).send({ amountCents: 100, paidOn: '2026-10-20', months: 0 })).status).toBe(400);
    expect((await admin.post(`/api/admin/tenants/${tenantId}/payments`).send({ amountCents: -5, paidOn: '2026-10-20', months: 1 })).status).toBe(400);
    expect((await admin.post('/api/admin/tenants/9999/payments').send({ amountCents: 100, paidOn: '2026-10-20', months: 1 })).status).toBe(404);
  });

  it('the admin list shows each business with its status, owner and activity', async () => {
    const admin = await createAdminAgent(app, db);
    const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    await createBusiness(app, db, 'Cafe', 'owner@b.test', { trialDays: 3 });
    const c = await makeCatalog(a.agent);
    await a.agent.post('/api/runs').send(at01Body(c));

    const list = (await admin.get('/api/admin/tenants')).body;
    expect(list).toHaveLength(2);
    const frozen = list.find((t: any) => t.name === 'Frozen Foods');
    expect(frozen).toMatchObject({ ownerEmail: 'owner@a.test', savedRuns: 1, status: 'trial', people: 1, ownerHasPassword: true });
    expect(frozen.access.level).toBe('full');
    const cafe = list.find((t: any) => t.name === 'Cafe');
    expect(cafe.access.message).toMatch(/ends in 3 days/);
    expect(cafe.savedRuns).toBe(0);
  });

  it('creates a business with a trial length and rejects a duplicate owner email', async () => {
    const admin = await createAdminAgent(app, db);
    const r = await admin.post('/api/admin/tenants').send({ businessName: 'New Cafe', ownerEmail: 'new@cafe.test', ownerName: 'Ana', trialDays: 14 });
    expect(r.status).toBe(201);
    expect(r.body.tenant.trialEndsOn).toBe(addDays(localToday(), 14));
    expect(r.body.inviteUrl).toMatch(/\/set-password\?token=/);
    const dup = await admin.post('/api/admin/tenants').send({ businessName: 'Other', ownerEmail: 'NEW@cafe.test', ownerName: 'Bo' });
    expect(dup.status).toBe(409);
    expect((await admin.get('/api/admin/tenants')).body).toHaveLength(1); // nothing half-created
  });

  it('an orphan business (for example migrated data) can be given an owner', async () => {
    const admin = await createAdminAgent(app, db);
    const t = await db.query(`INSERT INTO tenants (name, trial_ends_on) VALUES ('Migrated business', current_date + 30) RETURNING id`);
    const id = t.rows[0]!.id;
    const r = await admin.post(`/api/admin/tenants/${id}/owner`).send({ email: 'me@mine.test', name: 'Me' });
    expect(r.status).toBe(201);
    expect((await admin.post(`/api/admin/tenants/${id}/owner`).send({ email: 'two@mine.test', name: 'Two' })).status).toBe(409);
    const fresh = request.agent(app);
    const token = new URL(r.body.inviteUrl).searchParams.get('token');
    await fresh.post('/api/auth/accept').send({ token, password: 'a long enough password' }).expect(200);
    expect((await fresh.get('/api/auth/me')).body.tenant.name).toBe('Migrated business');
  });
});
