import { Router } from 'express';
import type { AuthKit } from '../auth/middleware';
import { exportTenant } from '../backup';
import { localToday } from '../dates';
import { badRequest } from '../errors';
import { packSizeCreate, packSizeUpdate, productCreate, productUpdate, runBody, runsQuery, todayQuery, voidBody } from '../schemas';
import { addPackSize, createProduct, getProduct, listProducts, updatePackSize, updateProduct } from '../services/products';
import { expiryBoard, marginsView } from '../services/reports';
import { getRun, listRuns, previewRun, runsCsv, saveRun, voidRun } from '../services/runs';

const id = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Invalid id');
  return n;
};

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
    res.status(201).json(await createProduct(req.tdb!, productCreate.parse(req.body)));
  });
  r.get('/products/:id', async (req, res) => {
    res.json(await getProduct(req.tdb!, id(req.params.id)));
  });
  r.patch('/products/:id', write, async (req, res) => {
    res.json(await updateProduct(req.tdb!, id(req.params.id), productUpdate.parse(req.body)));
  });
  r.post('/products/:id/pack-sizes', write, async (req, res) => {
    res.status(201).json(await addPackSize(req.tdb!, id(req.params.id), packSizeCreate.parse(req.body)));
  });
  r.patch('/pack-sizes/:id', write, async (req, res) => {
    res.json(await updatePackSize(req.tdb!, id(req.params.id), packSizeUpdate.parse(req.body)));
  });

  // ---- Runs ----
  // Preview only calculates, so it stays available when the subscription has lapsed.
  r.post('/runs/preview', async (req, res) => {
    res.json(await previewRun(req.tdb!, runBody.parse(req.body)));
  });
  r.post('/runs', write, async (req, res) => {
    const runId = await saveRun(req.tdb!, runBody.parse(req.body));
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
    res.json(await voidRun(req.tdb!, id(req.params.id), voidBody.parse(req.body).reason));
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
  r.get('/export', async (req, res) => {
    const file = await exportTenant(req.tdb!);
    res.set('Content-Disposition', `attachment; filename="my-costing-data-${localToday()}.json"`);
    res.json(file);
  });

  return r;
}
