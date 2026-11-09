import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, localToday } from '../src/dates';
import type { Db } from '../src/db/index';
import { acceptToken, inviteStaff } from '../src/services/accounts';
import { countsOutOfDate, needsRecountDate } from '../src/services/stockHistory';
import { type Agent, type App, PASSWORD, createBusiness, makeApp, openTestDb, resetData } from './helpers';

// GET /api/ingredients/:id/movements (P4-13): the price history and the stock changes, owner only.

let db: Db;
let app: App;
let owner: Agent;
let staff: Agent;
let other: Agent;
let soy: number;

const day = (offset: number) => addDays(localToday(), offset);

beforeAll(async () => {
  db = await openTestDb();
  app = makeApp(db);
});
beforeEach(async () => {
  await resetData(db);
  const a = await createBusiness(app, db, 'Frozen Foods', 'owner@a.test');
  const b = await createBusiness(app, db, 'Other Foods', 'owner@b.test');
  [owner, other] = [a.agent, b.agent];
  const invited = await inviteStaff(db, a.tenantId, { email: 'staff@a.test', name: 'Staff Member' });
  await acceptToken(db, invited.token, PASSWORD);
  staff = request.agent(app);
  await staff.post('/api/auth/login').send({ email: 'staff@a.test', password: PASSWORD }).expect(200);
  soy = (await owner.post('/api/ingredients').send({ name: 'Soy sauce', baseUnit: 'mL' }).expect(201)).body.id;
});
afterAll(async () => {
  await db?.close();
});

const buy = async (quantity: string, totalCostCents: number, effectiveDate: string) =>
  (await owner.post(`/api/ingredients/${soy}/purchases`).send({ effectiveDate, quantity, unit: 'mL', totalCostCents }).expect(201)).body.movementId as number;
const open = async (quantity: string, totalCostCents: number, effectiveDate: string) =>
  (await owner.post(`/api/ingredients/${soy}/opening`).send({ effectiveDate, quantity, unit: 'mL', totalCostCents, reason: 'Opening balance' }).expect(201)).body.movementId as number;
const correct = async (kind: string, quantity: string, effectiveDate: string, reason = 'Because') =>
  (await owner.post(`/api/ingredients/${soy}/corrections`).send({ kind, effectiveDate, quantity, unit: 'mL', reason }).expect(201)).body.movementId as number;
const reverse = (movementId: number) => owner.post(`/api/ingredients/${soy}/movements/${movementId}/reversal`).send({ reason: 'Wrong entry' });
const history = async () => (await owner.get(`/api/ingredients/${soy}/movements`).expect(200)).body;
const byId = (h: any, id: number) => h.movements.find((m: any) => m.id === id);

const count = (quantity: string, effectiveDate: string) =>
  owner.post(`/api/ingredients/${soy}/corrections`).send({ kind: 'count_correction', effectiveDate, quantity, unit: 'mL', reason: 'Count' });
/** needsRecount of every line, by id, so each test checks all of them and not only the back-dated one. */
const notices = async () => Object.fromEntries((await history()).movements.map((m: any) => [m.id, m.needsRecount]));

describe('what a save answers', () => {
  it('gives the stored change: the difference for a count, minus the amount for a loss, plus the amount for an opening', async () => {
    const opening = (await owner.post(`/api/ingredients/${soy}/opening`).send({ effectiveDate: day(-9), quantity: '1.5', unit: 'L', totalCostCents: 9000, reason: 'Start' }).expect(201)).body;
    expect(opening).toMatchObject({ quantityMilli: 1_500_000, ingredient: { onHandMilli: 1_500_000 } });
    const counted = (await count('1200', day(-3)).expect(201)).body;
    expect(counted).toMatchObject({ quantityMilli: -300_000, ingredient: { onHandMilli: 1_200_000 } });
    const lost = (await owner.post(`/api/ingredients/${soy}/corrections`).send({ kind: 'spoilage', effectiveDate: day(-1), quantity: '200', unit: 'mL', reason: 'Off' }).expect(201)).body;
    expect(lost).toMatchObject({ quantityMilli: -200_000, ingredient: { onHandMilli: 1_000_000 } });
    const h = await history();
    for (const r of [opening, counted, lost]) expect(byId(h, r.movementId).quantityMilli).toBe(r.quantityMilli);
    // A reversal answers with its own change too.
    const p = await buy('100', 1000, day(-1));
    expect((await reverse(p).expect(201)).body.quantityMilli).toBe(-100_000);
  });
});

describe('the movements endpoint', () => {
  // Worked by hand (mL; quantities in milli, averages in e4 = 1/10,000 centavo per mL):
  //   A  buy 1000 mL, P100  dated -10, entered 1st.  own price 10000c x 10^7 / 1,000,000 = 100,000
  //   B  buy 1000 mL, P600  dated  -2, entered 2nd.  own price 600,000
  //   C  buy 1000 mL, P200  dated  -6, entered 3rd (back-dated). own price 200,000
  //   K  count 1800 mL      dated  -4, entered 4th.  On hand at end of -4 is A + C = 2000, so it stores -200 mL
  //   S  spillage 500 mL    dated  -1, entered 5th.
  // Order by date: A(-10), C(-6), K(-4), B(-2), S(-1).
  //   A: on hand 1,000,000, average 100,000
  //   C: on hand 2,000,000, average (1,000,000 x 100,000 + 20,000 x 10^7) / 2,000,000 = 3 x 10^11 / 2 x 10^6 = 150,000
  //   K: on hand 1,800,000, average 150,000 (a count changes on hand only)
  //   B: on hand 2,800,000, average (1,800,000 x 150,000 + 60,000 x 10^7) / 2,800,000 = 8.7 x 10^11 / 2.8 x 10^6 = 310,714.28 -> 310,714
  //   S: on hand 2,300,000, average 310,714
  // Had B come before C (no back-dating) B's average would have been (10^11 + 6 x 10^11) / 2 x 10^6 = 350,000.
  it('gives every line with the average and on hand after it, worked out in date order', async () => {
    const a = await buy('1000', 10000, day(-10));
    const b = await buy('1000', 60000, day(-2));
    expect(byId(await history(), b).averageAfterE4).toBe(350_000);
    const c = await buy('1000', 20000, day(-6));
    const k = await correct('count_correction', '1800', day(-4), 'Monthly count');
    const s = await correct('spillage', '500', day(-1), 'Dropped');

    const h = await history();
    expect(h.movements.map((m: any) => m.id)).toEqual([a, c, k, b, s]);
    const figures = h.movements.map((m: any) => [m.quantityMilli, m.onHandAfterMilli, m.averageAfterE4]);
    expect(figures).toEqual([
      [1_000_000, 1_000_000, 100_000],
      [1_000_000, 2_000_000, 150_000],
      [-200_000, 1_800_000, 150_000],
      [1_000_000, 2_800_000, 310_714],
      [-500_000, 2_300_000, 310_714],
    ]);
    expect(h.movements.map((m: any) => m.unitPriceE4)).toEqual([100_000, 200_000, null, 600_000, null]);
    expect(h.movements.map((m: any) => m.totalCostCents)).toEqual([10000, 20000, null, 60000, null]);
    expect(byId(h, k)).toMatchObject({ kind: 'count_correction', reason: 'Monthly count', effectiveDate: day(-4), enteredByName: 'Frozen Foods Owner' });
    expect(byId(h, s)).toMatchObject({ kind: 'spillage', reason: 'Dropped' });
    expect(byId(h, a).enteredAt).toBeTruthy();
    // The header agrees with the last line, and is the same copy the list shows.
    expect(h.ingredient).toMatchObject({ id: soy, name: 'Soy sauce', onHandMilli: 2_300_000, avgCostE4: 310_714, lastCountDate: day(-4) });
  });

  it('carries supplier, reference and expiry on purchases', async () => {
    await owner
      .post(`/api/ingredients/${soy}/purchases`)
      .send({ effectiveDate: day(-1), quantity: '2', unit: 'L', totalCostCents: 5000, supplier: 'Mang Tony', reference: 'OR-1', expiryDate: day(60) })
      .expect(201);
    expect((await history()).movements[0]).toMatchObject({
      kind: 'purchase',
      quantityMilli: 2_000_000,
      supplier: 'Mang Tony',
      reference: 'OR-1',
      expiryDate: day(60),
      unitPriceE4: 25_000,
      averageAfterE4: 25_000,
      reversedById: null,
      reversesMovementId: null,
      needsRecount: null,
    });
  });

  it('is empty for an ingredient with no entries', async () => {
    const h = await history();
    expect(h.movements).toEqual([]);
    expect(h.reversibleMovementId).toBeNull();
    expect(h.ingredient.avgCostE4).toBeNull();
  });

  it('is refused for staff, who never see prices', async () => {
    await buy('1000', 10000, day(-1));
    const r = await staff.get(`/api/ingredients/${soy}/movements`).expect(403);
    expect(JSON.stringify(r.body)).not.toMatch(/10000|100000/);
  });

  it('is not found for another business, and for an unknown or invalid id', async () => {
    await buy('1000', 10000, day(-1));
    await other.get(`/api/ingredients/${soy}/movements`).expect(404);
    await owner.get('/api/ingredients/99999/movements').expect(404);
    await owner.get('/api/ingredients/abc/movements').expect(400);
  });

  it('needs a signed-in person', async () => {
    await request(app).get(`/api/ingredients/${soy}/movements`).expect(401);
  });

  it('marks a reversed line and its reversal, and leaves both out of the working', async () => {
    const a = await buy('1000', 10000, day(-3));
    const wrong = await buy('1000', 90000, day(-1));
    const rev = (await reverse(wrong).expect(201)).body.movementId as number;
    const h = await history();
    expect(byId(h, wrong)).toMatchObject({ reversedById: rev, reversesMovementId: null, onHandAfterMilli: null, averageAfterE4: null });
    expect(byId(h, rev)).toMatchObject({
      kind: 'purchase_reversal',
      reversedById: null,
      reversesMovementId: wrong,
      quantityMilli: -1_000_000,
      reason: 'Wrong entry',
      onHandAfterMilli: null,
      averageAfterE4: null,
    });
    expect(byId(h, a)).toMatchObject({ reversedById: null, onHandAfterMilli: 1_000_000, averageAfterE4: 100_000 });
    expect(h.ingredient).toMatchObject({ onHandMilli: 1_000_000, avgCostE4: 100_000 });
  });

  it('shows an opening balance with its reason and price', async () => {
    const o = await open('500', 2500, day(-5));
    expect(byId(await history(), o)).toMatchObject({ kind: 'opening', reason: 'Opening balance', unitPriceE4: 50_000, averageAfterE4: 50_000 });
  });

  // Which line the screen offers "Reverse" on must be the one the reversal endpoint accepts (D-42, D-43, D-45).
  it('flags nothing when a loss was entered last, and the reversal endpoint refuses every line', async () => {
    await open('1000', 10000, day(-9));
    await buy('1000', 20000, day(-5));
    await correct('spillage', '100', day(-1));
    const h = await history();
    expect(h.reversibleMovementId).toBeNull();
    for (const m of h.movements) expect((await reverse(m.id)).status, `line ${m.id}`).not.toBe(201);
  });

  it('flags the newest-entered purchase, whatever its date, and follows a chain of undos', async () => {
    const o = await open('1000', 10000, day(-9));
    const p1 = await buy('1000', 20000, day(-5));
    const p2 = await buy('1000', 30000, day(-7)); // dated before p1 but entered last
    let h = await history();
    expect(h.reversibleMovementId).toBe(p2);
    for (const m of h.movements.filter((x: any) => x.id !== p2)) expect((await reverse(m.id)).status, `line ${m.id}`).not.toBe(201);

    await reverse(p2).expect(201);
    // Lines already undone do not count (D-43), so the one before it is next.
    h = await history();
    expect(h.reversibleMovementId).toBe(p1);
    await reverse(p1).expect(201);
    expect((await history()).reversibleMovementId).toBe(o);
    await reverse(o).expect(201);
    expect((await history()).reversibleMovementId).toBeNull();
  });
});

describe('the notice that counts need entering again (D-44)', () => {
  // A count C no longer matches when the lines entered after it and dated on or before its date do not add up to zero.
  // A line gets the notice while a count entered before it, dated on or after it, no longer matches. It names the oldest.
  const start = () => buy('1000', 10000, day(-20));

  // S1: buy 1000 (-20); count 900 (-3) stores -100; back-dated buy +500 (-5); recount 900 (-3).
  //   Before the recount: lines after the count dated <= -3 add up to +500, so the count is out of date, and the buy is flagged -3.
  //   Recount: on hand at end of -3 is 1000 - 100 + 500 = 1400, so it stores -500. Lines after the first count: +500 - 500 = 0.
  it('S1: a back-dated purchase is flagged until the count is entered again, and then nothing is, the recount included', async () => {
    const p0 = await start();
    const k = (await count('900', day(-3)).expect(201)).body.movementId;
    const q = await buy('500', 5000, day(-5));
    expect(await notices()).toEqual({ [p0]: null, [k]: null, [q]: day(-3) });

    const r = (await count('900', day(-3)).expect(201)).body;
    expect(r.quantityMilli).toBe(-500_000);
    expect(await notices()).toEqual({ [p0]: null, [k]: null, [q]: null, [r.movementId]: null });
    expect((await history()).ingredient.onHandMilli).toBe(900_000);
  });

  // S2: buy 1000 (-20); counts 900 (-10) and 800 (-3) store -100 each; back-dated buy +500 (-15) puts both out by +500.
  //   Flagged with the oldest, -10. Recount -10 at 900: 1000 - 100 + 500 = 1400 -> stores -500. Then the -3 count is
  //   +500 - 500 = 0 after it, so recounting 800 answers "Nothing to correct". On hand ends at 800.
  it('S2: names the oldest count, and clears after the first recount while the second answers nothing to correct', async () => {
    const p0 = await start();
    const k10 = (await count('900', day(-10)).expect(201)).body.movementId;
    const k3 = (await count('800', day(-3)).expect(201)).body.movementId;
    const q = await buy('500', 5000, day(-15));
    expect(await notices()).toEqual({ [p0]: null, [k10]: null, [k3]: null, [q]: day(-10) });

    const r10 = (await count('900', day(-10)).expect(201)).body;
    expect(r10.quantityMilli).toBe(-500_000);
    const again = await count('800', day(-3)).expect(400);
    expect(again.body.error).toMatch(/^Nothing to correct/);
    expect(await notices()).toEqual({ [p0]: null, [k10]: null, [k3]: null, [q]: null, [r10.movementId]: null });
    expect((await history()).ingredient.onHandMilli).toBe(800_000);
  });

  it('is asked of nothing when two counts are made on the same day', async () => {
    const p0 = await start();
    const a = (await count('900', day(-3)).expect(201)).body.movementId;
    const b = (await count('800', day(-3)).expect(201)).body.movementId;
    expect(await notices()).toEqual({ [p0]: null, [a]: null, [b]: null });
  });

  it('is asked of nothing when back-dated entries cancel each other out', async () => {
    const p0 = await start();
    const k = (await count('900', day(-3)).expect(201)).body.movementId;
    const plus = await buy('50', 500, day(-5));
    const minus = await correct('spoilage', '50', day(-5));
    expect(await notices()).toEqual({ [p0]: null, [k]: null, [plus]: null, [minus]: null });
  });

  it('stays when the recount is dated today, which puts stock right but not the average', async () => {
    const p0 = await start();
    const k = (await count('900', day(-3)).expect(201)).body.movementId;
    const q = await buy('500', 5000, day(-5));
    const t = (await count('1000', localToday()).expect(201)).body.movementId; // on hand 1400, so stores -400
    expect(await notices()).toEqual({ [p0]: null, [k]: null, [q]: day(-3), [t]: null });
  });

  it('is asked of a count entered out of order, and clears when the later count is entered again', async () => {
    const p0 = await start();
    const late = (await count('900', day(-1)).expect(201)).body.movementId; // stores -100
    const early = (await count('950', day(-4)).expect(201)).body.movementId; // stores -50, so the -1 count is 50 out
    expect(await notices()).toEqual({ [p0]: null, [late]: null, [early]: day(-1) });
    const again = (await count('900', day(-1)).expect(201)).body;
    expect(again.quantityMilli).toBe(50_000);
    expect(Object.values(await notices()).every((n) => n === null)).toBe(true);
  });

  it('is not asked of a purchase that was undone, or of its reversal', async () => {
    await start();
    await count('900', day(-1)).expect(201);
    const wrong = await buy('500', 5000, day(-5));
    expect(byId(await history(), wrong).needsRecount).toBe(day(-1));
    await reverse(wrong).expect(201);
    expect(Object.values(await notices()).every((n) => n === null)).toBe(true);
  });
});

describe('the pure notice rules', () => {
  const ledger = (rows: [number, string, string, number][]) => rows.map(([id, kind, effectiveDate, quantityMilli]) => ({ id, kind, effectiveDate, quantityMilli }));

  it('a count is out of date when later-entered lines dated up to its date do not add up to zero', () => {
    const l = ledger([[1, 'purchase', '2026-10-01', 1000], [2, 'count_correction', '2026-10-10', -100], [3, 'purchase', '2026-10-05', 500]]);
    expect(countsOutOfDate(l)).toEqual([{ id: 2, effectiveDate: '2026-10-10' }]);
    expect(countsOutOfDate([...l, ...ledger([[4, 'spoilage', '2026-10-05', -500]])])).toEqual([]);
    // Lines dated after the count do not matter.
    expect(countsOutOfDate(ledger([[1, 'count_correction', '2026-10-10', -100], [2, 'purchase', '2026-10-11', 500]]))).toEqual([]);
  });

  it('a reversed line and its reversal net out in the sum', () => {
    const l = ledger([[1, 'count_correction', '2026-10-10', -100], [2, 'purchase', '2026-10-05', 500], [3, 'purchase_reversal', '2026-10-05', -500]]);
    expect(countsOutOfDate(l)).toEqual([]);
  });

  it('a count is left out when a later count has the same date', () => {
    const l = ledger([[1, 'count_correction', '2026-10-10', -100], [2, 'count_correction', '2026-10-10', -50]]);
    expect(countsOutOfDate(l)).toEqual([]);
  });

  it('names the oldest out-of-date count entered before the line and dated on or after it', () => {
    const out = [{ id: 2, effectiveDate: '2026-11-04' }, { id: 3, effectiveDate: '2026-11-01' }, { id: 4, effectiveDate: '2026-10-20' }, { id: 9, effectiveDate: '2026-11-09' }];
    const line = { id: 5, effectiveDate: '2026-11-01', quantityMilli: 1000 };
    expect(needsRecountDate(line, out)).toBe('2026-11-01');
    expect(needsRecountDate({ ...line, effectiveDate: '2026-11-02' }, out)).toBe('2026-11-04');
    expect(needsRecountDate({ ...line, id: 3 }, out)).toBe('2026-11-04'); // never the line itself, nor a later-entered count
    expect(needsRecountDate(line, [])).toBeNull();
    expect(needsRecountDate({ ...line, quantityMilli: 0 }, out)).toBeNull();
  });
});
