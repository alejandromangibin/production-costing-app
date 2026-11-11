import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Resolve body-parser the way express does, so a lockfile that quietly goes back to an old
// version (for example after a merge) fails here.
const MINIMUM = [2, 4, 0];

function atLeast(version: string, minimum: number[]): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < minimum.length; i++) {
    if ((parts[i] ?? 0) !== minimum[i]) return (parts[i] ?? 0) > minimum[i]!;
  }
  return true;
}

describe('dependency guard', () => {
  it('uses body-parser 2.4.0 or newer (GHSA-27r3-jxmh-p828, denial of service via compressed bodies)', () => {
    const fromServer = createRequire(import.meta.url);
    const fromExpress = createRequire(fromServer.resolve('express'));
    const { version } = fromExpress('body-parser/package.json') as { version: string };
    expect(atLeast(version, MINIMUM), `body-parser ${version} is affected by GHSA-27r3-jxmh-p828`).toBe(true);
  });
});
