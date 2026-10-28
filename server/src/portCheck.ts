import net from 'node:net';

/** True if nothing is listening on the port. Used so two copies never open the same built-in database. */
export function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}
