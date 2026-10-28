/**
 * Stops someone guessing passwords. Counts failed attempts per key in a sliding window.
 * Held in memory, so it resets when the server restarts and is per server copy: fine for one
 * server, and worth replacing with a shared store if the app ever runs on several.
 */
export class FailureLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until another attempt is allowed, or 0 if allowed now. */
  retryAfterSeconds(key: string): number {
    const list = this.recent(key);
    if (list.length < this.max) return 0;
    return Math.max(1, Math.ceil((list[0]! + this.windowMs - this.now()) / 1000));
  }

  fail(key: string) {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    // Keep memory bounded if someone sprays many different keys.
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value!);
  }

  clear(key: string) {
    this.hits.delete(key);
  }
}
