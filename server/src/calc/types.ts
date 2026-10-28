/** All money values are whole centavos (₱1.00 = 100). */

export interface PackingInput {
  packSizeId: number;
  piecesPerPack: number;
  retailPriceCents: number;
  /** Packaging cost for one pack of this size. */
  packagingCostCents: number;
  /** Number of packs of this size made in the run. */
  packs: number;
}

export interface RunProductInput {
  productId: number;
  packings: PackingInput[];
  loosePieces: number;
  rejectedPieces: number;
}

export interface RunCostInput {
  category: string;
  description: string;
  amountCents: number;
  scope: 'shared' | 'specific';
  /** For specific costs: the products the cost is charged to. */
  targetProductIds: number[];
}

export interface RunInput {
  /** Order matters: when an amount cannot be split evenly, earlier products get the extra centavo. */
  products: RunProductInput[];
  costs: RunCostInput[];
}

export interface PackingResult {
  packSizeId: number;
  piecesPerPack: number;
  retailPriceCents: number;
  packagingCostCents: number;
  packs: number;
  packCostCents: number;
  /** (retail - cost) / retail, in percent. */
  marginPct: number;
  /** (retail - cost) / cost, in percent. Null when the cost is zero. */
  markupPct: number | null;
}

export interface ProductResult {
  productId: number;
  loosePieces: number;
  rejectedPieces: number;
  packedPieces: number;
  piecesMade: number;
  goodPieces: number;
  sharedShareCents: number;
  specificCents: number;
  packagingCents: number;
  totalCostCents: number;
  /** Centavos per good piece, before packaging. Not rounded. */
  costPerGoodPiece: number;
  packings: PackingResult[];
}

export interface RunResult {
  products: ProductResult[];
  sharedCents: number;
  specificCents: number;
  packagingCents: number;
  totalCostCents: number;
}

/** A problem with the numbers entered, written so the owner can fix it. */
export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalcError';
  }
}
