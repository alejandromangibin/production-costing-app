import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addDaysISO, dateText, todayIn } from '../format';
import { flour, renderPage, soy } from '../test/helpers';
import { Ingredients } from './Ingredients';

// The ingredient list and the purchase form, as the owner and as staff see them (INV-01, INV-02, INV-14).

const lastCount = addDaysISO(todayIn('Asia/Manila'), -10);
const ownerList = [{ ...soy, avgCostE4: 110_040, lastCountDate: lastCount }, { ...flour, avgCostE4: 1_000_000, lastCountDate: null }];
const staffList = [soy, flour]; // the server sends staff no costs at all

const showList = (role: 'owner' | 'staff', extra = {}) =>
  renderPage(role, '/ingredients', '/ingredients', <Ingredients />, { 'GET /ingredients': () => ({ body: role === 'owner' ? ownerList : staffList }), ...extra });

describe('what staff and the owner see on the ingredient list', () => {
  it('shows staff no costs, no last count and none of the owner buttons', async () => {
    const { container } = await showList('staff');
    expect(screen.getByText('Soy sauce')).toBeTruthy();
    expect(screen.queryByText('Average cost')).toBeNull();
    expect(screen.queryByText('Last count')).toBeNull();
    expect(screen.queryByRole('button', { name: /New ingredient/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('link', { name: /History and corrections/ })).toBeNull();
    expect(container.textContent).not.toContain('₱');
    // They can still record a purchase.
    expect(screen.getAllByRole('button', { name: 'Record purchase' })).toHaveLength(2);
  });

  it('shows the owner the average, the last count and the owner buttons', async () => {
    await showList('owner');
    expect(screen.getByText('Average cost')).toBeTruthy();
    expect(screen.getByText('Last count')).toBeTruthy();
    expect(screen.getByText('₱110.04 per L')).toBeTruthy();
    expect(screen.getByText(dateText(lastCount))).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ New ingredient' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    const links = screen.getAllByRole('link', { name: 'History and corrections' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/ingredients/1', '/ingredients/2']);
  });
});

describe('the purchase form', () => {
  const purchaseKey = 'POST /ingredients/2/purchases';
  const saved = { body: { movementId: 9, ingredient: { ...flour, onHandMilli: 5_500_000 } } };

  /** Open the form for Flour (grams) and fill it in. */
  async function fill(handler = () => saved as any, fields: { quantity?: string; total?: string; date?: string } = {}) {
    const view = await showList('owner', { [purchaseKey]: handler });
    // Flour is the second row.
    fireEvent.click(screen.getAllByRole('button', { name: 'Record purchase' })[1]!);
    fireEvent.change(screen.getByPlaceholderText('2.5'), { target: { value: fields.quantity ?? '0.5' } });
    fireEvent.change(screen.getByLabelText(/Total paid/), { target: { value: fields.total ?? '1250.00' } });
    if (fields.date) fireEvent.change(screen.getByLabelText('Purchase date'), { target: { value: fields.date } });
    return view;
  }
  const save = () => screen.getByRole('button', { name: 'Save purchase' });

  it('sends one request however often Save is clicked while it is saving', async () => {
    let finish!: () => void;
    const slow = () => new Promise<any>((resolve) => (finish = () => resolve(saved)));
    const { server } = await fill(slow);
    fireEvent.click(save());
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
    expect(server.count(purchaseKey)).toBe(1);
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    expect(await screen.findByText(/Saved: 0.5 kg of Flour for ₱1,250.00/)).toBeTruthy();
    expect(server.count(purchaseKey)).toBe(1);
  });

  // A disabled button never submits, so the button test above cannot show the guard in the code. Submitting the form
  // itself twice, before the first answer, does.
  it('sends one request when the form itself is submitted twice before the answer comes back', async () => {
    let finish!: () => void;
    const slow = () => new Promise<any>((resolve) => (finish = () => resolve(saved)));
    const { server } = await fill(slow);
    const form = save().closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(server.count(purchaseKey)).toBe(1);
    finish();
    expect(await screen.findByText(/Saved: 0.5 kg of Flour/)).toBeTruthy();
    expect(server.count(purchaseKey)).toBe(1);
  });

  it('asks "Is the year right?" for a date over a year ago, and sends nothing until "Yes, save it"', async () => {
    const longAgo = addDaysISO(todayIn('Asia/Manila'), -400);
    const { server } = await fill(undefined, { date: longAgo });
    fireEvent.click(save());
    expect(screen.getByText(/Is the year right\?/)).toBeTruthy();
    expect(server.count(purchaseKey)).toBe(0);

    // Changing the date sends nothing and brings the normal Save back.
    fireEvent.click(screen.getByRole('button', { name: 'Change the date' }));
    expect(screen.queryByText(/Is the year right\?/)).toBeNull();
    expect(server.count(purchaseKey)).toBe(0);

    fireEvent.click(save());
    fireEvent.click(screen.getByRole('button', { name: 'Yes, save it' }));
    await waitFor(() => expect(server.count(purchaseKey)).toBe(1));
    expect((server.bodies[purchaseKey]![0] as any).effectiveDate).toBe(longAgo);
  });

  it('shows what a quantity in kg comes to in grams', async () => {
    await fill(undefined, { quantity: '500' });
    expect(screen.getByText('= 500,000 g')).toBeTruthy();
  });

  it('refuses a comma in the total with a plain message and sends nothing', async () => {
    const { server } = await fill(undefined, { total: '12,50' });
    fireEvent.click(save());
    expect(screen.getByRole('alert').textContent).toContain('Use a dot, not a comma, for centavos');
    expect(server.count(purchaseKey)).toBe(0);
  });
});
