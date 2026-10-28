import { Router } from 'express';
import { type AuthKit, linkUrl } from '../auth/middleware';
import type { Db } from '../db/index';
import { badRequest } from '../errors';
import { activeBody, inviteBody } from '../schemas';
import { createLinkFor, inviteStaff, listTeam, setStaffActive } from '../services/accounts';

const id = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Invalid id');
  return n;
};

/** The owner manages the people in their own business. Links are shared by the owner, since no email is sent. */
export function teamRoutes(db: Db, kit: AuthKit) {
  const r = Router();
  r.use(kit.requireTenant, kit.requireOwner);

  r.get('/', async (req, res) => {
    res.json(await listTeam(db, req.auth!.user.tenantId!));
  });

  r.post('/', kit.requireWritable, async (req, res) => {
    const invited = await inviteStaff(db, req.auth!.user.tenantId!, inviteBody.parse(req.body));
    res.status(201).json({ inviteUrl: linkUrl(req, invited.token) });
  });

  r.post('/:userId/link', async (req, res) => {
    const link = await createLinkFor(db, id(req.params.userId), req.auth!.user.tenantId!);
    res.json({ kind: link.kind, email: link.email, url: linkUrl(req, link.token) });
  });

  r.patch('/:userId', async (req, res) => {
    await setStaffActive(db, req.auth!.user.tenantId!, id(req.params.userId), activeBody.parse(req.body).active);
    res.json(await listTeam(db, req.auth!.user.tenantId!));
  });

  return r;
}
