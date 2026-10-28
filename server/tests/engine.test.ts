import { describe, expect, it } from 'vitest';
import { allocate } from '../src/calc/allocate';
import { calculateRun } from '../src/calc/engine';
import { CalcError, type RunInput } from '../src/calc/types';

const PORK = 1;
const JAP = 2;

/** AT-01 from the functional requirements. */
function at01(): RunInput {
  return {
    products: [
      {
        productId: PORK,
        loosePieces: 6,
        rejectedPieces: 4,
        packings: [{ packSizeId: 11, piecesPerPack: 12, retailPriceCents: 7000, packagingCostCents: 500, packs: 20 }],
      },
      {
        productId: JAP,
        loosePieces: 18,
        rejectedPieces: 12,
        packings: [
          { packSizeId: 21, piecesPerPack: 12, retailPriceCents: 11000, packagingCostCents: 500, packs: 50 },
          { packSizeId: 22, piecesPerPack: 20, retailPriceCents: 17500, packagingCostCents: 700, packs: 6 },
        ],
      },
    ],
    costs: [
      { category: 'ingredient', description: 'Base ingredients, gas, electricity', amountCents: 280000, scope: 'shared', targetProductIds: [] },
      { category: 'ingredient', description: 'Japanese-only ingredients', amountCents: 60000, scope: 'specific', targetProductIds: [JAP] },
    ],
  };
}

describe('AT-01: two products, shared and specific costs, two pack sizes', () => {
  const result = calculateRun(at01());
  const [pork, jap] = result.products;

  it('counts pieces', () => {
    expect([pork!.piecesMade, pork!.goodPieces]).toEqual([250, 246]);
    expect([jap!.piecesMade, jap!.goodPieces]).toEqual([750, 738]);
    expect(pork!.packedPieces).toBe(240);
    expect(jap!.packedPieces).toBe(720);
  });

  it('splits shared costs by pieces made and keeps specific costs on their product', () => {
    expect(pork!.sharedShareCents).toBe(70000);
    expect(jap!.sharedShareCents).toBe(210000);
    expect(pork!.specificCents).toBe(0);
    expect(jap!.specificCents).toBe(60000);
  });

  it('adds packaging and totals', () => {
    expect(pork!.packagingCents).toBe(10000);
    expect(jap!.packagingCents).toBe(29200);
    expect(pork!.totalCostCents).toBe(80000);
    expect(jap!.totalCostCents).toBe(299200);
    expect(result.totalCostCents).toBe(379200);
    expect(result.sharedCents + result.specificCents + result.packagingCents).toBe(379200);
  });

  it('gives cost per good piece before packaging', () => {
    expect(pork!.costPerGoodPiece / 100).toBeCloseTo(2.85, 2);
    expect(jap!.costPerGoodPiece / 100).toBeCloseTo(3.66, 2);
  });

  it('gives pack costs, margins and markups', () => {
    const porkPack = pork!.packings[0]!;
    expect(porkPack.packCostCents).toBe(3915);
    expect(porkPack.marginPct).toBeCloseTo(44.1, 1);
    expect(porkPack.markupPct!).toBeCloseTo(78.8, 1);

    const jap12 = jap!.packings.find((k) => k.piecesPerPack === 12)!;
    expect(jap12.packCostCents).toBe(4890);
    expect(jap12.marginPct).toBeCloseTo(55.5, 1);
    expect(jap12.markupPct!).toBeCloseTo(124.9, 1);

    const jap20 = jap!.packings.find((k) => k.piecesPerPack === 20)!;
    expect(jap20.packCostCents).toBe(8017);
    expect(jap20.marginPct).toBeCloseTo(54.2, 1);
    expect(jap20.markupPct!).toBeCloseTo(118.3, 1);
  });
});

describe('AT-02: rounding', () => {
  it('splits 100.00 across three equal products as 33.34 / 33.33 / 33.33', () => {
    expect(allocate(10000, [100, 100, 100])).toEqual([3334, 3333, 3333]);
  });

  it('gives the extra centavo to the first product in a run', () => {
    const products = [3, 2, 1].map((id) => ({
      productId: id,
      loosePieces: 100,
      rejectedPieces: 0,
      packings: [],
    }));
    const r = calculateRun({
      products,
      costs: [{ category: 'other', description: '', amountCents: 10000, scope: 'shared', targetProductIds: [] }],
    });
    expect(r.products.map((p) => p.sharedShareCents)).toEqual([3334, 3333, 3333]);
    expect(r.products.reduce((a, p) => a + p.sharedShareCents, 0)).toBe(10000);
  });
});

describe('allocate', () => {
  it('always adds up to the total', () => {
    for (const total of [0, 1, 7, 99, 10001, 123456789]) {
      for (const weights of [[1], [1, 1], [3, 5, 7], [250, 750], [1, 0, 2], [999, 1, 1, 1]]) {
        const parts = allocate(total, weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        parts.forEach((p, i) => {
          if (weights[i] === 0) expect(p).toBe(0);
        });
      }
    }
  });

  it('gives the extra centavo to the largest remainder', () => {
    // 10 split 1:2 = 3.33 / 6.67 -> 3 / 7
    expect(allocate(10, [1, 2])).toEqual([3, 7]);
  });

  it('is exact for amounts too big for floating point multiplication', () => {
    const parts = allocate(2_000_000_000, [3_000_000, 7_000_000]);
    expect(parts).toEqual([600_000_000, 1_400_000_000]);
  });

  it('rejects splitting across nothing', () => {
    expect(() => allocate(100, [0, 0])).toThrow(CalcError);
  });
});

describe('edge cases', () => {
  const costs = (amountCents: number) =>
    [{ category: 'ingredient', description: 'x', amountCents, scope: 'shared', targetProductIds: [] }] as RunInput['costs'];

  it('single product takes the whole shared cost', () => {
    const r = calculateRun({
      products: [
        { productId: 1, loosePieces: 0, rejectedPieces: 0, packings: [{ packSizeId: 1, piecesPerPack: 12, retailPriceCents: 10000, packagingCostCents: 0, packs: 10 }] },
      ],
      costs: costs(60000),
    });
    expect(r.products[0]!.sharedShareCents).toBe(60000);
    // 600.00 / 120 pieces = 5.00 per piece -> 60.00 per pack of 12
    expect(r.products[0]!.packings[0]!.packCostCents).toBe(6000);
    expect(r.products[0]!.packings[0]!.marginPct).toBeCloseTo(40, 5);
    expect(r.products[0]!.packings[0]!.markupPct!).toBeCloseTo(66.6667, 3);
  });

  it('splits a specific cost shared by several products by pieces made', () => {
    const r = calculateRun({
      products: [
        { productId: 1, loosePieces: 100, rejectedPieces: 0, packings: [] },
        { productId: 2, loosePieces: 300, rejectedPieces: 0, packings: [] },
        { productId: 3, loosePieces: 600, rejectedPieces: 0, packings: [] },
      ],
      costs: [{ category: 'other', description: 'cheese', amountCents: 4000, scope: 'specific', targetProductIds: [1, 2] }],
    });
    expect(r.products.map((p) => p.specificCents)).toEqual([1000, 3000, 0]);
    expect(r.totalCostCents).toBe(4000);
  });

  it('rejected pieces raise the cost of each good piece', () => {
    const r = calculateRun({
      products: [{ productId: 1, loosePieces: 90, rejectedPieces: 10, packings: [] }],
      costs: costs(9000),
    });
    expect(r.products[0]!.goodPieces).toBe(90);
    expect(r.products[0]!.costPerGoodPiece).toBe(100);
  });

  it('rejects a product with no good pieces', () => {
    expect(() =>
      calculateRun({ products: [{ productId: 1, loosePieces: 0, rejectedPieces: 5, packings: [] }], costs: costs(100) }),
    ).toThrow(/good piece/);
  });

  it('rejects a product that made nothing', () => {
    expect(() =>
      calculateRun({ products: [{ productId: 1, loosePieces: 0, rejectedPieces: 0, packings: [] }], costs: costs(100) }),
    ).toThrow(CalcError);
  });

  it('rejects a specific cost with no product or an unknown product', () => {
    const products = [{ productId: 1, loosePieces: 10, rejectedPieces: 0, packings: [] }];
    expect(() =>
      calculateRun({ products, costs: [{ category: 'other', description: 'a', amountCents: 100, scope: 'specific', targetProductIds: [] }] }),
    ).toThrow(CalcError);
    expect(() =>
      calculateRun({ products, costs: [{ category: 'other', description: 'a', amountCents: 100, scope: 'specific', targetProductIds: [9] }] }),
    ).toThrow(/not in this run/);
  });

  it('rejects fractions and negatives', () => {
    expect(() =>
      calculateRun({ products: [{ productId: 1, loosePieces: 1.5, rejectedPieces: 0, packings: [] }], costs: costs(100) }),
    ).toThrow(CalcError);
    expect(() =>
      calculateRun({ products: [{ productId: 1, loosePieces: 5, rejectedPieces: 0, packings: [] }], costs: costs(-1) }),
    ).toThrow(CalcError);
  });

  it('packaging only: zero ingredient cost gives pack cost equal to packaging', () => {
    const r = calculateRun({
      products: [
        { productId: 1, loosePieces: 0, rejectedPieces: 0, packings: [{ packSizeId: 1, piecesPerPack: 12, retailPriceCents: 5000, packagingCostCents: 300, packs: 5 }] },
      ],
      costs: [],
    });
    expect(r.products[0]!.packings[0]!.packCostCents).toBe(300);
    expect(r.totalCostCents).toBe(1500);
  });

  it('shows a negative margin when cost is above the retail price', () => {
    const r = calculateRun({
      products: [
        { productId: 1, loosePieces: 0, rejectedPieces: 0, packings: [{ packSizeId: 1, piecesPerPack: 10, retailPriceCents: 5000, packagingCostCents: 0, packs: 1 }] },
      ],
      costs: costs(10000),
    });
    expect(r.products[0]!.packings[0]!.packCostCents).toBe(10000);
    expect(r.products[0]!.packings[0]!.marginPct).toBeCloseTo(-100, 5);
  });

  it('uneven rounding keeps product costs adding up to the run total', () => {
    const r = calculateRun({
      products: [
        { productId: 1, loosePieces: 7, rejectedPieces: 0, packings: [] },
        { productId: 2, loosePieces: 11, rejectedPieces: 0, packings: [] },
        { productId: 3, loosePieces: 13, rejectedPieces: 0, packings: [] },
      ],
      costs: costs(100001),
    });
    expect(r.products.reduce((a, p) => a + p.totalCostCents, 0)).toBe(100001);
  });
});
