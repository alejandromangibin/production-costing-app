import { CalcError } from './types';

/**
 * Split a whole number of centavos in proportion to `weights`, with no centavo lost or invented.
 *
 * Largest-remainder method using exact integer (BigInt) arithmetic. If several parts have the
 * same remainder, the earlier one in the list gets the extra centavo.
 */
export function allocate(totalCents: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new CalcError('An amount to split must be a whole number of centavos, zero or more.');
  }
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new CalcError('Pieces used to split a cost must be whole numbers, zero or more.');
  }
  const total = BigInt(totalCents);
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum === 0n) {
    throw new CalcError('Cannot split a cost across products that made no pieces.');
  }

  const parts = weights.map((w, index) => {
    const product = total * BigInt(w);
    return { index, base: product / sum, remainder: product % sum };
  });
  let leftover = Number(total - parts.reduce((a, p) => a + p.base, 0n));

  const byRemainder = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  const extra = new Set<number>();
  for (const p of byRemainder) {
    if (leftover === 0) break;
    extra.add(p.index);
    leftover -= 1;
  }
  return parts.map((p) => Number(p.base) + (extra.has(p.index) ? 1 : 0));
}

/** Round the fraction numerator/denominator to a whole number, halves going up. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new CalcError('Cannot divide by zero.');
  return (2n * numerator + denominator) / (2n * denominator);
}
