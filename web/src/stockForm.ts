// What the ingredient screens show and check before anything is sent. Plain functions with no React, so
// they can be tested on their own (server/tests/stockForm.test.ts). The server still checks everything.

import { dateText, peso } from './format';

export type BaseUnit = 'g' | 'mL' | 'pc';
export type EntryUnit = BaseUnit | 'kg' | 'L';

/** The units a purchase can be typed in, most usual first. kg and L are turned into g and mL by the server. */
export const ENTRY_UNITS: Record<BaseUnit, EntryUnit[]> = { g: ['kg', 'g'], mL: ['L', 'mL'], pc: ['pc'] };

export const BASE_UNIT_NAMES: Record<BaseUnit, string> = { g: 'grams (g)', mL: 'millilitres (mL)', pc: 'pieces (pc)' };

/** Thousandths of the base unit, shown exactly: 1250500 g -> "1,250.5 g". */
export function quantityText(milli: number, baseUnit: BaseUnit): string {
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000).toLocaleString('en-PH');
  const fraction = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${milli < 0 ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''} ${baseUnit}`;
}

/**
 * The average cost as the owner thinks of it: per kg or L, or per piece. It is stored in 1/10,000 centavo
 * per base unit, so 1,000,000 is ₱1.00 per g, which is ₱1,000.00 per kg.
 */
export function averageText(avgE4: number | null | undefined, baseUnit: BaseUnit): string {
  if (avgE4 === null || avgE4 === undefined) return '–';
  if (baseUnit === 'pc') {
    // Pieces can be cheap, so show centavos to two more places: ₱0.3540 per pc.
    const pesos = avgE4 / 1_000_000;
    return `₱${pesos.toLocaleString('en-PH', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} per pc`;
  }
  return `${peso(Math.round(avgE4 / 10))} per ${baseUnit === 'g' ? 'kg' : 'L'}`;
}

export type QuantityCheck = { quantity: string; error?: undefined } | { quantity?: undefined; error: string };

/**
 * Check a typed quantity before it is sent, and tidy it. A comma is refused rather than guessed: "1,5" may be
 * one and a half and "1,500" may be fifteen hundred. "12.0" pieces is taken as 12 (P4-12).
 */
export function checkQuantity(text: string, unit: EntryUnit): QuantityCheck {
  let t = text.trim();
  if (t === '') return { error: 'Type the quantity.' };
  if (t.includes(',')) return { error: 'Use a dot, not a comma, for decimals, for example 1.5. Type thousands without commas, for example 1500.' };
  if (unit === 'pc' && /^\d+\.0+$/.test(t)) t = t.slice(0, t.indexOf('.'));
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: 'Type the quantity as a number, for example 2.5.' };
  return { quantity: t };
}

/**
 * What a quantity typed in kg or L comes to in the base unit, exactly, so a slip such as 500 kg for 500 g shows
 * before saving: "2.5" kg -> "= 2,500 g". Null for the base unit itself or text that is not a plain number.
 */
export function convertedText(text: string, unit: EntryUnit): string | null {
  if (unit !== 'kg' && unit !== 'L') return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m || m[1]!.length > 15) return null;
  const fraction = (m[2] ?? '').padEnd(3, '0');
  const whole = BigInt(m[1]! + fraction.slice(0, 3)).toLocaleString('en-PH');
  const rest = fraction.slice(3).replace(/0+$/, '');
  return `= ${whole}${rest ? `.${rest}` : ''} ${unit === 'kg' ? 'g' : 'mL'}`;
}

/** Whether a date is more than a year before today (D-41). Both are YYYY-MM-DD. */
export function overAYearAgo(date: string, today: string): boolean {
  const [y, m, d] = today.split('-');
  const sameDayLastYear = `${String(Number(y) - 1).padStart(4, '0')}-${m}-${m === '02' && d === '29' ? '28' : d}`;
  return date < sameDayLastYear;
}

export interface PurchaseWarningInput {
  date: string;
  expiryDate: string;
  lastCountDate: string | null;
  isOwner: boolean;
}

/** What an entry is called in the D-44 warning: "A purchase dated on or before a count ...". */
const ENTRY_WORDS = {
  purchase: { subject: 'A purchase' },
  opening: { subject: 'An opening balance' },
  spillage: { subject: 'A spillage entry' },
  spoilage: { subject: 'A spoilage entry' },
} as const;
export type WarnedEntry = keyof typeof ENTRY_WORDS;

/**
 * D-44, owner wording. A count stores only the difference from its own date and is not worked out again, so an entry
 * dated on or before it moves on hand away from what was counted (and can change later averages). Since D-46 a count is
 * replayed last on its date, so the old line about a count on the entry's own date is gone.
 */
function ownerRecountWarning(entry: WarnedEntry, date: string, lastCountDate: string): string {
  const { subject } = ENTRY_WORDS[entry];
  return (
    `This ingredient was last counted on ${dateText(lastCountDate)}. ${subject} dated on or before a count moves on hand away from what was counted, ` +
    'and can change the average. To put it right after saving, enter again every count dated on or after ' +
    `${dateText(date)}, each on its own date with the number you counted then, oldest first. Once the first is entered ` +
    'again, the later ones will usually answer "nothing to correct", which means stock is right. A count dated today ' +
    'puts stock right but may not put the average right.'
  );
}

/** Warnings shown on the purchase form while typing. None of them stops the purchase being saved. */
export function purchaseWarnings({ date, expiryDate, lastCountDate, isOwner }: PurchaseWarningInput): string[] {
  const warnings: string[] = [];
  // D-40: short-dated stock is real, but this is usually a typing slip.
  if (date && expiryDate && expiryDate < date) {
    warnings.push('The expiry date is before the purchase date. Check both dates. You can still save it if they are right.');
  }
  if (date && lastCountDate && date <= lastCountDate) {
    warnings.push(
      isOwner
        ? ownerRecountWarning('purchase', date, lastCountDate)
        : `This ingredient was last counted on ${dateText(lastCountDate)}. A purchase dated on or before that makes on hand differ from the count. ` +
            `You can still save it. Then tell the owner you entered a purchase dated ${dateText(date)}, so they can put the counts right.`,
    );
  }
  return warnings;
}

export type CorrectionKind = 'count_correction' | 'spillage' | 'spoilage' | 'opening';

/**
 * Warnings on the owner's correction forms (D-44), never blocking. An opening balance, spillage or spoilage dated on
 * or before the latest count; a count dated strictly before the latest count (one on the same date as it is fine).
 */
export function correctionWarnings({ kind, date, lastCountDate }: { kind: CorrectionKind; date: string; lastCountDate: string | null }): string[] {
  if (!date || !lastCountDate) return [];
  if (kind === 'count_correction') {
    if (date >= lastCountDate) return [];
    return [
      `This ingredient was last counted on ${dateText(lastCountDate)}. A count dated before a later count moves on hand away from what that later count found. ` +
        `To put it right after saving, enter again every count dated after ${dateText(date)}, each on its own date with the number you counted then, ` +
        'oldest first. Once the first is entered again, the later ones will usually answer "nothing to correct", which means stock is right. ' +
        'A count dated today puts stock right but may not put the average right.',
    ];
  }
  return date <= lastCountDate ? [ownerRecountWarning(kind, date, lastCountDate)] : [];
}

/** D-51: shown on the count form. A count is the stock at the end of its day, and it is worked out after the other entries of that day. */
export const COUNT_END_OF_DAY_NOTE = 'A count is the stock at the end of the day. Count after the day’s runs and other entries are done and entered.';

/** The line shown for each kind of ledger line. */
export const MOVEMENT_LABELS: Record<string, string> = {
  purchase: 'Purchase',
  opening: 'Opening balance',
  purchase_reversal: 'Reversal',
  run_use: 'Used in a run',
  void_return: 'Returned from a voided run',
  spillage: 'Spillage',
  spoilage: 'Spoilage',
  count_correction: 'Count',
};

export function movementLabel(kind: string): string {
  return MOVEMENT_LABELS[kind] ?? kind;
}

/** A change in quantity with its sign: "+1,000 mL", "-200 mL". */
export function changeText(milli: number, baseUnit: BaseUnit): string {
  return `${milli > 0 ? '+' : ''}${quantityText(milli, baseUnit)}`;
}

/**
 * The notice on a line entered after a count that no longer matches (D-44). `countDate` is the oldest such count, where
 * entering counts again starts. For a count line the instruction says "after", so it never asks for that count again.
 */
export function recountNotice(lineDate: string, countDate: string, lineIsCount = false): string {
  const start = lineIsCount
    ? `A later count, dated ${dateText(countDate)}, no longer matches. Enter again every count dated after ${dateText(lineDate)}, oldest first.`
    : `The count dated ${dateText(countDate)} no longer matches. Enter again every count dated on or after ${dateText(countDate)}, oldest first.`;
  return `${start} A count that answers "nothing to correct" is fine: it means stock is right.`;
}

/** What the owner is told after a correction is saved: the figure the server stored, and on hand now. */
export function correctionSavedText(input: {
  kind: CorrectionKind;
  date: string;
  baseUnit: BaseUnit;
  /** The stored signed change, thousandths. */
  quantityMilli: number;
  totalCostCents?: number | null;
  onHandNowMilli: number;
}): string {
  const { kind, date, baseUnit, quantityMilli, onHandNowMilli } = input;
  const now = `On hand now ${quantityText(onHandNowMilli, baseUnit)}.`;
  switch (kind) {
    case 'count_correction':
      return `Saved the count dated ${dateText(date)}. The difference recorded is ${changeText(quantityMilli, baseUnit)}. ${now}`;
    case 'opening':
      return `Saved the opening balance of ${quantityText(quantityMilli, baseUnit)} for ${peso(input.totalCostCents)}, dated ${dateText(date)}. ${now}`;
    default:
      return `Saved ${kind === 'spillage' ? 'the spillage' : 'the spoilage'} of ${quantityText(-quantityMilli, baseUnit)}, dated ${dateText(date)}. ${now}`;
  }
}

/** The server's answer to a detail correction that changes nothing. Not an error: nothing was saved, and nothing was wrong. */
export function isNothingToChange(message: string): boolean {
  return message.startsWith('Nothing to change');
}

/** The server's answer to a count that matches the recorded stock. It means stock is right, so it is not shown as an error. */
export function isNothingToCorrect(message: string): boolean {
  return message.startsWith('Nothing to correct');
}
