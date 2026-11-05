import { type Request, Router } from 'express';
import type { AuthKit } from '../auth/middleware';
import { exportTenant } from '../backup';
import { localToday } from '../dates';
import { badRequest } from '../errors';
import { ingredientCreate, ingredientUpdate, packSizeCreate, packSizeUpdate, productCreate, productUpdate, purchaseBody, runBody, runsQuery, todayQuery, voidBody } from '../schemas';
import { recordPurchase } from '../services/stockLedger';
import { createIngredient, getIngredient, getIngredientWithCost, listIngredients, listIngredientsWithCost, updateIngredient } from '../services/ingredients';
import { addPackSize, createProduct, getProduct, listPackSizeChanges, listProducts, updatePackSize, updateProduct } from '../services/products';
import { expiryBoard, marginsView } from '../services/reports';
import { type Actor, getRun, listRuns, previewRun, runsCsv, saveRun, voidRun } from '../services/runs';

const id = (value: unknown): number => {
  const n = Number(value);
  // Ids are integer columns: a larger number would fail in the database as a server error.
  if (!Number.isInteger(n) || n < 1 || n > 2_147_483_647) throw badRequest('Invalid id');
  return n;
};

/** The signed-in person, as saved on records they create or change (name, or email if no name). */
const actor = (req: Request): Actor => {
  const { user } = req.auth!;
  return { id: user.id, name: user.name.trim() || user.email };
};

const isOwner = (req: Request): boolean => req.auth!.user.role === 'owner';

/**
 * Everything a business does with its own data. Every handler uses req.tdb, a database handle that
 * can only see the logged-in business (see db/scoped.ts). Changes need an active subscription.
 */
export function dataRoutes(kit: AuthKit) {
  const r = Router();
  r.use(kit.requireTenant);
  const write = kit.requireWritable;

  // ---- Products and pack sizes ----
  r.get('/products', async (req, res) => {
    res.json(await listProducts(req.tdb!, req.query.includeInactive === '1'));
  });
  r.post('/products', write, async (req, res) => {
    res.status(201).json(await createProduct(req.tdb!, productCreate.parse(req.body), actor(req)));
  });
  r.get('/products/:id', async (req, res) => {
    res.json(await getProduct(req.tdb!, id(req.params.id)));
  });
  // Price history: who changed a pack size's prices or settings, and when (audit trail, RUN-10).
  r.get('/products/:id/changes', async (req, res) => {
    res.json(await listPackSizeChanges(req.tdb!, id(req.params.id)));
  });
  r.patch('/products/:id', write, async (req, res) => {
    res.json(await updateProduct(req.tdb!, id(req.params.id), productUpdate.parse(req.body)));
  });
  r.post('/products/:id/pack-sizes', write, async (req, res) => {
    res.status(201).json(await addPackSize(req.tdb!, id(req.params.id), packSizeCreate.parse(req.body), actor(req)));
  });
  r.patch('/pack-sizes/:id', write, async (req, res) => {
    res.json(await updatePackSize(req.tdb!, id(req.params.id), packSizeUpdate.parse(req.body), actor(req)));
  });

  // ---- Ingredients ----
  // Everyone in the business sees names, units and quantities. Costs and changes are the owner's (INV-14).
  r.get('/ingredients', async (req, res) => {
    const all = req.query.includeInactive === '1';
    res.json(isOwner(req) ? await listIngredientsWithCost(req.tdb!, all) : await listIngredients(req.tdb!, all));
  });
  r.get('/ingredients/:id', async (req, res) => {
    const ingredientId = id(req.params.id);
    res.json(isOwner(req) ? await getIngredientWithCost(req.tdb!, ingredientId) : await getIngredient(req.tdb!, ingredientId));
  });
  r.post('/ingredients', kit.requireOwner, write, async (req, res) => {
    res.status(201).json(await createIngredient(req.tdb!, ingredientCreate.parse(req.body), actor(req)));
  });
  r.patch('/ingredients/:id', kit.requireOwner, write, async (req, res) => {
    res.json(await updateIngredient(req.tdb!, id(req.params.id), ingredientUpdate.parse(req.body)));
  });

  // Staff and owner record purchases (INV-02); only the owner's answer shows the average.
  r.post('/ingredients/:id/purchases', write, async (req, res) => {
    res.status(201).json(await recordPurchase(req.tdb!, id(req.params.id), purchaseBody.parse(req.body), actor(req), isOwner(req)));
  });

  // ---- Runs ----
  // Preview only calculates, so it stays available when the subscription has lapsed.
  r.post('/runs/preview', async (req, res) => {
    res.json(await previewRun(req.tdb!, runBody.parse(req.body)));
  });
  r.post('/runs', write, async (req, res) => {
    const runId = await saveRun(req.tdb!, runBody.parse(req.body), actor(req));
    res.status(201).json(await getRun(req.tdb!, runId));
  });
  r.get('/runs', async (req, res) => {
    res.json(await listRuns(req.tdb!, runsQuery.parse(req.query)));
  });
  r.get('/runs/export.csv', async (req, res) => {
    const csv = await runsCsv(req.tdb!, runsQuery.parse(req.query));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="production-runs-${localToday()}.csv"`,
    });
    res.send(csv);
  });
  r.get('/runs/:id', async (req, res) => {
    res.json(await getRun(req.tdb!, id(req.params.id)));
  });
  r.post('/runs/:id/void', write, async (req, res) => {
    res.json(await voidRun(req.tdb!, id(req.params.id), voidBody.parse(req.body).reason, actor(req)));
  });

  // ---- Reports ----
  r.get('/batches/expiry', async (req, res) => {
    const { today } = todayQuery.parse(req.query);
    const day = today ?? localToday();
    // One transaction, so both halves of the board see the same data.
    res.json({ today: day, ...(await req.tdb!.tx((q) => expiryBoard(q, day))) });
  });
  r.get('/margins', async (req, res) => {
    res.json(await marginsView(req.tdb!));
  });

  // ---- The business's own copy of its data ----
  // Owner only (D-33): the file holds every cost and margin, which staff will not see once USR-12 is live.
  r.get('/export', kit.requireOwner, async (req, res) => {
    const file = await exportTenant(req.tdb!);
    res.set('Content-Disposition', `attachment; filename="my-costing-data-${localToday()}.json"`);
    res.json(file);
  });

  return r;
}
