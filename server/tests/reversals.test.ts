import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replay, toSafeInteger } from '../src/calc/stock';
import { addDays, localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { scopedDb } from '../src/db/scoped';
import { acceptToken, inviteStaff } from '../src/services/accounts';
import { reverseEntry } from '../src/services/stockLedger';
import { type Agent, type App, PASSWORD, createAdminAgent, createBusiness, makeApp, openTestDb, resetData } from './helpers';

let db: Db;
let app: App;
let owner: Agent;
let staff: Agent;
let other: Agent;
let tenantId: number;
let scoped: Db;
let soy: number;

const today = () => localToday();
const day = (offset: number) => addDays(today(), offset);
const NOT_LATEST = 'Only the last entry made for this ingredient can be reversed. Use a count correction instead.';

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
  const b = await createBusiness(app, db, 'Other Foods', 'owner@b.test');
  [owner, other, tenantId] = [a.agent, b.agent, a.tenantId];
  scoped = scopedDb(db, tenantId);
  const invited = await inviteStaff(db, tenantId, { email: 'staff@a.test', name: 'Staff Member' });
  await acceptToken(db, invited.token, PASSWORD);
  staff = request.agent(app);
  await staff.post('/api/auth/login').send({ email: 'staff@a.test', password: PASSWORD }).expect(200);
  soy = await addIngredient('Soy sauce');
});
afterAll(async () => {
  await db?.close();
});

async function addIngredient(name: string): Promise<number> {
  return (await owner.post('/api/ingredients').send({ name, baseUnit: 'mL' }).expect(201)).body.id;
}

/** Buy, and answer with the new ledger line's id. */
const buy = async (quantity: string, totalCostCents: number, effectiveDate = today(), id = soy) =>
  (await owner.post(`/api/ingredients/${id}/purchases`).send({ effectiveDate, quantity, unit: 'mL', totalCostCents }).expect(201)).body.movementId as number;
const open = async (quantity: string, totalCostCents: number, effectiveDate = today(), id = soy) =>
  (await owner.post(`/api/ingredients/${id}/opening`).send({ effectiveDate, quantity, unit: 'mL', totalCostCents, reason: 'Opening balance' }).expect(201)).body.movementId as number;
const spill = async (quantity: string, effectiveDate = today()) =>
  (await owner.post(`/api/ingredients/${soy}/corrections`).send({ kind: 'spillage', effectiveDate, quantity, unit: 'mL', reason: 'Dropped' }).expect(201)).body.movementId as number;

const reverse = (movementId: number, fields: Record<string, unknown> = {}, id = soy, agent = owner) =>
  agent.post(`/api/ingredients/${id}/movements/${movementId}/reversal`).send({ reason: 'Wrong entry', ...fields });
const reversed = async (movementId: number, fields: Record<string, unknown> = {}) => (await reverse(movementId, fields).expect(201)).body;

async function stored(id = soy) {
  const r = (await scoped.query<any>('SELECT on_hand_milli, avg_cost_e4, avg_version FROM ingredients WHERE id = $1', [id])).rows[0];
  return {
    onHandMilli: toSafeInteger(r.on_hand_milli),
    avgE4: r.avg_cost_e4 === null ? null : toSafeInteger(r.avg_cost_e4),
    version: r.avg_version as number,
  };
}
async function lines(id = soy) {
  return (await scoped.query<any>(`SELECT *, effective_date::text AS day FROM stock_movements WHERE ingredient_id = $1 ORDER BY id`, [id])).rows;
}
async function expectCopyMatchesLedger(id = soy) {
  const { version: _version, ...cached } = await stored(id);
  const ledger = (await lines(id)).map((l) => ({
    id: l.id,
    kind: l.kind,
    effectiveDate: l.day,
    quantityMilli: toSafeInteger(l.quantity_milli),
    totalCostCents: l.total_cost_cents,
    reversesMovementId: l.reverses_movement_id,
  }));
  expect(cached).toEqual(replay(ledger));
}

describe('reversing a purchase (INV-16)', () => {
  it('undoes its effect on stock and the average, as if it had never been entered', async () => {
    await buy('1000', 10000);
    const wrong = await buy('1000', 90000);
    expect(await stored()).toMatchObject({ onHandMilli: 2_000_000, avgE4: 500_000 });
    const r = await reversed(wrong);
    expect(r.ingredient).toMatchObject({ onHandMilli: 1_000_000, avgCostE4: 100_000 });
    await expectCopyMatchesLedger();
  });

  it('records who, when and why, on a line dated as the purchase was', async () => {
    const wrong = await buy('250', 5000, day(-3));
    const r = await reversed(wrong, { reason: '  Entered twice \n by mistake ' });
    const line = (await lines())[1];
    expect(line.id).toBe(r.movementId);
    expect(line).toMatchObject({
      kind: 'purchase_reversal',
      day: day(-3),
      reverses_movement_id: wrong,
      reason: 'Entered twice \n by mistake',
      total_cost_cents: null,
      entered_by_name: 'Frozen Foods Owner',
    });
    expect(toSafeInteger(line.quantity_milli)).toBe(-250_000);
    expect(line.entered_by_user_id).toBeGreaterThan(0);
    expect(line.entered_at).toBeTruthy();
  });

  it('keeps the original line: nothing in the ledger is changed or deleted', async () => {
    const wrong = await buy('250', 5000);
    const before = (await lines())[0];
    await reversed(wrong);
    expect((await lines())[0]).toEqual(before);
    expect(await lines()).toHaveLength(2);
  });

  it('goes back to no average when the only purchase is reversed, and moves the version', async () => {
    const wrong = await buy('100', 1000);
    expect((await stored()).version).toBe(1);
    expect((await reversed(wrong)).ingredient).toMatchObject({ onHandMilli: 0, avgCostE4: null });
    expect(await stored()).toEqual({ onHandMilli: 0, avgE4: null, version: 2 });
  });

  it('does not move the version when the average comes out the same', async () => {
    await buy('100', 1000);
    const same = await buy('100', 1000);
    await reversed(same);
    expect(await stored()).toEqual({ onHandMilli: 100_000, avgE4: 100_000, version: 1 });
  });

  it('allows a new purchase afterwards, averaged as if the wrong one never happened', async () => {
    await buy('1000', 10000);
    await reversed(await buy('1000', 90000));
    await buy('1000', 30000);
    expect(await stored()).toMatchObject({ onHandMilli: 2_000_000, avgE4: 200_000 });
    await expectCopyMatchesLedger();
  });
});

describe('only the latest stock change (INV-16)', () => {
  it('refuses a purchase with a later entry after it', async () => {
    const first = await buy('100', 1000);
    await buy('100', 1000);
    const r = await reverse(first);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(NOT_LATEST);
    expect(await lines()).toHaveLength(2);
  });

  it('counts any kind of later line, not just purchases', async () => {
    const first = await buy('100', 1000);
    await spill('10');
    expect((await reverse(first)).body.error).toBe(NOT_LATEST);
  });

  it('allows a back-dated purchase that was the last entry made, so a mistyped price can be undone (D-45)', async () => {
    await buy('1000', 10000, day(-10));
    await buy('1000', 10000, day(-1));
    const typo = await buy('1000', 1_000_000, day(-5)); // P10,000 typed instead of P100
    expect((await stored()).avgE4).toBe(3_400_000);
    const r = await reversed(typo);
    expect(r.ingredient).toMatchObject({ onHandMilli: 2_000_000, avgCostE4: 100_000 });
    await buy('1000', 10000, day(-5));
    expect(await stored()).toMatchObject({ onHandMilli: 3_000_000, avgE4: 100_000 });
    await expectCopyMatchesLedger();
  });

  it('refuses a purchase that is the latest by date but not the last entry made', async () => {
    const latestDated = await buy('100', 1000, day(-1));
    await buy('100', 1000, day(-5));
    expect((await reverse(latestDated)).body.error).toBe(NOT_LATEST);
  });

  it('allows a purchase dated the same day as the latest line, if it was entered last', async () => {
    await spill('10', day(-2));
    const same = await buy('100', 1000, day(-2));
    await reversed(same);
  });

  it('does not count lines already undone, so entries can be undone one after another', async () => {
    const first = await buy('100', 1000);
    const second = await buy('100', 3000);
    await reversed(second);
    await reversed(first);
    expect(await stored()).toMatchObject({ onHandMilli: 0, avgE4: null });
    await expectCopyMatchesLedger();
  });

  it('does not count a later-dated line that was undone', async () => {
    const earlier = await buy('100', 1000, day(-5));
    const later = await buy('100', 3000, day(-1));
    await reversed(later);
    await reversed(earlier);
    expect(await stored()).toMatchObject({ onHandMilli: 0, avgE4: null });
  });
});

describe('reversing an opening balance (Q51, D-42)', () => {
  it('lets a wrong opening be reversed and entered again', async () => {
    const wrong = await open('1000', 999000);
    await reversed(wrong);
    expect(await stored()).toMatchObject({ onHandMilli: 0, avgE4: null });
    await open('1000', 10000);
    expect(await stored()).toMatchObject({ onHandMilli: 1_000_000, avgE4: 100_000 });
    await expectCopyMatchesLedger();
  });

  it('allows it when it was the last entry made, even with a purchase dated later (D-42)', async () => {
    await buy('100', 1000, today());
    const wrong = await open('100', 99000, day(-7));
    expect((await stored()).avgE4).not.toBe(100_000);
    const r = await reversed(wrong);
    expect(r.ingredient).toMatchObject({ onHandMilli: 100_000, avgCostE4: 100_000 });
    const right = await open('100', 3000, day(-7));
    expect(right).toBeGreaterThan(0);
    expect(await stored()).toMatchObject({ onHandMilli: 200_000, avgE4: 200_000 });
    await expectCopyMatchesLedger();
  });

  it('allows it whatever kind of line is dated later, and restores the figures from before it', async () => {
    await buy('1000', 10000, day(-9));
    await spill('100', day(-1));
    const before = await stored();
    const wrong = await open('500', 99000, day(-5));
    expect((await stored()).avgE4).not.toBe(before.avgE4);
    await reversed(wrong);
    expect(await stored()).toMatchObject({ onHandMilli: before.onHandMilli, avgE4: before.avgE4 });
    await expectCopyMatchesLedger();
  });

  it('refuses it once another entry has been made after it', async () => {
    const opening = await open('100', 1000, day(-7));
    await buy('100', 1000);
    const r = await reverse(opening);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(NOT_LATEST);
  });

  it('refuses it when a later entry is dated earlier', async () => {
    const opening = await open('100', 1000, day(-2));
    await spill('10', day(-5));
    expect((await reverse(opening)).body.error).toBe(NOT_LATEST);
  });
});

describe('what cannot be reversed', () => {
  it('refuses a line already reversed, and a reversal itself', async () => {
    const wrong = await buy('100', 1000);
    const undo = (await reversed(wrong)).movementId;
    const again = await reverse(wrong);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This entry has already been reversed.');
    const ofReversal = await reverse(undo);
    expect(ofReversal.status).toBe(400);
    expect(ofReversal.body.error).toBe('Only a purchase or an opening balance can be reversed.');
    expect(await lines()).toHaveLength(2);
  });

  it('refuses spillage, spoilage and count corrections, which are not this kind of mistake', async () => {
    await open('1000', 10000);
    for (const [kind, quantity] of [['spillage', '5'], ['spoilage', '5'], ['count_correction', '900']] as const) {
      const line = (await owner.post(`/api/ingredients/${soy}/corrections`).send({ kind, effectiveDate: today(), quantity, unit: 'mL', reason: 'x' }).expect(201)).body.movementId;
      const r = await reverse(line);
      expect(r.status, kind).toBe(400);
      expect(r.body.error).toBe('Only a purchase or an opening balance can be reversed.');
    }
  });

  it('needs a reason, and refuses hidden characters', async () => {
    const wrong = await buy('100', 1000);
    for (const reason of ['', '   ', '\n\t', undefined, 5, 'a\u0000b', 'a​b', 'x'.repeat(301)]) {
      expect((await reverse(wrong, { reason })).status, JSON.stringify(reason)?.slice(0, 20)).toBe(400);
    }
    expect(await lines()).toHaveLength(1);
    await reversed(wrong, { reason: 'x'.repeat(300) });
  });

  it('takes nothing but the reason from the request', async () => {
    const wrong = await buy('100', 1000, day(-3));
    await reversed(wrong, { quantityMilli: 5, effectiveDate: today(), reversesMovementId: 1, kind: 'purchase', enteredByName: 'Someone', tenantId: 999 });
    expect((await lines())[1]).toMatchObject({ kind: 'purchase_reversal', day: day(-3), reverses_movement_id: wrong, entered_by_name: 'Frozen Foods Owner', tenant_id: tenantId });
    expect(toSafeInteger((await lines())[1].quantity_milli)).toBe(-100_000);
  });
});

describe('archived ingredients (Q50)', () => {
  it('can still be corrected this way', async () => {
    const wrong = await buy('100', 1000);
    await owner.patch(`/api/ingredients/${soy}`).send({ active: false }).expect(200);
    await reversed(wrong);
    expect((await stored()).onHandMilli).toBe(0);
  });
});

describe('with other stock lines', () => {
  it('leaves a count correct afterwards: the pair adds up to nothing', async () => {
    await buy('1000', 10000);
    await reversed(await buy('500', 5000));
    const r = await owner.post(`/api/ingredients/${soy}/corrections`).send({ kind: 'count_correction', effectiveDate: today(), quantity: '990', unit: 'mL', reason: 'Counted' });
    expect(r.status).toBe(201);
    expect(toSafeInteger((await lines())[3].quantity_milli)).toBe(-10_000);
  });

  it('leaves other ingredients alone', async () => {
    const vinegar = await addIngredient('Vinegar');
    await buy('100', 5000, today(), vinegar);
    await reversed(await buy('100', 1000));
    expect(await stored(vinegar)).toMatchObject({ onHandMilli: 100_000, avgE4: 500_000, version: 1 });
  });
});

describe('who can do this (INV-14)', () => {
  it('refuses staff, even for a purchase they entered, with nothing stored', async () => {
    const line = (await staff.post(`/api/ingredients/${soy}/purchases`).send({ effectiveDate: today(), quantity: '100', unit: 'mL', totalCostCents: 1000 }).expect(201)).body.movementId;
    const r = await reverse(line, {}, soy, staff);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Only the business owner can do this.');
    expect(await lines()).toHaveLength(1);
  });

  it('refuses anyone not signed in and the admin account', async () => {
    const wrong = await buy('100', 1000);
    const admin = await createAdminAgent(app, db);
    expect((await request(app).post(`/api/ingredients/${soy}/movements/${wrong}/reversal`).send({ reason: 'x' })).status).toBe(401);
    expect((await admin.post(`/api/ingredients/${soy}/movements/${wrong}/reversal`).send({ reason: 'x' })).status).toBe(403);
  });

  it('refuses a lapsed or suspended business, and staff are told it is the owner\'s to do', async () => {
    const wrong = await buy('100', 1000);
    await db.query(`UPDATE tenants SET status = 'cancelled' WHERE id = $1`, [tenantId]);
    expect((await reverse(wrong)).status).toBe(402);
    expect((await reverse(wrong, {}, soy, staff)).status).toBe(403);
    await db.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [tenantId]);
    expect((await reverse(wrong)).body.code).toBe('suspended');
    expect(await lines()).toHaveLength(1);
  });
});

describe('one business cannot reverse another\'s line', () => {
  it('answers "not found", and nothing changes', async () => {
    const wrong = await buy('100', 1000);
    const r = await reverse(wrong, {}, soy, other);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Ingredient not found');
    expect(await lines()).toHaveLength(1);
  });

  it('cannot reach a line through its own ingredient', async () => {
    const wrong = await buy('100', 1000);
    const theirs = (await other.post('/api/ingredients').send({ name: 'Theirs', baseUnit: 'mL' }).expect(201)).body.id;
    const r = await reverse(wrong, {}, theirs, other);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Stock entry not found');
    expect(await lines()).toHaveLength(1);
  });

  it('answers "not found" for a line of another ingredient, or one that does not exist', async () => {
    const vinegar = await addIngredient('Vinegar');
    const wrong = await buy('100', 1000);
    expect((await reverse(wrong, {}, vinegar)).body.error).toBe('Stock entry not found');
    expect((await reverse(9999)).status).toBe(404);
    expect((await reverse(wrong, {}, 9999)).status).toBe(404);
  });

  it('answers plainly for ids that are not valid', async () => {
    expect((await owner.post(`/api/ingredients/${soy}/movements/abc/reversal`).send({ reason: 'x' })).status).toBe(400);
    expect((await owner.post(`/api/ingredients/abc/movements/1/reversal`).send({ reason: 'x' })).status).toBe(400);
    expect((await owner.post(`/api/ingredients/${soy}/movements/2147483648/reversal`).send({ reason: 'x' })).status).toBe(400);
  });
});

describe('order of work inside the save (design note 4, rule 1)', () => {
  it('takes the lock before reading the ledger', async () => {
    const seen: string[] = [];
    const q = {
      query: async (text: string) => {
        seen.push(text);
        if (text.includes('FOR NO KEY UPDATE')) return { rows: [{ id: 1, base_unit: 'g', active: true, on_hand_milli: '0', avg_cost_e4: null }] };
        return { rows: [] };
      },
    };
    const fake = { tx: async (fn: any) => fn(q) } as unknown as Db;
    await expect(reverseEntry(fake, 1, 7, { reason: 'x' }, { id: 1, name: 'Owner' })).rejects.toThrow('Stock entry not found');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('FOR NO KEY UPDATE');
    expect(seen[1]).toContain('FROM stock_movements');
  });
});
