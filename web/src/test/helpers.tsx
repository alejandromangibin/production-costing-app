import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import type { Ingredient, Me, Movement } from '../api';
import { AuthProvider } from '../auth';
import type { ReactElement } from 'react';

// Helpers for the screen tests: a fake server behind fetch, and the real AuthProvider, so pages see the
// signed-in person the way the app gives it to them. Nothing here reaches a network.

type Reply = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
export type Handler = (body: any) => Reply;

export interface FakeServer {
  /** "METHOD /path" of every request made, in order, without the /api prefix. */
  calls: string[];
  /** The JSON bodies sent, by "METHOD /path". */
  bodies: Record<string, unknown[]>;
  /** Requests the test did not expect. The page swallows the error, so setup.ts fails the test if this is not empty. */
  unexpected: string[];
  /** Requests sent and not yet answered. */
  pending: number;
  count: (key: string) => number;
}

let current: FakeServer | null = null;

/**
 * Called after every test (setup.ts). A request nobody expected is not an error on screen (the page shows "Cannot reach
 * the server" and carries on), so it is caught here instead, and so is that message on screen.
 */
export function problemsAfterTest(): string[] {
  const problems: string[] = [];
  if (current?.unexpected.length) problems.push(`Unexpected requests: ${current.unexpected.join(', ')}`);
  if (document.body.textContent?.includes('Cannot reach the server')) problems.push('The page shows "Cannot reach the server"');
  current = null;
  return problems;
}

/** Answer fetch from a table of "METHOD /path" -> handler. A request nobody expected is recorded and refused. */
export function fakeServer(routes: Record<string, Handler>): FakeServer {
  const server: FakeServer = { calls: [], bodies: {}, unexpected: [], pending: 0, count: (key) => server.calls.filter((c) => c === key).length };
  current = server;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.replace(/^\/api/, '')}`;
      server.calls.push(key);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (body !== undefined) (server.bodies[key] ??= []).push(body);
      const handler = routes[key];
      if (!handler) {
        server.unexpected.push(key);
        throw new Error(`The test did not expect the request ${key}`);
      }
      server.pending++;
      try {
        const reply = await handler(body);
        return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status ?? 200 });
      } finally {
        server.pending--;
      }
    }),
  );
  return server;
}

export const meFor = (role: 'owner' | 'staff', level: 'full' | 'read_only' = 'full'): Me => ({
  user: { id: 1, email: `${role}@a.test`, name: role === 'owner' ? 'Olga Owner' : 'Sam Staff', role },
  timeZone: 'Asia/Manila',
  tenant: {
    id: 1,
    name: 'Frozen Foods',
    status: 'active',
    trialEndsOn: '2026-12-01',
    paidThrough: null,
    access: { level, message: null, daysLeft: null },
  },
});

/** Show a page as the signed-in person, at a path, and wait until every first answer has been drawn. */
export async function renderPage(role: 'owner' | 'staff', path: string, routePath: string, element: ReactElement, extra: Record<string, Handler> = {}) {
  const server = fakeServer({ 'GET /auth/me': () => ({ body: meFor(role) }), ...extra });
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
  await settle(server);
  return { server, ...view };
}

/**
 * Wait until nothing is in flight and a whole turn passes with no new request, so a page that asks for more once the
 * first answer arrives (the signed-in person, then the data) has finished. Fails if it never calms down.
 */
export async function settle(server: FakeServer) {
  let seen = -1;
  for (let turn = 0; turn < 100; turn++) {
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    if (server.pending === 0 && server.calls.length === seen) return;
    seen = server.calls.length;
  }
  throw new Error('The page never finished loading in the test.');
}

export const soy: Ingredient = {
  id: 1,
  name: 'Soy sauce',
  baseUnit: 'mL',
  onHandMilli: 2_000_000,
  lowStockMilli: null,
  active: true,
  lastCountDate: null,
};

export const flour: Ingredient = { ...soy, id: 2, name: 'Flour', baseUnit: 'g', onHandMilli: 5_000_000 };

/** One ledger line as the history endpoint sends it. */
export function movement(partial: Partial<Movement> & Pick<Movement, 'id' | 'kind' | 'effectiveDate' | 'quantityMilli'>): Movement {
  return {
    totalCostCents: null,
    unitPriceE4: null,
    supplier: '',
    reference: '',
    expiryDate: null,
    reason: '',
    enteredByName: 'Olga Owner',
    enteredAt: '2026-11-01 09:00:00+08',
    reversedById: null,
    reversesMovementId: null,
    runId: null,
    unitCostE4: null,
    onHandAfterMilli: null,
    averageAfterE4: null,
    needsRecount: null,
    ...partial,
  };
}
