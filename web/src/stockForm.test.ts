// The purchase form's own checks and wording (P4-12). They live in the web app; the server checks again.
import { describe, expect, it } from 'vitest';
import { parseCents, todayIn } from './format';
import {
  averageText,
  changeText,
  checkQuantity,
  convertedText,
  correctionSavedText,
  COUNT_END_OF_DAY_NOTE,
  correctionWarnings,
  isNothingToCorrect,
  movementLabel,
  overAYearAgo,
  purchaseWarnings,
  quantityText,
  recountNotice,
} from './stockForm';

describe('quantities on the ingredient list', () => {
  it('shows thousandths exactly, with no rounding', () => {
    expect(quantityText(0, 'g')).toBe('0 g');
    expect(quantityText(1_250_500, 'g')).toBe('1,250.5 g');
    expect(quantityText(1, 'mL')).toBe('0.001 mL');
    expect(quantityText(12_000, 'pc')).toBe('12 pc');
    expect(quantityText(-2_500, 'g')).toBe('-2.5 g');
    expect(quantityText(9_007_199_254_740_991, 'g')).toBe('9,007,199,254,740.991 g');
  });
});

describe('the average cost the owner sees', () => {
  it('is per kg or L for weights and volumes, and per piece for pieces', () => {
    expect(averageText(1_000_000, 'g')).toBe('₱1,000.00 per kg'); // ₱1.00 per g
    expect(averageText(110_040, 'mL')).toBe('₱110.04 per L'); // ₱0.11004 per mL
    expect(averageText(3_540, 'pc')).toBe('₱0.0035 per pc');
    expect(averageText(3_540_000, 'pc')).toBe('₱3.5400 per pc');
    expect(averageText(5, 'g')).toBe('₱0.01 per kg'); // rounded half up, shown, never stored
    expect(averageText(4, 'g')).toBe('₱0.00 per kg');
  });

  it('shows a dash before the first purchase', () => {
    expect(averageText(null, 'g')).toBe('–');
    expect(averageText(undefined, 'pc')).toBe('–');
  });
});

describe('checking a typed quantity', () => {
  it('passes plain numbers through, trimmed', () => {
    expect(checkQuantity(' 2.5 ', 'kg')).toEqual({ quantity: '2.5' });
    expect(checkQuantity('1500', 'g')).toEqual({ quantity: '1500' });
  });

  it('refuses a comma instead of guessing what it meant', () => {
    for (const text of ['1,5', '1,500', '1,500.25']) {
      expect(checkQuantity(text, 'kg').error).toBe('Use a dot, not a comma, for decimals, for example 1.5. Type thousands without commas, for example 1500.');
    }
  });

  it('takes 12.0 pieces as 12, but leaves real fractions for the server to refuse', () => {
    expect(checkQuantity('12.0', 'pc')).toEqual({ quantity: '12' });
    expect(checkQuantity('12.000', 'pc')).toEqual({ quantity: '12' });
    expect(checkQuantity('12.5', 'pc')).toEqual({ quantity: '12.5' });
    expect(checkQuantity('12.0', 'kg')).toEqual({ quantity: '12.0' });
  });

  it('asks for a number when it is blank or not one', () => {
    expect(checkQuantity('  ', 'g').error).toBe('Type the quantity.');
    for (const text of ['abc', '-1', '1.', '.5', '1e3', '2 kg', '١٢']) {
      expect(checkQuantity(text, 'g').error).toBe('Type the quantity as a number, for example 2.5.');
    }
  });
});

describe('showing what kg and L come to', () => {
  it('converts exactly, so 500 kg typed for 500 g stands out', () => {
    expect(convertedText('500', 'kg')).toBe('= 500,000 g');
    expect(convertedText('2.5', 'L')).toBe('= 2,500 mL');
    expect(convertedText(' 0.0005 ', 'kg')).toBe('= 0.5 g');
    expect(convertedText('1.234567', 'kg')).toBe('= 1,234.567 g');
    expect(convertedText('10000', 'kg')).toBe('= 10,000,000 g');
  });

  it('shows nothing for the base unit or for text that is not a plain number', () => {
    for (const unit of ['g', 'mL', 'pc'] as const) expect(convertedText('500', unit)).toBeNull();
    for (const text of ['', '1,5', 'abc', '1.', '9'.repeat(16)]) expect(convertedText(text, 'kg')).toBeNull();
  });
});

describe('reading the total paid', () => {
  it('takes commas only as thousands separators', () => {
    expect(parseCents('1,250.50')).toBe(125_050);
    expect(parseCents('1,250')).toBe(125_000);
    expect(parseCents('1,000,000')).toBe(100_000_000);
    expect(parseCents('₱1,250.50')).toBe(125_050);
    expect(parseCents('1250.5')).toBe(125_050);
  });

  it('refuses a comma used as the decimal point instead of reading it 100 times too high', () => {
    for (const text of ['1250,50', '1,5', '1,50', '12,50', '1,2345', ',500', '1,,000', '1250.50,']) {
      expect(parseCents(text)).toBeNull();
    }
  });
});

describe("the business's today", () => {
  it('follows the business time zone, not the device clock', () => {
    // 20:00 UTC on Nov 9 is already 04:00 on Nov 10 in Manila.
    const late = new Date('2026-11-09T20:00:00Z');
    expect(todayIn('Asia/Manila', late)).toBe('2026-11-10');
    expect(todayIn('UTC', late)).toBe('2026-11-09');
    expect(todayIn('Asia/Manila', new Date('2026-11-09T15:59:59Z'))).toBe('2026-11-09');
  });
});

describe('asking about a date over a year old (D-41)', () => {
  it('asks only for dates before the same day last year', () => {
    expect(overAYearAgo('2025-11-09', '2026-11-09')).toBe(false);
    expect(overAYearAgo('2025-11-08', '2026-11-09')).toBe(true);
    expect(overAYearAgo('0206-11-09', '2026-11-09')).toBe(true);
    expect(overAYearAgo('2026-11-09', '2026-11-09')).toBe(false);
  });

  it('treats 29 February as the 28th a year earlier', () => {
    expect(overAYearAgo('2027-02-28', '2028-02-29')).toBe(false);
    expect(overAYearAgo('2027-02-27', '2028-02-29')).toBe(true);
  });
});

describe('warnings on the purchase form', () => {
  const base = { date: '2026-11-09', expiryDate: '', lastCountDate: null, isOwner: true };

  it('gives none for an ordinary purchase', () => {
    expect(purchaseWarnings(base)).toEqual([]);
    expect(purchaseWarnings({ ...base, expiryDate: '2026-11-09', lastCountDate: '2026-11-08' })).toEqual([]);
  });

  it('warns, without blocking, when the expiry date is before the purchase date (D-40)', () => {
    expect(purchaseWarnings({ ...base, expiryDate: '2026-11-08' })).toEqual([
      'The expiry date is before the purchase date. Check both dates. You can still save it if they are right.',
    ]);
  });

  it('warns when the purchase is dated on or before the latest count, and says how to put it right (D-44)', () => {
    const [owner] = purchaseWarnings({ ...base, date: '2026-10-01', lastCountDate: '2026-11-03' });
    expect(owner).toBe(
      'This ingredient was last counted on Nov 3, 2026. A purchase dated on or before a count moves on hand away from what was counted, ' +
        'and can change the average. To put it right after saving, enter again every count dated on or after Oct 1, 2026, each on its ' +
        'own date with the number you counted then, oldest first. Once the first is entered again, the later ones will usually answer ' +
        '"nothing to correct", which means stock is right. A count dated today puts stock right ' +
        'but may not put the average right.',
    );
    // A count is the stock at the end of its day, so a purchase on that same day moves it too.
    expect(purchaseWarnings({ ...base, date: '2026-11-03', lastCountDate: '2026-11-03' })[0]).toContain('on or after Nov 3, 2026');
    const [staff] = purchaseWarnings({ ...base, date: '2026-10-01', lastCountDate: '2026-11-03', isOwner: false });
    expect(staff).toBe(
      'This ingredient was last counted on Nov 3, 2026. A purchase dated on or before that makes on hand differ from the count. ' +
        'You can still save it. Then tell the owner you entered a purchase dated Oct 1, 2026, so they can put the counts right.',
    );
    expect(staff).not.toMatch(/average/i);
  });

  it('can give both warnings at once', () => {
    expect(purchaseWarnings({ ...base, date: '2026-11-01', expiryDate: '2026-10-30', lastCountDate: '2026-11-03' })).toHaveLength(2);
  });
});

describe('what each kind of stock change is called', () => {
  it('uses plain words for every kind the ledger allows', () => {
    expect(['purchase', 'opening', 'purchase_reversal', 'run_use', 'void_return', 'spillage', 'spoilage', 'count_correction'].map(movementLabel)).toEqual([
      'Purchase',
      'Opening balance',
      'Reversal',
      'Used in a run',
      'Returned from a voided run',
      'Spillage',
      'Spoilage',
      'Count',
    ]);
    expect(movementLabel('something_new')).toBe('something_new');
  });

  it('shows a change with its sign', () => {
    expect(changeText(1_000_000, 'mL')).toBe('+1,000 mL');
    expect(changeText(-200_000, 'mL')).toBe('-200 mL');
    expect(changeText(0, 'pc')).toBe('0 pc');
  });
});

describe('warnings on the owner correction forms (D-44)', () => {
  const last = '2026-11-03';

  it('warns for an opening balance, spillage or spoilage dated on or before the latest count, in the purchase wording', () => {
    const purchase = purchaseWarnings({ date: '2026-10-01', expiryDate: '', lastCountDate: last, isOwner: true })[0]!;
    expect(correctionWarnings({ kind: 'spillage', date: '2026-10-01', lastCountDate: last })).toEqual([
      purchase.replace('A purchase dated', 'A spillage entry dated'),
    ]);
    const [opening] = correctionWarnings({ kind: 'opening', date: '2026-11-03', lastCountDate: last });
    expect(opening).toContain('This ingredient was last counted on Nov 3, 2026. An opening balance dated on or before a count moves on hand');
    expect(opening).toContain('every count dated on or after Nov 3, 2026');
    expect(opening).toContain('"nothing to correct"');
    expect(opening).toContain('A count dated today puts stock right but may not put the average right.');
    expect(opening).not.toContain('own date, puts');
    expect(correctionWarnings({ kind: 'spoilage', date: '2026-11-03', lastCountDate: last })[0]).toContain('A spoilage entry dated on or before a count');
  });

  it('does not warn after the latest count, or when there has been no count', () => {
    expect(correctionWarnings({ kind: 'spillage', date: '2026-11-04', lastCountDate: last })).toEqual([]);
    expect(correctionWarnings({ kind: 'opening', date: '2026-10-01', lastCountDate: null })).toEqual([]);
    expect(correctionWarnings({ kind: 'count_correction', date: '2026-10-01', lastCountDate: null })).toEqual([]);
    expect(correctionWarnings({ kind: 'spillage', date: '', lastCountDate: last })).toEqual([]);
  });

  it('warns for a count dated strictly before the latest count, but not one on the same date or later', () => {
    const [w] = correctionWarnings({ kind: 'count_correction', date: '2026-10-01', lastCountDate: last });
    expect(w).toContain('last counted on Nov 3, 2026');
    expect(w).toContain('enter again every count dated after Oct 1, 2026');
    expect(w).toContain('oldest first');
    expect(w).toContain('"nothing to correct"');
    expect(w).toContain('A count dated today puts stock right but may not put the average right.');
    expect(correctionWarnings({ kind: 'count_correction', date: last, lastCountDate: last })).toEqual([]);
    expect(correctionWarnings({ kind: 'count_correction', date: '2026-11-04', lastCountDate: last })).toEqual([]);
  });
});

describe('what the owner reads after a save', () => {
  it('says what a count stored, not what was typed', () => {
    expect(correctionSavedText({ kind: 'count_correction', date: '2026-11-03', baseUnit: 'mL', quantityMilli: -200_000, onHandNowMilli: 1_800_000 })).toBe(
      'Saved the count dated Nov 3, 2026. The difference recorded is -200 mL. On hand now 1,800 mL.',
    );
    expect(correctionSavedText({ kind: 'count_correction', date: '2026-11-03', baseUnit: 'g', quantityMilli: 500_000, onHandNowMilli: 2_500_000 })).toContain(
      'difference recorded is +500 g',
    );
  });

  it('says the amount lost for spillage and spoilage, and the cost for an opening balance', () => {
    expect(correctionSavedText({ kind: 'spillage', date: '2026-11-03', baseUnit: 'mL', quantityMilli: -500_000, onHandNowMilli: 0 })).toBe(
      'Saved the spillage of 500 mL, dated Nov 3, 2026. On hand now 0 mL.',
    );
    expect(correctionSavedText({ kind: 'spoilage', date: '2026-11-03', baseUnit: 'pc', quantityMilli: -3_000, onHandNowMilli: -1_000 })).toBe(
      'Saved the spoilage of 3 pc, dated Nov 3, 2026. On hand now -1 pc.',
    );
    expect(correctionSavedText({ kind: 'opening', date: '2026-11-03', baseUnit: 'g', quantityMilli: 2_000_000, totalCostCents: 125_050, onHandNowMilli: 2_000_000 })).toBe(
      'Saved the opening balance of 2,000 g for ₱1,250.50, dated Nov 3, 2026. On hand now 2,000 g.',
    );
  });

  it('recognises the server answer for a matching count, which is good news and not an error', () => {
    expect(isNothingToCorrect('Nothing to correct: the count matches the recorded stock for that date.')).toBe(true);
    expect(isNothingToCorrect('The date cannot be in the future.')).toBe(false);
  });

  it('words the notice on a line that needs a recount, naming the oldest count that no longer matches', () => {
    expect(recountNotice('2026-10-01', '2026-11-03')).toBe(
      'The count dated Nov 3, 2026 no longer matches. Enter again every count dated on or after Nov 3, 2026, oldest first. ' +
        'A count that answers "nothing to correct" is fine: it means stock is right.',
    );
  });

  it('never asks for a count line itself to be entered again', () => {
    const text = recountNotice('2026-10-01', '2026-11-03', true);
    expect(text).toBe(
      'A later count, dated Nov 3, 2026, no longer matches. Enter again every count dated after Oct 1, 2026, oldest first. ' +
        'A count that answers "nothing to correct" is fine: it means stock is right.',
    );
    expect(text).not.toContain('on or after');
  });
});

describe('the stock count form note (D-51)', () => {
  it('says a count is the stock at the end of the day', () => {
    expect(COUNT_END_OF_DAY_NOTE).toBe('A count is the stock at the end of the day. Count after the day’s runs and other entries are done and entered.');
  });
});
