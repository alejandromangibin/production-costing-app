import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FailureLimiter } from '../src/auth/rateLimit';
import { checkNewPassword, hashPassword, verifyPassword } from '../src/auth/password';
import type { Db } from '../src/db/index';
import { acceptToken, createLinkFor, createTenantWithOwner, inviteStaff } from '../src/services/accounts';
import { PASSWORD, type App, createAdminAgent, createBusiness, makeApp, openTestDb, resetData } from './helpers';

let db: Db;
let app: App;

beforeAll(async () => {
  db = await openTestDb();
});
beforeEach(async () => {
  await resetData(db);
  // A fresh app every test, so the login lockout of one test cannot leak into the next.
  app = makeApp(db);
});
afterAll(async () => {
  await db?.close();
});

// Stops supertest turning a Buffer into JSON, so the raw (compressed) bytes are sent as they are.
const keepBytes = ((b: Buffer) => b) as unknown as (body: unknown) => string;
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('a long enough password');
    const b = await hashPassword('a long enough password');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('a long enough password', a)).toBe(true);
    expect(await verifyPassword('a long enough passworD', a)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });

  it('applies the password rules', () => {
    expect(() => checkNewPassword('short')).toThrow(/at least 10/);
    expect(() => checkNewPassword('aaaaaaaaaaaa')).toThrow(/repeated/);
    expect(() => checkNewPassword('me@example.com', 'ME@example.com')).toThrow(/email/);
    expect(() => checkNewPassword('correct horse battery')).not.toThrow();
  });
});

describe('login', () => {
  it('logs in, reports who you are, and logs out', async () => {
    const { agent } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'owner@a.test', role: 'owner' });
    expect(me.body.tenant).toMatchObject({ name: 'Frozen Foods', status: 'trial' });
    expect(me.body.tenant.access.level).toBe('full');
    expect(me.body.timeZone).toBe('Asia/Manila');
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash/i);

    await agent.post('/api/auth/logout').expect(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await agent.get('/api/products')).status).toBe(401);
  });

  it('sets a locked-down cookie and never stores the raw session id', async () => {
    const { email } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    const raw = /sid=([^;]+)/.exec(cookie)![1]!;
    const stored = (await db.query('SELECT id FROM sessions')).rows.map((r) => r.id);
    expect(stored).not.toContain(raw);
    expect(stored.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
  });

  it('uses the __Host- cookie with the Secure flag when secure cookies are on', async () => {
    const secureApp = makeApp(db, { cookieSecure: true });
    const { email } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const res = await request(secureApp).post('/api/auth/login').send({ email, password: PASSWORD });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-sid=/);
    expect(cookie).toMatch(/Secure/i);
    expect(res.headers['strict-transport-security']).toBeTruthy();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const { email } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const wrong = await request(app).post('/api/auth/login').send({ email, password: 'not the password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@a.test', password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error).toBe('Wrong email or password.');
  });

  it('ignores upper/lower case and spaces in the email', async () => {
    const { email } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const r = await request(app).post('/api/auth/login').send({ email: `  ${email.toUpperCase()} `, password: PASSWORD });
    expect(r.status).toBe(200);
  });

  // The three tests below check that compressed request bodies are still handled sensibly.
  // They are NOT proof that the body-parser advisory is fixed; the version guard in
  // tests/dependencies.test.ts covers that.
  it('still reads a JSON body sent gzip-compressed', async () => {
    const { email } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const body = gzipSync(JSON.stringify({ email, password: PASSWORD }));
    const r = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize(keepBytes)
      .send(body);
    expect(r.status).toBe(200);
  });

  it('answers 400 for a body that says it is gzip but is not, and keeps working', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize(keepBytes)
      .send(Buffer.from('this is not gzip data'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('The request could not be read.');
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('answers 415 for a content encoding it does not support', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'compress')
      .serialize(keepBytes)
      .send(Buffer.from('anything'));
    expect(r.status).toBe(415);
    expect(r.body.error).toBe('The request could not be read.');
  });

  it('locks out repeated wrong passwords for that email, then recovers after a right one elsewhere', async () => {
    const { email } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    for (let i = 0; i < 8; i++) {
      expect((await request(app).post('/api/auth/login').send({ email, password: `wrong-${i}-password` })).status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.body.code).toBe('rate_limited');
  });

  it('the limiter forgets after its window', () => {
    let now = 0;
    const l = new FailureLimiter(2, 1000, () => now);
    l.fail('k');
    l.fail('k');
    expect(l.retryAfterSeconds('k')).toBeGreaterThan(0);
    now = 1500;
    expect(l.retryAfterSeconds('k')).toBe(0);
  });

  it('switched-off people cannot log in and are logged out at once', async () => {
    const { agent, tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const staff = await inviteStaff(db, tenantId, { email: 'staff@a.test', name: 'Staff' });
    await acceptToken(db, staff.token, PASSWORD);
    const staffAgent = request.agent(app);
    await staffAgent.post('/api/auth/login').send({ email: 'staff@a.test', password: PASSWORD }).expect(200);
    expect((await staffAgent.get('/api/products')).status).toBe(200);

    await agent.patch(`/api/team/${staff.userId}`).send({ active: false }).expect(200);
    expect((await staffAgent.get('/api/products')).status).toBe(401);
    expect((await staffAgent.get('/api/export')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'staff@a.test', password: PASSWORD })).status).toBe(401);
  });

  it('expired sessions stop working', async () => {
    const { agent } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    await db.exec(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('requires a login for every business route', async () => {
    for (const path of ['/api/products', '/api/runs', '/api/margins', '/api/batches/expiry', '/api/export', '/api/team', '/api/runs/export.csv']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/runs').send({})).status).toBe(401);
    expect((await request(app).get('/api/admin/tenants')).status).toBe(401);
  });

  it('refuses changes that come from another website', async () => {
    const { agent } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const evil = await agent.post('/api/products').set('Origin', 'https://evil.example').send({ code: 'X', name: 'X', shelfLifeDays: 1 });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('bad_origin');
    const crossSite = await agent.post('/api/products').set('Sec-Fetch-Site', 'cross-site').send({ code: 'X', name: 'X', shelfLifeDays: 1 });
    expect(crossSite.status).toBe(403);
    // Same site is fine.
    const ok = await agent.post('/api/products').set('Origin', 'http://127.0.0.1:1').set('Host', '127.0.0.1:1').send({ code: 'X', name: 'X', shelfLifeDays: 1 });
    expect(ok.status).toBe(201);
  });

  it('sends security headers and never lets private data be cached', async () => {
    const { agent } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const r = await agent.get('/api/products');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('a hosted app lets no other website call it; the dev server is allowed only while developing', async () => {
    // While developing, the web dev server may call the API.
    const dev = makeApp(db, { corsOrigin: 'http://localhost:5173' });
    const devReply = await request(dev).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(devReply.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    // Hosted (no CORS_ORIGIN): no other origin is announced, and changes from the dev address are refused.
    const hosted = makeApp(db, { corsOrigin: '' });
    const reply = await request(hosted).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
    const { agent } = await createBusiness(hosted, db, 'Frozen Foods', 'owner@a.test');
    const fromDev = await agent.post('/api/products').set('Origin', 'http://localhost:5173').send({ code: 'X', name: 'X', shelfLifeDays: 1 });
    expect(fromDev.status).toBe(403);
    expect(fromDev.body.code).toBe('bad_origin');
    // The app's own pages still work.
    const own = await agent.post('/api/products').set('Origin', 'http://127.0.0.1:1').set('Host', '127.0.0.1:1').send({ code: 'X', name: 'X', shelfLifeDays: 1 });
    expect(own.status).toBe(201);
  });
});

describe('invites and password resets', () => {
  it('an invite link sets the first password, once, and logs the person in', async () => {
    const admin = await createAdminAgent(app, db);
    const created = await admin.post('/api/admin/tenants').send({ businessName: 'New Cafe', ownerEmail: 'Owner@New.test', ownerName: 'Ana' });
    expect(created.status).toBe(201);
    const token = tokenOf(created.body.inviteUrl);

    const info = await request(app).get('/api/auth/token-info').query({ token });
    expect(info.body).toMatchObject({ kind: 'invite', email: 'owner@new.test', businessName: 'New Cafe' });

    // The person cannot log in before choosing a password.
    expect((await request(app).post('/api/auth/login').send({ email: 'owner@new.test', password: PASSWORD })).status).toBe(401);

    const weak = await request(app).post('/api/auth/accept').send({ token, password: 'short' });
    expect(weak.status).toBe(400);

    const fresh = request.agent(app);
    const ok = await fresh.post('/api/auth/accept').send({ token, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await fresh.get('/api/auth/me')).body.user.email).toBe('owner@new.test');

    // One use only.
    const again = await request(app).post('/api/auth/accept').send({ token, password: 'another long password' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('bad_token');
    expect((await request(app).get('/api/auth/token-info').query({ token })).status).toBe(400);
  });

  it('rejects made-up and expired links', async () => {
    expect((await request(app).get('/api/auth/token-info').query({ token: 'x'.repeat(43) })).status).toBe(400);
    const created = await createTenantWithOwner(db, { businessName: 'B', ownerEmail: 'b@b.test', ownerName: 'B', trialDays: 30 });
    await db.exec(`UPDATE user_tokens SET expires_at = now() - interval '1 minute'`);
    expect((await request(app).post('/api/auth/accept').send({ token: created.token, password: PASSWORD })).status).toBe(400);
  });

  it('only the newest link works', async () => {
    const created = await createTenantWithOwner(db, { businessName: 'B', ownerEmail: 'b@b.test', ownerName: 'B', trialDays: 30 });
    const newer = await createLinkFor(db, created.ownerId, created.tenant.id);
    expect((await request(app).post('/api/auth/accept').send({ token: created.token, password: PASSWORD })).status).toBe(400);
    expect((await request(app).post('/api/auth/accept').send({ token: newer.token, password: PASSWORD })).status).toBe(200);
  });

  it('a reset link changes the password and logs out everywhere', async () => {
    const { agent, tenantId, ownerId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const admin = await createAdminAgent(app, db);
    const link = await admin.post(`/api/admin/tenants/${tenantId}/people/${ownerId}/link`);
    expect(link.body.kind).toBe('reset');

    const reset = await request(app).post('/api/auth/accept').send({ token: tokenOf(link.body.url), password: 'a brand new password' });
    expect(reset.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'owner@a.test', password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'owner@a.test', password: 'a brand new password' })).status).toBe(200);
  });

  it('stores only a hash of each link', async () => {
    const created = await createTenantWithOwner(db, { businessName: 'B', ownerEmail: 'b@b.test', ownerName: 'B', trialDays: 30 });
    const stored = (await db.query('SELECT token_hash FROM user_tokens')).rows.map((r) => r.token_hash);
    expect(stored).not.toContain(created.token);
  });

  it('changing your password keeps this login and ends the others', async () => {
    const { agent, email } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const other = request.agent(app);
    await other.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);

    const wrong = await agent.post('/api/auth/password').send({ currentPassword: 'nope nope nope', newPassword: 'a brand new password' });
    expect(wrong.status).toBe(400);
    const weak = await agent.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);

    await agent.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: 'a brand new password' }).expect(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });
});

describe('roles', () => {
  it('only the owner manages the team, and staff can use the business data', async () => {
    const { agent, tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const invite = await agent.post('/api/team').send({ email: 'staff@a.test', name: 'Staff' });
    expect(invite.status).toBe(201);
    const staffAgent = request.agent(app);
    await staffAgent.post('/api/auth/accept').send({ token: tokenOf(invite.body.inviteUrl), password: PASSWORD }).expect(200);

    expect((await staffAgent.get('/api/team')).status).toBe(403);
    expect((await staffAgent.post('/api/team').send({ email: 'x@a.test', name: 'X' })).status).toBe(403);
    expect((await staffAgent.post('/api/products').send({ code: 'S', name: 'Staff product', shelfLifeDays: 5 })).status).toBe(201);
    expect((await agent.get('/api/team')).body).toHaveLength(2);

    // Owner cannot be switched off; duplicates are refused.
    const team = (await agent.get('/api/team')).body;
    const owner = team.find((u: any) => u.role === 'owner');
    expect((await agent.patch(`/api/team/${owner.id}`).send({ active: false })).status).toBe(400);
    expect((await agent.post('/api/team').send({ email: 'STAFF@a.test', name: 'Again' })).status).toBe(409);
    void tenantId;
  });

  it('only the owner can download the business data file, including after the business has lapsed (D-33)', async () => {
    const { agent, tenantId } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    const invite = await agent.post('/api/team').send({ email: 'staff@a.test', name: 'Staff' });
    const staffAgent = request.agent(app);
    await staffAgent.post('/api/auth/accept').send({ token: tokenOf(invite.body.inviteUrl), password: PASSWORD }).expect(200);
    await staffAgent.post('/api/products').send({ code: 'SECRET', name: 'Staff product', shelfLifeDays: 5 }).expect(201);

    const refused = await staffAgent.get('/api/export');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('Only the business owner can do this.');
    expect(refused.headers['content-disposition']).toBeUndefined();
    expect(refused.text).not.toContain('SECRET');

    const mine = await agent.get('/api/export');
    expect(mine.status).toBe(200);
    expect(mine.body.tables.products.map((p: any) => p.code)).toEqual(['SECRET']);

    // A lapsed business's owner keeps the right to the data; its staff still do not get the file.
    const lapsed = [
      `status = 'cancelled'`,
      `status = 'trial', trial_ends_on = CURRENT_DATE - 30`,
      `status = 'active', paid_through = CURRENT_DATE - 30`,
    ];
    for (const set of lapsed) {
      await db.query(`UPDATE tenants SET ${set} WHERE id = $1`, [tenantId]);
      expect((await agent.get('/api/auth/me')).body.tenant.access.level, set).toBe('read_only');
      expect((await agent.get('/api/export')).status, set).toBe(200);
      expect((await staffAgent.get('/api/export')).status, set).toBe(403);
      // The banner staff read must not promise a download they cannot make.
      const message = (await staffAgent.get('/api/auth/me')).body.tenant.access.message;
      expect(message, set).toMatch(/the owner can download it/);
      expect(message, set).not.toMatch(/view and download/);
    }
  });

  it('the admin account cannot use business data, and businesses cannot use admin pages', async () => {
    const admin = await createAdminAgent(app, db);
    const { agent } = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
    expect((await admin.get('/api/products')).status).toBe(403);
    expect((await admin.get('/api/export')).status).toBe(403);
    expect((await agent.get('/api/admin/tenants')).status).toBe(403);
    expect((await agent.post('/api/admin/tenants').send({})).status).toBe(403);
    expect((await admin.get('/api/admin/tenants')).status).toBe(200);
    expect((await admin.get('/api/auth/me')).body.tenant).toBeNull();
  });
});
