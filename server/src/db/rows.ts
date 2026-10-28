import type { Row } from './index';

/** Turn a database row with snake_case keys into an object with camelCase keys. */
export function camel<T = Row>(row: Row): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out as T;
}

/** "$1, $2, $3" for `count` values, starting at `start`. */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}
