import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/index';

/**
 * A tiny stand-in for PostgreSQL: accepts the login and answers every query with "done". The first
 * connection it receives is dropped 300 ms after login, the way a provider restart would; later
 * connections stay up.
 */
function fakePostgres(): Promise<{ url: string; close: () => void }> {
  const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
  const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
  const done = Buffer.concat([Buffer.from([0x43, 0, 0, 0, 10]), Buffer.from('BEGIN\0')]);
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    const dropSoon = ++connections === 1;
    let loggedIn = false;
    socket.on('data', () => {
      if (loggedIn) return void socket.write(Buffer.concat([done, ready]));
      loggedIn = true;
      socket.write(Buffer.concat([authOk, ready]));
      if (dropSoon) setTimeout(() => socket.destroy(), 300);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `postgres://costing:S3cretPass@127.0.0.1:${port}/costing`,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('a database connection that drops while the app is running (D-14)', () => {
  it('fails only the change in progress, logs one plain line, and the app carries on', async () => {
    const pg = await fakePostgres();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = await openDb({ databaseUrl: pg.url });
    try {
      // Other work inside the change keeps the connection checked out while the database drops it.
      // Before the fix this crashed the whole process with an unhandled 'error' event.
      await expect(
        db.tx(async (q) => {
          await q.exec('BEGIN-ish');
          await new Promise((r) => setTimeout(r, 800));
          await q.exec('SELECT 1');
        }),
      ).rejects.toThrow();

      const lines = logged.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('The database connection dropped during a change'))).toHaveLength(1);
      expect(lines.join('\n')).toContain('That change may not have been saved; the app keeps running.');
      expect(lines.join('\n')).not.toContain('S3cretPass');

      // The dead connection was thrown away: the next request gets a fresh one and works.
      await expect(db.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      await db.close();
      pg.close();
    }
  });
});
