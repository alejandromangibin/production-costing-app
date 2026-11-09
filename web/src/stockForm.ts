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

/** Warnings shown on the purchase form while typing. None of them stops the purchase being saved. */
export function purchaseWarnings({ date, expiryDate, lastCountDate, isOwner }: PurchaseWarningInput): string[] {
  const warnings: string[] = [];
  // D-40: short-dated stock is real, but this is usually a typing slip.
  if (date && expiryDate && expiryDate < date) {
    warnings.push('The expiry date is before the purchase date. Check both dates. You can still save it if they are right.');
  }
  // D-44: a count stores only the difference from its own date and is not worked out again, so an entry dated
  // on or before it moves on hand away from what was counted (and can change later averages).
  if (date && lastCountDate && date <= lastCountDate) {
    const when = dateText(lastCountDate);
    warnings.push(
      isOwner
        ? `This ingredient was last counted on ${when}. A purchase dated on or before a count moves on hand away from what was counted, ` +
            'and can change the average. To put it right after saving, enter again every count dated on or after ' +
            `${dateText(date)}, each on its own date with the number you counted then, oldest first. Once the first is entered ` +
            'again, the later ones will usually answer "nothing to correct", which means stock is right. A count dated today, ' +
            "or on this purchase's own date, puts stock right but may not put the average right."
        : `This ingredient was last counted on ${when}. A purchase dated on or before that makes on hand differ from the count. ` +
            `You can still save it. Then tell the owner you entered a purchase dated ${dateText(date)}, so they can put the counts right.`,
    );
  }
  return warnings;
}

