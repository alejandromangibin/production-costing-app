import { z } from 'zod';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

const count = z.number().int().min(0).max(10_000_000);
const cents = z.number().int().min(0).max(2_000_000_000);

export const packSizeCreate = z.object({
  piecesPerPack: z.number().int().min(1).max(10_000),
  retailPriceCents: cents.refine((n) => n > 0, 'Retail price must be more than zero'),
  resellerPriceCents: cents.refine((n) => n > 0, 'Reseller price must be more than zero').nullable().optional(),
  packagingCostCents: cents.default(0),
  isDefault: z.boolean().optional(),
});

export const packSizeUpdate = z.object({
  retailPriceCents: cents.refine((n) => n > 0, 'Retail price must be more than zero').optional(),
  resellerPriceCents: cents.refine((n) => n > 0, 'Reseller price must be more than zero').nullable().optional(),
  packagingCostCents: cents.optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const productCreate = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{1,12}$/, 'Code: 1 to 12 letters, numbers or dashes'),
  name: z.string().trim().min(1, 'Name is required').max(80),
  shelfLifeDays: z.number().int().min(0).max(3650),
  notes: z.string().trim().max(500).default(''),
  packSizes: z.array(packSizeCreate).max(20).default([]),
});

export const productUpdate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  shelfLifeDays: z.number().int().min(0).max(3650).optional(),
  notes: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
});

/**
 * Text that stays readable: no control or invisible characters. PostgreSQL text cannot hold a NUL at all
 * (it would be a server error), and invisible characters make a name look blank or look like another one.
 */
const noHiddenCharacters = (s: string) => !/[\p{Cc}\p{Cf}]/u.test(s);
const plainText = (schema: z.ZodString) => schema.refine(noHiddenCharacters, 'Remove the hidden or control characters');

const ingredientName = plainText(z.string().trim().min(1, 'Name is required').max(80));
const baseUnit = z.enum(['g', 'mL', 'pc']);

export const ingredientCreate = z.object({
  name: ingredientName,
  baseUnit,
});

export const ingredientUpdate = z.object({
  name: ingredientName.optional(),
  baseUnit: baseUnit.optional(),
  active: z.boolean().optional(),
});

export const costCategory = z.enum(['ingredient', 'gas', 'electricity', 'labor', 'other']);

export const runBody = z.object({
  runDate: dateOnly,
  note: z.string().trim().max(500).default(''),
  products: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        loosePieces: count.default(0),
        rejectedPieces: count.default(0),
        productionDate: dateOnly.optional(),
        expiryDate: dateOnly.optional(),
        packings: z
          .array(z.object({ packSizeId: z.number().int().positive(), packs: count }))
          .max(20)
          .default([]),
      }),
    )
    .min(1, 'Add at least one product')
    .max(30),
  costs: z
    .array(
      z.object({
        category: costCategory,
        description: z.string().trim().max(120).default(''),
        amountCents: cents,
        scope: z.enum(['shared', 'specific']),
        targetProductIds: z.array(z.number().int().positive()).max(30).default([]),
      }),
    )
    .max(100)
    .default([]),
});
export type RunBody = z.infer<typeof runBody>;

export const voidBody = z.object({
  reason: z.string().trim().min(1, 'Give a reason').max(300),
});

export const runsQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  productId: z.coerce.number().int().positive().optional(),
  status: z.enum(['saved', 'void']).optional(),
  q: z.string().trim().max(80).optional(),
});

export const todayQuery = z.object({ today: dateOnly.optional() });

export const backupFile = z.object({
  app: z.literal('production-costing'),
  version: z.literal(2),
  /** The database version the backup was taken from. Restoring needs the same one. */
  schema: z.string(),
  exportedAt: z.string().optional(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

// ---- Accounts ----

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address').max(200));
const password = z.string().min(1, 'Enter a password').max(200);

export const loginBody = z.object({ email, password });
export const acceptBody = z.object({ token: z.string().min(10).max(200), password });
export const passwordBody = z.object({ currentPassword: password, newPassword: password });
export const inviteBody = z.object({ email, name: z.string().trim().min(1, 'Enter a name').max(80) });
export const activeBody = z.object({ active: z.boolean() });

export const tenantCreate = z.object({
  businessName: z.string().trim().min(1, 'Enter the business name').max(100),
  ownerEmail: email,
  ownerName: z.string().trim().min(1, 'Enter the owner name').max(80),
  trialDays: z.number().int().min(0).max(365).default(30),
});

export const tenantPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['trial', 'active', 'cancelled', 'suspended']).optional(),
  trialEndsOn: dateOnly.optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const paymentBody = z.object({
  amountCents: cents,
  method: z.string().trim().max(40).default(''),
  reference: z.string().trim().max(80).default(''),
  paidOn: dateOnly,
  months: z.number().int().min(1).max(36),
  note: z.string().trim().max(300).default(''),
});
