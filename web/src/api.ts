import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your internet connection and try again.', 0);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    // Signed out (for example the session expired): let the app go back to the login page.
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/password')) window.dispatchEvent(new Event('signed-out'));
    throw new ApiError(data?.error ?? `Something went wrong (${res.status}).`, res.status, data?.code);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
};

/** Load data when the page opens or `deps` change. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    load().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: Error) => {
        if (!alive) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

// ---- Types returned by the server (money is whole centavos) ----

export interface PackSize {
  id: number;
  productId: number;
  piecesPerPack: number;
  retailPriceCents: number;
  resellerPriceCents: number | null;
  packagingCostCents: number;
  isDefault: boolean;
  active: boolean;
}

/** One entry in a product's price history: a pack size's values after a change, and who made it. */
export interface PackSizeChange {
  id: number;
  packSizeId: number;
  piecesPerPack: number;
  kind: 'created' | 'updated';
  retailPriceCents: number;
  resellerPriceCents: number | null;
  packagingCostCents: number;
  isDefault: boolean;
  active: boolean;
  changedByName: string;
  changedAt: string;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  shelfLifeDays: number;
  notes: string;
  active: boolean;
  packSizes: PackSize[];
}

export type CostCategory = 'ingredient' | 'gas' | 'electricity' | 'labor' | 'other';

export interface RunBody {
  runDate: string;
  note: string;
  products: {
    productId: number;
    loosePieces: number;
    rejectedPieces: number;
    productionDate?: string;
    expiryDate?: string;
    packings: { packSizeId: number; packs: number }[];
  }[];
  costs: {
    category: CostCategory;
    description: string;
    amountCents: number;
    scope: 'shared' | 'specific';
    targetProductIds: number[];
  }[];
}

export interface PackingResult {
  packSizeId: number;
  piecesPerPack: number;
  retailPriceCents: number;
  packagingCostCents: number;
  packs: number;
  packCostCents: number;
  marginPct: number;
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
  costPerGoodPiece: number;
  packings: PackingResult[];
}

export interface RunPreview {
  result: {
    products: ProductResult[];
    sharedCents: number;
    specificCents: number;
    packagingCents: number;
    totalCostCents: number;
  };
  products: { productId: number; code: string; name: string; productionDate: string; expiryDate: string; batchCode: string }[];
}

export interface RunSummary {
  id: number;
  runDate: string;
  note: string;
  status: 'saved' | 'void';
  totalCostCents: number;
  productNames: string;
  goodPieces: number;
}

export interface RunDetail {
  id: number;
  runDate: string;
  note: string;
  status: 'saved' | 'void';
  voidReason: string | null;
  voidedAt: string | null;
  totalCostCents: number;
  createdAt: string;
  /** Who recorded the run; empty for runs saved before the audit trail existed. */
  createdByName: string;
  voidedByName: string | null;
  products: (Omit<ProductResult, 'packings'> & {
    id: number;
    productCode: string;
    productName: string;
    batchCode: string;
    productionDate: string;
    expiryDate: string;
    costPerGoodPiece: number;
    packings: (PackingResult & { id: number })[];
  })[];
  costs: {
    id: number;
    category: CostCategory;
    description: string;
    amountCents: number;
    scope: 'shared' | 'specific';
    targetRunProductIds: number[];
  }[];
}

export interface ExpiryBatch {
  runProductId: number;
  runId: number;
  batchCode: string;
  productName: string;
  productionDate: string;
  expiryDate: string;
  goodPieces: number;
  daysRemaining: number;
}

export interface MarginRow {
  productId: number;
  productName: string;
  productCode: string;
  piecesPerPack: number;
  runId: number;
  runDate: string;
  batchCode: string;
  packCostCents: number;
  runRetailPriceCents: number;
  runMarginPct: number;
  runMarkupPct: number | null;
  currentRetailPriceCents: number | null;
  currentMarginPct: number | null;
  currentMarkupPct: number | null;
  packActive: boolean;
}

// ---- Accounts and subscriptions ----

export type AccessLevel = 'full' | 'read_only' | 'blocked';
export type TenantStatus = 'trial' | 'active' | 'cancelled' | 'suspended';

export interface Access {
  level: AccessLevel;
  message: string | null;
  daysLeft: number | null;
}

export interface Me {
  user: { id: number; email: string; name: string; role: 'owner' | 'staff' | 'platform_admin' };
  tenant: { id: number; name: string; status: TenantStatus; trialEndsOn: string; paidThrough: string | null; access: Access } | null;
}

export interface Person {
  id: number;
  email: string;
  name: string;
  role: 'owner' | 'staff';
  active: boolean;
  hasPassword: boolean;
  lastLoginAt: string | null;
}

export interface AdminTenant {
  id: number;
  name: string;
  status: TenantStatus;
  trialEndsOn: string;
  paidThrough: string | null;
  notes: string;
  createdAt: string;
  ownerId: number | null;
  ownerEmail: string | null;
  ownerName: string | null;
  ownerHasPassword: boolean | null;
  savedRuns: number;
  people: number;
  lastLoginAt: string | null;
  access: Access;
}

export interface Payment {
  id: number;
  amountCents: number;
  method: string;
  reference: string;
  paidOn: string;
  months: number;
  note: string;
}
