import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { badRequest } from '../errors';

/**
 * Passwords are hashed with scrypt (built into Node), with a random salt per password.
 * The stored text records its own cost settings, so they can be raised later without locking anyone out.
 */
interface Cost {
  N: number;
  r: number;
  p: number;
}

// OWASP's scrypt guidance includes N=2^15, r=8, p=3.
const DEFAULT_COST: Cost = { N: 32768, r: 8, p: 3 };
let cost: Cost = DEFAULT_COST;

/** Tests use a much cheaper setting so hundreds of logins do not take minutes. */
export function useFastPasswordHashingForTests() {
  cost = { N: 1024, r: 8, p: 1 };
}

const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, c: Cost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: c.N, r: c.r, p: c.p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join('$');
}

// Checked when no such user exists, so a missing account takes as long to reject as a wrong password.
let dummyHash: Promise<string> | null = null;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword('not-a-real-password');
    await verifyPassword(password, await dummyHash);
    return false;
  }
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await derive(password, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Rules for a new password. Returns nothing if fine; throws a readable message if not. */
export function checkNewPassword(password: string, email?: string) {
  if (password.length < 10) throw badRequest('Use a password of at least 10 characters.');
  if (password.length > 200) throw badRequest('That password is too long (200 characters at most).');
  if (email && password.toLowerCase() === email.toLowerCase()) throw badRequest('The password cannot be your email address.');
  if (/^(.)\1+$/.test(password)) throw badRequest('Choose a password that is not just one repeated character.');
}

/** A random value for a login cookie or a one-time link. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash of a token is stored, so a database leak does not hand out working logins or links. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
