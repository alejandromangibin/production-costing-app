import { Router } from 'express';
import { type AuthKit, linkUrl } from '../auth/middleware';
import type { Db } from '../db/index';
import { badRequest } from '../errors';
import { inviteBody, paymentBody, tenantCreate, tenantPatch } from '../schemas';
import { createLinkFor, createTenantWithOwner, inviteOwner, listTeam, listTenantsForAdmin } from '../services/accounts';
import { getTenant, listPayments, recordPayment, updateTenant } from '../services/billing';

const id = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Invalid id');
  return n;
};

/** The platform admin's screens: create businesses, record payments, switch accounts on and off. */
export function adminRoutes(db: Db, kit: AuthKit) {
  const r = Router();
  r.use(kit.requireAdmin);

  r.get('/tenants', async (_req, res) => {
    res.json(await listTenantsForAdmin(db));
  });

  r.post('/tenants', async (req, res) => {
    const body = tenantCreate.parse(req.body);
    const created = await createTenantWithOwner(db, body);
    res.status(201).json({ tenant: created.tenant, inviteUrl: linkUrl(req, created.token) });
  });

  r.patch('/tenants/:id', async (req, res) => {
    res.json(await updateTenant(db, id(req.params.id), tenantPatch.parse(req.body)));
  });

  r.get('/tenants/:id/payments', async (req, res) => {
    const tenantId = id(req.params.id);
    await getTenant(db, tenantId);
    res.json(await listPayments(db, tenantId));
  });

  r.post('/tenants/:id/payments', async (req, res) => {
    const tenant = await recordPayment(db, id(req.params.id), paymentBody.parse(req.body), req.auth!.user.id);
    res.status(201).json(tenant);
  });

  r.get('/tenants/:id/people', async (req, res) => {
    const tenantId = id(req.params.id);
    await getTenant(db, tenantId);
    res.json(await listTeam(db, tenantId));
  });

  // A new sign-in link for someone who forgot their password or never used their invite.
  r.post('/tenants/:id/people/:userId/link', async (req, res) => {
    const link = await createLinkFor(db, id(req.params.userId), id(req.params.id));
    res.json({ kind: link.kind, email: link.email, url: linkUrl(req, link.token) });
  });

  // For a business that has no owner yet.
  r.post('/tenants/:id/owner', async (req, res) => {
    const body = inviteBody.parse(req.body);
    const invited = await inviteOwner(db, id(req.params.id), body);
    res.status(201).json({ inviteUrl: linkUrl(req, invited.token) });
  });

  return r;
}
