import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replay, toSafeInteger } from '../src/calc/stock';
import { localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { acceptToken, inviteStaff } from '../src/services/accounts';
import { type Agent, type App, PASSWORD, createAdminAgent, createBusiness, makeApp, openTestDb, resetData } from './helpers';

// The owner corrects a purchase's supplier, reference or expiry date (INV-17, design note 1.5).

let db: Db;
let app: App;
let owner: Agent;
let staff: Agent;
let other: Agent;
let scoped: Db;
let soy: number;
let flour: number;
let ownerId: number;
let tenantId: number;

const today = () => localToday();
const NOTHING = 'Nothing to change: these details are the same as the ones already saved.';

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
  const b = await createBusiness(app, db, 'Other Foods', 'owner@b.test');
  [owner, other] = [a.agent, b.agent];
  tenantId = a.tenantId;
  scoped = scopedDb(db, a.tenantId);
  const invited = await inviteStaff(db, a.tenantId, { email: 'staff@a.test', name: 'Staff Member' });
  await acceptToken(db, invited.token, PASSWORD);
  staff = request.agent(app);
  await staff.post('/api/auth/login').send({ email: 'staff@a.test', password: PASSWORD }).expect(200);
  soy = await addIngredient('Soy sauce');
  flour = await addIngredient('Flour');
  ownerId = (await owner.get('/api/auth/me').expect(200)).body.user.id;
});
afterAll(async () => {
  await db?.close();
});

async function addIngredient(name: string): Promise<number> {
  return (await owner.post('/api/ingredients').send({ name, baseUnit: 'mL' }).expect(201)).body.id;
}

const buy = async (fields: Record<string, unknown> = {}, id = soy) =>
  (
    await owner
      .post(`/api/ingredients/${id}/purchases`)
      .send({ effectiveDate: today(), quantity: '1000', unit: 'mL', totalCostCents: 10000, supplier: 'Mang Tony', reference: 'OR-7', expiryDate: '2027-03-01', ...fields })
      .expect(201)
  ).body.movementId as number;

const correct = (movementId: number, fields: Record<string, unknown> = {}, id = soy, agent = owner) =>
  agent.patch(`/api/ingredients/${id}/movements/${movementId}/details`).send({ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: '2027-03-01', ...fields });

const audit = async () =>
  (await scoped.query<any>(`SELECT movement_id, supplier, reference, expiry_date::text AS expiry_date, changed_by_user_id, changed_by_name, changed_at FROM purchase_detail_changes ORDER BY id`)).rows;
const history = async () => (await owner.get(`/api/ingredients/${soy}/movements`).expect(200)).body;

async function figures(id = soy) {
  const i = (await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4, avg_version FROM ingredients WHERE id = $1', [id])).rows[0];
  const lines = (await scoped.query<any>(
    `SELECT id, kind, quantity_milli, total_cost_cents, effective_date::text AS day, reverses_movement_id FROM stock_movements WHERE ingredient_id = $1 ORDER BY id`,
    [id],
  )).rows;
  return { i, lines };
}

describe('correcting a purchase\'s details', () => {
  it('corrects the supplier alone, keeping the value from before in exactly one audit row', async () => {
    const id = await buy();
    const res = await correct(id, { supplier: 'Aling Rosa' }).expect(200);
    expect(res.body).toMatchObject({ id, kind: 'purchase', supplier: 'Aling Rosa', reference: 'OR-7', expiryDate: '2027-03-01' });
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      movement_id: id, supplier: 'Mang Tony', reference: 'OR-7', expiry_date: '2027-03-01', changed_by_user_id: ownerId,
    });
    expect(rows[0].changed_by_name).toBe((await owner.get('/api/auth/me')).body.user.name.trim() || 'owner@a.test');
    expect(Math.abs(Date.now() - new Date(rows[0].changed_at).getTime())).toBeLessThan(5 * 60_000);
  });

  it('corrects the reference alone', async () => {
    const id = await buy();
    const res = await correct(id, { reference: 'OR-8' }).expect(200);
    expect(res.body).toMatchObject({ supplier: 'Mang Tony', reference: 'OR-8', expiryDate: '2027-03-01' });
    expect(await audit()).toMatchObject([{ supplier: 'Mang Tony', reference: 'OR-7', expiry_date: '2027-03-01' }]);
  });

  it('corrects the expiry date alone', async () => {
    const id = await buy();
    const res = await correct(id, { expiryDate: '2027-04-15' }).expect(200);
    expect(res.body).toMatchObject({ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: '2027-04-15' });
    expect(await audit()).toMatchObject([{ supplier: 'Mang Tony', reference: 'OR-7', expiry_date: '2027-03-01' }]);
  });

  it('writes one audit row per correction, oldest first, each holding the values before it', async () => {
    const id = await buy();
    await correct(id, { supplier: 'Aling Rosa' }).expect(200);
    await correct(id, { supplier: 'Aling Rosa', reference: 'OR-9' }).expect(200);
    await correct(id, { supplier: 'Aling Rosa', reference: 'OR-9', expiryDate: null }).expect(200);
    const rows = await audit();
    expect(rows.map((r) => [r.supplier, r.reference, r.expiry_date])).toEqual([
      ['Mang Tony', 'OR-7', '2027-03-01'],
      ['Aling Rosa', 'OR-7', '2027-03-01'],
      ['Aling Rosa', 'OR-9', '2027-03-01'],
    ]);
  });

  it('clears the expiry date to null, and a purchase with no expiry can be given one', async () => {
    const id = await buy();
    expect((await correct(id, { expiryDate: null }).expect(200)).body.expiryDate).toBeNull();
    expect((await correct(id, { expiryDate: '2027-05-05' }).expect(200)).body.expiryDate).toBe('2027-05-05');
    expect((await audit()).map((r) => r.expiry_date)).toEqual(['2027-03-01', null]);
  });

  it('needs all three fields: a missing one is a 400 and nothing changes', async () => {
    const id = await buy();
    const patch = (body: Record<string, unknown>) => owner.patch(`/api/ingredients/${soy}/movements/${id}/details`).send(body);
    const full = { supplier: 'Aling Rosa', reference: 'OR-8', expiryDate: '2027-04-01' };
    const asked: Record<string, string> = {
      supplier: 'supplier: Send the supplier (empty text if there is none)',
      reference: 'reference: Send the reference (empty text if there is none)',
      expiryDate: 'expiryDate: Send the expiry date (null if there is none)',
    };
    for (const key of Object.keys(full)) {
      const { [key]: _left, ...rest } = full as Record<string, unknown>;
      expect((await patch(rest).expect(400)).body.error).toBe(asked[key]);
    }
    expect((await patch({}).expect(400)).body.error).toBe(asked.supplier);
    expect(await audit()).toHaveLength(0);
    expect((await history()).movements[0]).toMatchObject({ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: '2027-03-01' });
    // Empty text and a null expiry are fine when sent.
    const ok = await patch({ supplier: '', reference: '', expiryDate: null }).expect(200);
    expect(ok.body).toMatchObject({ supplier: '', reference: '', expiryDate: null });
  });

  it('trims the text, and refuses one that is over 120 characters or hides characters', async () => {
    const id = await buy();
    expect((await correct(id, { supplier: '  Aling Rosa  ' }).expect(200)).body.supplier).toBe('Aling Rosa');
    expect((await correct(id, { supplier: 'x'.repeat(120) }).expect(200)).body.supplier).toHaveLength(120);
    expect((await correct(id, { supplier: 'x'.repeat(121) }).expect(400)).body.error).toBe('supplier: At most 120 characters');
    expect((await correct(id, { reference: 'y'.repeat(121) }).expect(400)).body.error).toBe('reference: At most 120 characters');
    // A purchase answers the same, so the two cannot drift apart.
    const tooLong = await owner.post(`/api/ingredients/${soy}/purchases`).send({ effectiveDate: today(), quantity: '1', unit: 'mL', totalCostCents: 100, supplier: 'x'.repeat(121) }).expect(400);
    expect(tooLong.body.error).toBe('supplier: At most 120 characters');
    await correct(id, { reference: 'bad\u0000text' }).expect(400);
    await correct(id, { expiryDate: '2027-02-30' }).expect(400);
    await correct(id, { expiryDate: 'tomorrow' }).expect(400);
    expect(await audit()).toHaveLength(2); // only the two good ones
  });

  it('refuses when nothing changes, with a plain 400 and no audit row', async () => {
    const id = await buy();
    expect((await correct(id).expect(400)).body.error).toBe(NOTHING);
    // Spaces around the same text are the same text.
    await correct(id, { supplier: '  Mang Tony ' }).expect(400);
    expect(await audit()).toHaveLength(0);
    const empty = await buy({ supplier: '', reference: '', expiryDate: null });
    await correct(empty, { supplier: '', reference: '', expiryDate: null }).expect(400);
    expect(await audit()).toHaveLength(0);
  });

  it('never changes quantity, price, stock or the average', async () => {
    await buy({ quantity: '500', totalCostCents: 6000 });
    const id = await buy({ quantity: '1000', totalCostCents: 90000 });
    const before = await figures();
    await correct(id, { supplier: 'Aling Rosa', reference: '', expiryDate: null }).expect(200);
    const after = await figures();
    expect(after).toEqual(before); // on hand, average, average version and every line's quantity, cost and date
    const ledger = after.lines.map((l) => ({
      id: l.id, kind: l.kind, effectiveDate: l.day, quantityMilli: toSafeInteger(l.quantity_milli), totalCostCents: l.total_cost_cents, reversesMovementId: l.reverses_movement_id,
    }));
    expect({ onHandMilli: toSafeInteger(after.i.on_hand_milli), avgE4: toSafeInteger(after.i.avg_cost_e4) }).toEqual(replay(ledger));
    const h = await history();
    expect(h.ingredient).toMatchObject({ onHandMilli: 1_500_000 });
    expect(h.movements.find((m: any) => m.id === id)).toMatchObject({ quantityMilli: 1_000_000, totalCostCents: 90000 });
  });

  it('ignores quantity and price if they are sent: they are never applied', async () => {
    const id = await buy();
    const before = await figures();
    await correct(id, { supplier: 'Aling Rosa', quantityMilli: 5, totalCostCents: 1, quantity: '9' }).expect(200);
    expect((await figures()).lines).toEqual(before.lines);
  });
});

describe('what cannot be corrected', () => {
  it('refuses a line that is not a purchase', async () => {
    const opening = (
      await owner.post(`/api/ingredients/${flour}/opening`).send({ effectiveDate: today(), quantity: '100', unit: 'mL', totalCostCents: 1000, reason: 'Opening balance' }).expect(201)
    ).body.movementId;
    const spill = (
      await owner.post(`/api/ingredients/${flour}/corrections`).send({ kind: 'spillage', effectiveDate: today(), quantity: '1', unit: 'mL', reason: 'Dropped' }).expect(201)
    ).body.movementId;
    const spoil = (
      await owner.post(`/api/ingredients/${flour}/corrections`).send({ kind: 'spoilage', effectiveDate: today(), quantity: '1', unit: 'mL', reason: 'Went off' }).expect(201)
    ).body.movementId;
    const count = (
      await owner.post(`/api/ingredients/${flour}/corrections`).send({ kind: 'count_correction', effectiveDate: today(), quantity: '50', unit: 'mL', reason: 'Count' }).expect(201)
    ).body.movementId;
    for (const id of [opening, spill, spoil, count]) {
      const res = await correct(id, { supplier: 'Aling Rosa' }, flour).expect(400);
      expect(res.body.error).toBe('Only the details of a purchase can be corrected.');
    }
    expect(await audit()).toHaveLength(0);
  });

  it('refuses a reversed purchase, and the reversal line itself', async () => {
    const id = await buy();
    const reversal = (await owner.post(`/api/ingredients/${soy}/movements/${id}/reversal`).send({ reason: 'Wrong entry' }).expect(201)).body.movementId;
    const res = await correct(id, { supplier: 'Aling Rosa' }).expect(409);
    expect(res.body.error).toBe('This purchase has been reversed, so its details can no longer be corrected.');
    await correct(reversal, { supplier: 'Aling Rosa' }).expect(400);
    expect(await audit()).toHaveLength(0);
  });

  it('still lets the owner correct a purchase after later entries, and on an archived ingredient', async () => {
    const id = await buy();
    await buy({ supplier: 'Later' });
    await owner.patch(`/api/ingredients/${soy}`).send({ active: false }).expect(200);
    await correct(id, { supplier: 'Aling Rosa' }).expect(200);
  });

  it('gives staff 403 and writes nothing', async () => {
    const id = await buy();
    const res = await correct(id, { supplier: 'Aling Rosa' }, soy, staff).expect(403);
    expect(res.body.error).toBe('Only the business owner can do this.');
    expect(await audit()).toHaveLength(0);
    expect((await history()).movements[0]).toMatchObject({ supplier: 'Mang Tony' });
  });

  it('needs a login', async () => {
    const id = await buy();
    await request(app).patch(`/api/ingredients/${soy}/movements/${id}/details`).send({ supplier: 'x' }).expect(401);
  });

  it("says not found for another business's ingredient and movement, and for a movement of another ingredient", async () => {
    const id = await buy();
    const flourBuy = await buy({}, flour);
    await correct(id, { supplier: 'Hacked' }, soy, other).expect(404);
    await correct(flourBuy, { supplier: 'Hacked' }, soy).expect(404); // flour's line under soy's id
    await correct(id, { supplier: 'Hacked' }, flour).expect(404); // soy's line under flour's id
    await correct(999_999, { supplier: 'Hacked' }).expect(404);
    await correct(id, { supplier: 'Hacked' }, 999_999).expect(404);
    expect(await audit()).toHaveLength(0);
    expect((await history()).movements[0]).toMatchObject({ supplier: 'Mang Tony' });
  });

  it('says 400 for an id that is not valid, even with a full valid body', async () => {
    const id = await buy();
    const valid = { supplier: 'Aling Rosa', reference: 'OR-8', expiryDate: '2027-04-01' };
    for (const [ingredient, movement] of [['abc', id], [soy, 'abc'], [soy, 0], [soy, '1.5'], [soy, 2147483648], [2147483648, id]]) {
      const res = await owner.patch(`/api/ingredients/${ingredient}/movements/${movement}/details`).send(valid).expect(400);
      expect(res.body.error).toBe('Invalid id');
    }
    expect(await audit()).toHaveLength(0);
  });

  it("answers 404 'Stock entry not found' when business B uses its own ingredient with business A's movement", async () => {
    const id = await buy();
    const theirs = (await other.post('/api/ingredients').send({ name: 'Theirs', baseUnit: 'mL' }).expect(201)).body.id;
    const res = await correct(id, { supplier: 'Hacked' }, theirs, other).expect(404);
    expect(res.body.error).toBe('Stock entry not found');
    expect(await audit()).toHaveLength(0);
  });
});

describe('the write guard and the account kinds', () => {
  const unchanged = async (id: number) => {
    expect(await audit()).toHaveLength(0);
    expect((await history()).movements.find((m: any) => m.id === id)).toMatchObject({ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: '2027-03-01' });
  };

  it('refuses a cancelled business with 402 and a suspended one with code suspended, and changes nothing', async () => {
    const id = await buy();
    await db.query(`UPDATE tenants SET status = 'cancelled' WHERE id = $1`, [tenantId]);
    expect((await correct(id, { supplier: 'Aling Rosa' })).status).toBe(402);
    await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);
    expect((await correct(id, { supplier: 'Aling Rosa' })).body.code).toBe('suspended');
    await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenantId]);
    await unchanged(id);
  });

  it('refuses the admin account with 403, and staff with 403, and changes nothing', async () => {
    const id = await buy();
    const admin = await createAdminAgent(app, db);
    expect((await correct(id, { supplier: 'Aling Rosa' }, soy, admin)).status).toBe(403);
    expect((await correct(id, { supplier: 'Aling Rosa' }, soy, staff)).status).toBe(403);
    await unchanged(id);
  });

  it('changes only the target line: other purchases keep their details and have no audit rows', async () => {
    const target = await buy();
    const sameIngredient = await buy({ supplier: 'Second', reference: 'OR-2', expiryDate: '2027-06-01' });
    const otherIngredient = await buy({ supplier: 'Third', reference: 'OR-3', expiryDate: '2027-07-01' }, flour);
    await correct(target, { supplier: 'Aling Rosa', reference: '', expiryDate: null }).expect(200);
    const rows = (await scoped.query<any>(`SELECT id, supplier, reference, expiry_date::text AS expiry_date FROM stock_movements ORDER BY id`)).rows;
    expect(rows).toEqual([
      { id: target, supplier: 'Aling Rosa', reference: '', expiry_date: null },
      { id: sameIngredient, supplier: 'Second', reference: 'OR-2', expiry_date: '2027-06-01' },
      { id: otherIngredient, supplier: 'Third', reference: 'OR-3', expiry_date: '2027-07-01' },
    ]);
    expect((await audit()).map((r) => r.movement_id)).toEqual([target]);
  });
});

describe('the history shows the corrections', () => {
  it('lists each purchase\'s earlier values, oldest first, with who and when; other lines get an empty list', async () => {
    const id = await buy();
    const untouched = await buy({ supplier: 'Later' });
    await correct(id, { supplier: 'Aling Rosa' }).expect(200);
    await correct(id, { supplier: 'Aling Rosa', expiryDate: null }).expect(200);
    const h = await history();
    const line = h.movements.find((m: any) => m.id === id);
    expect(line).toMatchObject({ supplier: 'Aling Rosa', reference: 'OR-7', expiryDate: null });
    expect(line.detailChanges).toHaveLength(2);
    expect(line.detailChanges[0]).toMatchObject({ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: '2027-03-01', changedByName: expect.any(String) });
    expect(line.detailChanges[1]).toMatchObject({ supplier: 'Aling Rosa', reference: 'OR-7', expiryDate: '2027-03-01' });
    expect(typeof line.detailChanges[0].changedAt).toBe('string');
    expect(h.movements.find((m: any) => m.id === untouched).detailChanges).toEqual([]);
  });

  it('answers the correction with the line in the same shape the history uses', async () => {
    const id = await buy();
    const res = await correct(id, { reference: 'OR-8' }).expect(200);
    const fromHistory = (await history()).movements.find((m: any) => m.id === id);
    expect(res.body).toEqual(fromHistory);
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(['unitPriceE4', 'onHandAfterMilli', 'averageAfterE4', 'detailChanges', 'enteredByName']));
  });

  it('does not show one business\'s corrections to another', async () => {
    const id = await buy();
    await correct(id, { supplier: 'Aling Rosa' }).expect(200);
    const b = (await other.post('/api/ingredients').send({ name: 'Soy sauce', baseUnit: 'mL' }).expect(201)).body.id;
    const h = (await other.get(`/api/ingredients/${b}/movements`).expect(200)).body;
    expect(h.movements).toEqual([]);
  });
});
