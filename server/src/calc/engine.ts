import { allocate, divRoundHalfUp } from './allocate';
import {
  CalcError,
  type PackingResult,
  type ProductResult,
  type RunInput,
  type RunResult,
} from './types';

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * Work out what a production run cost, per product and per pack.
 *
 * 1. Pieces made = packed pieces + loose pieces + rejected pieces. Good pieces = made - rejected.
 * 2. Shared costs are split across all products by pieces made.
 * 3. Specific costs go only to their target products (split by pieces made if there are several).
 * 4. Packaging = packs of each size x packaging cost of that size.
 * 5. Pack cost = (shared share + specific) x pieces in pack / good pieces, rounded once, + packaging.
 *
 * This is the only place costs are calculated. Everything else displays what it returns.
 */
export function calculateRun(input: RunInput): RunResult {
  if (input.products.length === 0) throw new CalcError('Add at least one product to the run.');

  const seen = new Set<number>();
  for (const p of input.products) {
    if (seen.has(p.productId)) throw new CalcError('A product can only appear once in a run.');
    seen.add(p.productId);
    if (!isCount(p.loosePieces) || !isCount(p.rejectedPieces)) {
      throw new CalcError('Loose and rejected pieces must be whole numbers, zero or more.');
    }
    const sizes = new Set<number>();
    for (const k of p.packings) {
      if (!isCount(k.packs) || !Number.isSafeInteger(k.piecesPerPack) || k.piecesPerPack < 1) {
        throw new CalcError('Packs must be whole numbers, zero or more.');
      }
      if (sizes.has(k.packSizeId)) throw new CalcError('A pack size can only be listed once per product.');
      sizes.add(k.packSizeId);
      if (!isCount(k.retailPriceCents) || k.retailPriceCents <= 0) {
        throw new CalcError('Retail price must be more than zero.');
      }
      if (!isCount(k.packagingCostCents)) throw new CalcError('Packaging cost cannot be negative.');
    }
  }

  // Pieces per product.
  const base = input.products.map((p) => {
    const packedPieces = p.packings.reduce((a, k) => a + k.packs * k.piecesPerPack, 0);
    const piecesMade = packedPieces + p.loosePieces + p.rejectedPieces;
    const goodPieces = piecesMade - p.rejectedPieces;
    return { packedPieces, piecesMade, goodPieces };
  });
  input.products.forEach((p, i) => {
    if (base[i]!.piecesMade === 0) throw new CalcError('Every product in a run must have made at least one piece.');
    if (base[i]!.goodPieces === 0) {
      throw new CalcError('Every product needs at least one good piece. Check the rejected pieces.');
    }
  });

  const weights = base.map((b) => b.piecesMade);

  // Costs.
  let sharedTotal = 0;
  let specificTotal = 0;
  let sharedShares = input.products.map(() => 0);
  const specific = input.products.map(() => 0);

  for (const c of input.costs) {
    if (!isCount(c.amountCents)) throw new CalcError('Cost amounts must be whole centavos, zero or more.');
    if (c.scope === 'shared') {
      sharedTotal += c.amountCents;
    } else {
      const targets = new Set(c.targetProductIds);
      if (targets.size === 0) {
        throw new CalcError(`The specific cost "${c.description || c.category}" needs at least one product.`);
      }
      const indexes = input.products.flatMap((p, i) => (targets.has(p.productId) ? [i] : []));
      if (indexes.length !== targets.size) {
        throw new CalcError(`The specific cost "${c.description || c.category}" names a product that is not in this run.`);
      }
      const split = allocate(c.amountCents, indexes.map((i) => weights[i]!));
      indexes.forEach((productIndex, n) => {
        specific[productIndex] = specific[productIndex]! + split[n]!;
      });
      specificTotal += c.amountCents;
    }
  }
  sharedShares = allocate(sharedTotal, weights);

  // Per product results.
  let packagingTotal = 0;
  const products: ProductResult[] = input.products.map((p, i) => {
    const b = base[i]!;
    const sharedShareCents = sharedShares[i]!;
    const specificCents = specific[i]!;
    const costBeforePackaging = sharedShareCents + specificCents;
    const packagingCents = p.packings.reduce((a, k) => a + k.packs * k.packagingCostCents, 0);
    packagingTotal += packagingCents;

    const packings: PackingResult[] = p.packings
      .filter((k) => k.packs > 0)
      .map((k) => {
        const exactRounded = divRoundHalfUp(
          BigInt(costBeforePackaging) * BigInt(k.piecesPerPack),
          BigInt(b.goodPieces),
        );
        const packCostCents = Number(exactRounded) + k.packagingCostCents;
        const profit = k.retailPriceCents - packCostCents;
        return {
          packSizeId: k.packSizeId,
          piecesPerPack: k.piecesPerPack,
          retailPriceCents: k.retailPriceCents,
          packagingCostCents: k.packagingCostCents,
          packs: k.packs,
          packCostCents,
          marginPct: (profit / k.retailPriceCents) * 100,
          markupPct: packCostCents > 0 ? (profit / packCostCents) * 100 : null,
        };
      });

    return {
      productId: p.productId,
      loosePieces: p.loosePieces,
      rejectedPieces: p.rejectedPieces,
      packedPieces: b.packedPieces,
      piecesMade: b.piecesMade,
      goodPieces: b.goodPieces,
      sharedShareCents,
      specificCents,
      packagingCents,
      totalCostCents: costBeforePackaging + packagingCents,
      costPerGoodPiece: costBeforePackaging / b.goodPieces,
      packings,
    };
  });

  const result: RunResult = {
    products,
    sharedCents: sharedTotal,
    specificCents: specificTotal,
    packagingCents: packagingTotal,
    totalCostCents: sharedTotal + specificTotal + packagingTotal,
  };

  // Safety check: the products' costs must add up to the run total, to the centavo.
  const sum = products.reduce((a, p) => a + p.totalCostCents, 0);
  if (sum !== result.totalCostCents) {
    throw new Error(`Internal error: product costs (${sum}) do not add up to the run total (${result.totalCostCents}).`);
  }
  return result;
}
