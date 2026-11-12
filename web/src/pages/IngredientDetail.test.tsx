import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MovementHistory } from '../api';
import { addDaysISO, dateText, todayIn } from '../format';
import { meFor, movement, renderPage, soy } from '../test/helpers';
import { IngredientDetail } from './IngredientDetail';

// The owner's page for one ingredient: price history, stock changes and corrections (INV-10, INV-08).

// Entered in this order: a purchase (id 1), a count (id 2), then a purchase dated before that count (id 3).
// Dates are worked from today, so the D-41 "is the year right?" question and the future-date limit never depend on when the
// tests run: the first purchase 40 days ago, the back-dated one 39 days ago, the count 36 days ago.
const day = (offset: number) => addDaysISO(todayIn('Asia/Manila'), offset);
const [D1, D2, D3] = [day(-40), day(-39), day(-36)] as [string, string, string];
const [T1, T2, T3] = [dateText(D1), dateText(D2), dateText(D3)];
const lines = [
  movement({
    id: 1, kind: 'purchase', effectiveDate: D1, quantityMilli: 1_000_000, totalCostCents: 10_000, unitPriceE4: 100_000,
    supplier: 'Mang Tony', reference: 'OR-7', onHandAfterMilli: 1_000_000, averageAfterE4: 100_000,
  }),
  movement({
    id: 3, kind: 'purchase', effectiveDate: D2, quantityMilli: 500_000, totalCostCents: 6_000, unitPriceE4: 120_000,
    onHandAfterMilli: 1_500_000, averageAfterE4: 106_667, needsRecount: D3,
  }),
  movement({
    id: 2, kind: 'count_correction', effectiveDate: D3, quantityMilli: -100_000, reason: 'Monthly count',
    onHandAfterMilli: 1_400_000, averageAfterE4: 106_667,
  }),
];

const history = (over: Partial<MovementHistory> = {}): MovementHistory => ({
  ingredient: { ...soy, onHandMilli: 1_400_000, avgCostE4: 106_667, lastCountDate: D3 },
  movements: lines,
  reversibleMovementId: 3,
  ...over,
});

const showDetail = (role: 'owner' | 'staff', data: MovementHistory = history(), extra = {}) =>
  renderPage(role, '/ingredients/1', '/ingredients/:id', <IngredientDetail />, { 'GET /ingredients/1/movements': () => ({ body: data }), ...extra });

describe('who can open the page', () => {
  it('gives staff only the owner-only message, and asks for no history', async () => {
    const { server } = await showDetail('staff');
    expect(screen.getByText(/Only the owner can see an ingredient’s price history/)).toBeTruthy();
    expect(screen.queryByText('Price history')).toBeNull();
    expect(server.calls.filter((c) => c.includes('movements'))).toEqual([]);
  });

  it('shows the owner the price history and the stock changes', async () => {
    await showDetail('owner');
    expect(await screen.findByRole('heading', { name: 'Price history' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Stock changes' })).toBeTruthy();
    const priceRow = screen.getByRole('row', { name: /Mang Tony/ });
    expect(within(priceRow).getByText('OR-7')).toBeTruthy();
    expect(within(priceRow).getByText('₱100.00')).toBeTruthy(); // the total
    expect(screen.getByText('Monthly count')).toBeTruthy();
    expect(screen.getByText(/can change the averages shown for the purchases after/)).toBeTruthy();
  });
});

describe('the price history (INV-10)', () => {
  it('shows each purchase\'s own price and the average after it, newest first', async () => {
    await showDetail('owner');
    const section = screen.getAllByRole('table')[1]!; // the header table, then the price history, then the stock changes
    const rows = within(section).getAllByRole('row').slice(1); // without the header
    expect(rows).toHaveLength(2);
    // Newest first: the back-dated purchase (39 days ago) before the first one (40 days ago).
    expect(within(rows[0]!).getByText(T2)).toBeTruthy();
    expect(within(rows[1]!).getByText(T1)).toBeTruthy();
    // Price per L is 1000 times the e4 figure per mL / 10,000 x 100: 120,000 e4 is P120.00 per L, 100,000 is P100.00 per L.
    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(cells(rows[0]!)).toContain('₱120.00 per L');
    expect(cells(rows[0]!)).toContain('₱106.67 per L'); // average after it: 106,667 e4
    expect(cells(rows[0]!)).toContain('₱60.00'); // total
    expect(cells(rows[1]!)).toContain('₱100.00 per L');
    expect(cells(rows[1]!).filter((c) => c === '₱100.00 per L')).toHaveLength(2); // its price, and the average after it
  });

  it('lists the stock changes newest first, by date', async () => {
    await showDetail('owner');
    const section = screen.getAllByRole('table')[2]!;
    const dates = within(section).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    // The count (36 days ago), then the back-dated purchase (39), then the first purchase (40).
    expect(dates).toEqual([T3, T2, T1]);
    expect(within(section).getAllByRole('row')[1]!.textContent).toContain('Monthly count');
  });
});

describe('the stock changes table', () => {
  it('offers Reverse only on the line the server says can be reversed, and asks for a reason', async () => {
    const { server } = await showDetail('owner', history(), { 'POST /ingredients/1/movements/3/reversal': () => ({ status: 201, body: { movementId: 4 } }) });
    const buttons = screen.getAllByRole('button', { name: 'Reverse' });
    expect(buttons).toHaveLength(1);
    const row = buttons[0]!.closest('tr')!;
    expect(within(row).getByText(T2)).toBeTruthy();

    fireEvent.click(buttons[0]!);
    expect(screen.getByLabelText('Reason')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yes, reverse it' })).toBeTruthy();
    expect(server.count('POST /ingredients/1/movements/3/reversal')).toBe(0);

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Typed the price wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reverse it' }));
    await waitFor(() => expect(server.count('POST /ingredients/1/movements/3/reversal')).toBe(1));
    expect(server.bodies['POST /ingredients/1/movements/3/reversal']).toEqual([{ reason: 'Typed the price wrong' }]);
  });

  it('sends one reversal when the form is submitted twice before the answer comes back', async () => {
    let finish!: () => void;
    const key = 'POST /ingredients/1/movements/3/reversal';
    const { server } = await showDetail('owner', history(), {
      [key]: () => new Promise<any>((resolve) => (finish = () => resolve({ status: 201, body: { movementId: 4 } }))),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Typed the price wrong' } });
    const form = screen.getByRole('button', { name: 'Yes, reverse it' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(server.count(key)).toBe(1);
    finish();
    expect(await screen.findByText(new RegExp(`Reversed the purchase dated ${T2}`))).toBeTruthy();
    expect(server.count(key)).toBe(1);
  });

  it('offers no Reverse when no line can be reversed', async () => {
    await showDetail('owner', history({ reversibleMovementId: null }));
    expect(screen.queryByRole('button', { name: 'Reverse' })).toBeNull();
  });

  it('shows the recount notice on the flagged line only', async () => {
    await showDetail('owner');
    const notices = screen.getAllByText(/no longer matches/);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.closest('tr')!.textContent).toContain(T2);
    expect(notices[0]!.textContent).toContain(`The count dated ${T3} no longer matches`);
  });

  it('marks a reversed line and shows on hand after each line', async () => {
    const reversed = [
      movement({ id: 1, kind: 'purchase', effectiveDate: D1, quantityMilli: 1_000_000, totalCostCents: 10_000, unitPriceE4: 100_000, reversedById: 2 }),
      movement({ id: 2, kind: 'purchase_reversal', effectiveDate: D1, quantityMilli: -1_000_000, reason: 'Wrong entry', reversesMovementId: 1 }),
    ];
    await showDetail('owner', history({ movements: reversed, reversibleMovementId: null, ingredient: { ...soy, onHandMilli: 0, avgCostE4: null } }));
    expect(screen.getAllByText('Reversed').length).toBeGreaterThan(0);
    expect(screen.getByText('Undoes an earlier entry')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'On hand after' })).toBeTruthy();
  });
});

describe('the header', () => {
  it('marks stock below zero and says new runs are blocked until a count', async () => {
    await showDetail('owner', history({ ingredient: { ...soy, onHandMilli: -1_000, avgCostE4: 100_000, lastCountDate: null } }));
    expect(screen.getAllByText('Below zero').length).toBeGreaterThan(0);
    expect(screen.getByText(/New runs that use this ingredient are blocked until a stock count puts it right/)).toBeTruthy();
  });

  it('shows nothing about blocked runs when stock is fine', async () => {
    await showDetail('owner');
    expect(screen.queryByText('Below zero')).toBeNull();
    expect(screen.queryByText(/blocked/)).toBeNull();
  });
});

describe('the correction forms', () => {
  it('shows a matching count’s "Nothing to correct" as a green note, not an error', async () => {
    const key = 'POST /ingredients/1/corrections';
    const { container } = await showDetail('owner', history(), {
      [key]: () => ({ status: 400, body: { error: 'Nothing to correct: the count matches the recorded stock for that date.' } }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stock count' }));
    fireEvent.change(screen.getByPlaceholderText('2.5'), { target: { value: '1400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stock count' }));
    const note = await screen.findByText(/Nothing to correct: the count matches the recorded stock/);
    expect(note.className).toContain('note good');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.note.error')).toBeNull();
  });

  it('shows what a saved count stored, using the answer from the server', async () => {
    const key = 'POST /ingredients/1/corrections';
    const { server } = await showDetail('owner', history(), {
      [key]: () => ({ status: 201, body: { movementId: 9, quantityMilli: -200_000, ingredient: { ...soy, onHandMilli: 1_200_000 } } }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stock count' }));
    fireEvent.change(screen.getByPlaceholderText('2.5'), { target: { value: '1200' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'mL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save stock count' }));
    expect(await screen.findByText(/The difference recorded is -200 mL\. On hand now 1,200 mL\./)).toBeTruthy();
    expect(server.bodies[key]![0]).toMatchObject({ kind: 'count_correction', quantity: '1200', unit: 'mL', reason: 'Stock count' });
  });

  it('tells the owner a count is the stock at the end of the day (D-51)', async () => {
    await showDetail('owner');
    expect(screen.queryByText(/stock at the end of the day/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stock count' }));
    expect(screen.getByText(/A count is the stock at the end of the day\. Count after the day’s runs and other entries are done and entered\./)).toBeTruthy();
  });

  it('hides the Opening balance button when one stands, and shows it when none does', async () => {
    const opening = movement({ id: 1, kind: 'opening', effectiveDate: D1, quantityMilli: 1_000_000, totalCostCents: 10_000, unitPriceE4: 100_000, reason: 'Opening balance' });
    const { unmount } = await showDetail('owner', history({ movements: [opening], reversibleMovementId: 1 }));
    expect(screen.queryByRole('button', { name: 'Opening balance' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Spillage' })).toBeTruthy();
    unmount();

    await showDetail('owner', history({ movements: [], reversibleMovementId: null }));
    expect(screen.getByRole('button', { name: 'Opening balance' })).toBeTruthy();
  });

  it('warns, without blocking, about a spillage dated before the last count (D-44), and saves it when asked', async () => {
    const key = 'POST /ingredients/1/corrections';
    const { server } = await showDetail('owner', history(), {
      [key]: () => ({ status: 201, body: { movementId: 9, quantityMilli: -100_000, ingredient: { ...soy, onHandMilli: 1_300_000 } } }),
    }); // last counted 36 days ago
    fireEvent.click(screen.getByRole('button', { name: 'Spillage' }));
    expect(screen.queryByText(/A spillage entry dated on or before a count/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: D1 } });
    const warning = screen.getByText(/A spillage entry dated on or before a count/);
    expect(warning.textContent).toContain(`This ingredient was last counted on ${T3}.`);
    expect(warning.textContent).toContain(`enter again every count dated on or after ${T1}`);

    fireEvent.change(screen.getByPlaceholderText('2.5'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Dropped a bottle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save spillage' }));
    expect(await screen.findByText(new RegExp(`Saved the spillage of 100 mL, dated ${T1}`))).toBeTruthy();
    expect(server.bodies[key]).toEqual([{ kind: 'spillage', effectiveDate: D1, quantity: '0.1', unit: 'L', reason: 'Dropped a bottle' }]);
  });

  /** Open the spillage form and fill it in, for the guard tests. */
  async function fillSpillage(handler: () => any, date?: string) {
    const key = 'POST /ingredients/1/corrections';
    const view = await showDetail('owner', history(), { [key]: handler });
    fireEvent.click(screen.getByRole('button', { name: 'Spillage' }));
    fireEvent.change(screen.getByPlaceholderText('2.5'), { target: { value: '0.1' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Dropped a bottle' } });
    if (date) fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
    return { ...view, key, form: screen.getByRole('button', { name: 'Save spillage' }).closest('form')! };
  }
  const answer = { status: 201, body: { movementId: 9, quantityMilli: -100_000, ingredient: { ...soy, onHandMilli: 1_300_000 } } };

  it('sends one correction when the form is submitted twice before the answer comes back', async () => {
    let finish!: () => void;
    const { server, key, form } = await fillSpillage(() => new Promise((resolve) => (finish = () => resolve(answer))));
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(server.count(key)).toBe(1);
    finish();
    expect(await screen.findByText(/Saved the spillage of 100 mL/)).toBeTruthy();
    expect(server.count(key)).toBe(1);
  });

  it('asks "Is the year right?" for a correction dated over a year ago, and sends nothing until "Yes, save it"', async () => {
    const longAgo = addDaysISO(todayIn('Asia/Manila'), -400);
    const { server, key, form } = await fillSpillage(() => answer, longAgo);
    fireEvent.submit(form);
    expect(screen.getByText(/Is the year right\?/)).toBeTruthy();
    expect(server.count(key)).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Change the date' }));
    expect(screen.queryByText(/Is the year right\?/)).toBeNull();
    expect(server.count(key)).toBe(0);

    fireEvent.submit(form);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, save it' }));
    await waitFor(() => expect(server.count(key)).toBe(1));
    expect((server.bodies[key]![0] as any).effectiveDate).toBe(longAgo);
  });

  it('shows a spillage dated after the last count no warning', async () => {
    await showDetail('owner');
    fireEvent.click(screen.getByRole('button', { name: 'Spillage' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: day(-35) } });
    expect(screen.queryByText(/dated on or before a count/)).toBeNull();
  });
});

describe('correcting a purchase’s details (INV-17)', () => {
  const key = 'PATCH /ingredients/1/movements/1/details';
  const stockTable = () => within(screen.getAllByRole('table')[2]!);
  const rowOf = (text: string) => stockTable().getAllByRole('row').find((r) => r.textContent?.includes(text))!;
  const openFirst = () => fireEvent.click(within(rowOf(T1)).getByRole('button', { name: 'Correct details' }));
  const saved = { status: 200, body: movement({ id: 1, kind: 'purchase', effectiveDate: D1, quantityMilli: 1_000_000 }) };

  it('is offered on each purchase that is not reversed, and nowhere else', async () => {
    await showDetail('owner');
    expect(screen.getAllByRole('button', { name: 'Correct details' })).toHaveLength(2); // the two purchases, not the count
    expect(within(rowOf('Monthly count')).queryByRole('button', { name: 'Correct details' })).toBeNull();
  });

  it('is not offered on a reversed purchase, on its reversal, or on an opening balance', async () => {
    const reversed = [
      movement({ id: 1, kind: 'purchase', effectiveDate: D1, quantityMilli: 1_000_000, totalCostCents: 10_000, unitPriceE4: 100_000, reversedById: 2 }),
      movement({ id: 2, kind: 'purchase_reversal', effectiveDate: D1, quantityMilli: -1_000_000, reason: 'Wrong entry', reversesMovementId: 1 }),
      movement({ id: 3, kind: 'opening', effectiveDate: D2, quantityMilli: 1_000, totalCostCents: 100, unitPriceE4: 1, reason: 'Opening balance' }),
    ];
    await showDetail('owner', history({ movements: reversed, reversibleMovementId: null }));
    expect(screen.queryByRole('button', { name: 'Correct details' })).toBeNull();
  });

  it('is never offered to staff, nor to an account that cannot write right now', async () => {
    const staffView = await showDetail('staff');
    expect(screen.queryByRole('button', { name: 'Correct details' })).toBeNull();
    staffView.unmount();
    await showDetail('owner', history(), { 'GET /auth/me': () => ({ body: meFor('owner', 'read_only') }) });
    expect(screen.getByRole('heading', { name: 'Stock changes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correct details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reverse' })).toBeNull();
  });

  it('opens a form filled in with the current values, and says quantity and price cannot be changed', async () => {
    await showDetail('owner');
    openFirst();
    expect((screen.getByLabelText('Supplier') as HTMLInputElement).value).toBe('Mang Tony');
    expect((screen.getByLabelText('Reference') as HTMLInputElement).value).toBe('OR-7');
    expect((screen.getByLabelText(/Expiry date/) as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Quantity and price can’t be changed here\./)).toBeTruthy();
    expect(screen.queryByLabelText(/Quantity/)).toBeNull();
  });

  it('on a line that cannot be reversed, says only the last entry can be, and points to a stock count', async () => {
    await showDetail('owner'); // the line dated 40 days ago is not the reversible one
    openFirst();
    const hint = screen.getByText(/Quantity and price can’t be changed here\./);
    expect(hint.textContent).toBe('Quantity and price can’t be changed here. Only the last entry made can be reversed, and this is not it. If the quantity is wrong, a stock count puts it right.');
  });

  it('on the line that can be reversed, says it can be reversed and entered again', async () => {
    await showDetail('owner');
    fireEvent.click(within(rowOf(T2)).getByRole('button', { name: 'Correct details' })); // reversibleMovementId is this line
    const hint = screen.getByText(/Quantity and price can’t be changed here\./);
    expect(hint.textContent).toBe('Quantity and price can’t be changed here. This is the last entry made for this ingredient, so if they are wrong you can reverse it and enter it again.');
    expect(hint.textContent).not.toContain('stock count');
  });

  it('sends one PATCH with the right body when the form is submitted twice, then says what was saved', async () => {
    let finish!: () => void;
    const { server } = await showDetail('owner', history(), { [key]: () => new Promise<any>((resolve) => (finish = () => resolve(saved))) });
    openFirst();
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: '  Aling Rosa ' } });
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Expiry date/), { target: { value: day(20) } });
    const form = screen.getByRole('button', { name: 'Save the details' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(server.count(key)).toBe(1);
    finish();
    expect(await screen.findByText(new RegExp(`Saved the corrected details of the purchase dated ${T1}`))).toBeTruthy();
    expect(server.count(key)).toBe(1);
    expect(server.bodies[key]).toEqual([{ supplier: 'Aling Rosa', reference: '', expiryDate: day(20) }]);
  });

  it('sends a cleared expiry date as null', async () => {
    const withExpiry = history({ movements: [{ ...lines[0]!, expiryDate: day(30) }, ...lines.slice(1)] });
    const { server } = await showDetail('owner', withExpiry, { [key]: () => saved });
    openFirst();
    expect((screen.getByLabelText(/Expiry date/) as HTMLInputElement).value).toBe(day(30));
    fireEvent.change(screen.getByLabelText(/Expiry date/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the details' }));
    await waitFor(() => expect(server.count(key)).toBe(1));
    expect(server.bodies[key]).toEqual([{ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: null }]);
  });

  it('warns when the expiry is before the purchase date (D-40) and still saves', async () => {
    const { server } = await showDetail('owner', history(), { [key]: () => saved });
    openFirst();
    expect(screen.queryByText(/The expiry date is before the purchase date/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Expiry date/), { target: { value: day(-45) } });
    expect(screen.getByText(/The expiry date is before the purchase date\. Check both dates\. You can still save it if they are right\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save the details' }));
    await waitFor(() => expect(server.count(key)).toBe(1));
    expect(server.bodies[key]).toEqual([{ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: day(-45) }]);
  });

  it('shows "Nothing to change" as a neutral note, not an error', async () => {
    const { container } = await showDetail('owner', history(), {
      [key]: () => ({ status: 400, body: { error: 'Nothing to change: these details are the same as the ones already saved.' } }),
    });
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Save the details' }));
    const note = await screen.findByText(/Nothing to change: these details are the same as the ones already saved\. Nothing was saved\./);
    expect(note.className).toContain('note neutral');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.note.error')).toBeNull();
    expect(screen.queryByLabelText('Supplier')).toBeNull(); // the form has closed
  });

  it('shows another refusal as an error and keeps the form open', async () => {
    await showDetail('owner', history(), {
      [key]: () => ({ status: 409, body: { error: 'This purchase has been reversed, so its details can no longer be corrected.' } }),
    });
    openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Save the details' }));
    expect(await screen.findByText(/This purchase has been reversed/)).toBeTruthy();
    expect(screen.getByLabelText('Supplier')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save the details' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the earlier values, who corrected them and when, after a correction', async () => {
    let corrected = false;
    const changed = movement({
      ...lines[0]!, supplier: 'Aling Rosa',
      detailChanges: [{ supplier: 'Mang Tony', reference: 'OR-7', expiryDate: null, changedByName: 'Olga Owner', changedAt: '2026-11-10 09:30:00+08' }],
    });
    const { server } = await showDetail('owner', history(), {
      'GET /ingredients/1/movements': () => ({ body: history({ movements: corrected ? [changed, ...lines.slice(1)] : lines }) }),
      [key]: () => { corrected = true; return saved; },
    });
    expect(screen.queryByText(/Details corrected/)).toBeNull();
    openFirst();
    fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Aling Rosa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the details' }));
    expect(await screen.findByText(/Details corrected once\. Earlier values:/)).toBeTruthy();
    const item = screen.getByText(/Corrected by Olga Owner/);
    expect(item.textContent).toContain('Mang Tony, reference OR-7, no expiry date.');
    expect(item.textContent).toContain(dateText('2026-11-10'));
    expect(server.count(key)).toBe(1);
    // The price history shows the current supplier.
    expect(within(screen.getAllByRole('table')[1]!).getByText('Aling Rosa')).toBeTruthy();
  });

  it('keeps one form open at a time: correcting closes a count form, reversing and each other, and the reverse', async () => {
    await showDetail('owner');
    fireEvent.click(screen.getByRole('button', { name: 'Stock count' }));
    expect(screen.getByRole('button', { name: 'Save stock count' })).toBeTruthy();
    openFirst(); // the count form closes
    expect(screen.queryByRole('button', { name: 'Save stock count' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save the details' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reverse' })); // the details form closes
    expect(screen.queryByRole('button', { name: 'Save the details' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Yes, reverse it' })).toBeTruthy();

    openFirst(); // the reverse form closes
    expect(screen.queryByRole('button', { name: 'Yes, reverse it' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save the details' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Spillage' })); // the details form closes
    expect(screen.queryByRole('button', { name: 'Save the details' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save spillage' })).toBeTruthy();
  });

  it('says how many times when corrected more than once', async () => {
    const change = { supplier: 'A', reference: '', expiryDate: null, changedByName: 'Olga Owner', changedAt: '2026-11-10 09:30:00+08' };
    await showDetail('owner', history({ movements: [{ ...lines[0]!, detailChanges: [change, { ...change, supplier: 'B' }] }, ...lines.slice(1)] }));
    expect(screen.getByText(/Details corrected 2 times\./)).toBeTruthy();
    expect(screen.getByText(/^A, no reference, no expiry date\./)).toBeTruthy();
  });
});
