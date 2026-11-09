import { useRef, useState } from 'react';
import { ApiError, api, useLoad, type Ingredient, type PurchaseResult } from '../api';
import { useAuth } from '../auth';
import { Badge, Empty, ErrorNote, Loading } from '../components';
import { dateText, parseCents, peso, todayIn, todayISO } from '../format';
import {
  BASE_UNIT_NAMES,
  ENTRY_UNITS,
  averageText,
  checkQuantity,
  convertedText,
  overAYearAgo,
  purchaseWarnings,
  quantityText,
  type BaseUnit,
  type EntryUnit,
} from '../stockForm';

type Open = { kind: 'buy' | 'edit'; id: number } | { kind: 'new' } | null;

/**
 * The ingredient list (INV-01) and the purchase form (INV-02). Everyone sees names, units and quantities and
 * can record a purchase; only the owner sees the average cost and can add, rename, archive or change the unit
 * (INV-14). The server sends staff no cost at all, so nothing here hides one.
 */
export function Ingredients() {
  const { me, canWrite } = useAuth();
  const isOwner = me?.user.role === 'owner';
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, reload } = useLoad(
    () => api.get<Ingredient[]>(`/ingredients${showArchived ? '?includeInactive=1' : ''}`),
    [showArchived],
  );
  const [open, setOpen] = useState<Open>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const show = (next: Open) => {
    setSaved(null);
    setOpen(next);
  };
  const done = (message: string) => {
    setOpen(null);
    setSaved(message);
    reload();
  };
  const current = open && open.kind !== 'new' ? data?.find((i) => i.id === open.id) : undefined;

  return (
    <>
      <div className="page-head">
        <h1>Ingredients</h1>
        <div>
          <label className="check inline">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>{' '}
          {isOwner && (
            <button className="primary" onClick={() => show({ kind: 'new' })} disabled={open?.kind === 'new' || !canWrite}>
              + New ingredient
            </button>
          )}
        </div>
      </div>
      <p className="hint">
        {isOwner
          ? 'Record each purchase here. On hand and the average cost are worked out from them. Only you can see the average cost.'
          : 'Record each purchase here, with the quantity and the total paid.'}
      </p>

      {saved && <div className="note good">{saved}</div>}
      {open?.kind === 'new' && <NewIngredientForm onDone={done} onCancel={() => show(null)} />}
      {open?.kind === 'buy' && current && (
        <PurchaseForm key={current.id} ingredient={current} isOwner={isOwner} onDone={done} onCancel={() => show(null)} />
      )}
      {open?.kind === 'edit' && current && <EditIngredientForm key={current.id} ingredient={current} onDone={done} onCancel={() => show(null)} />}

      <ErrorNote message={error} />
      {loading && !data && <Loading />}
      {data && data.length === 0 && open?.kind !== 'new' && (
        <Empty>{isOwner ? 'No ingredients yet. Click “New ingredient” to add your first one.' : 'No ingredients yet. The owner adds them.'}</Empty>
      )}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ingredient</th>
                <th className="num">On hand</th>
                {isOwner && <th className="num">Average cost</th>}
                {isOwner && <th>Last count</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id} className={!i.active ? 'archived' : i.onHandMilli < 0 ? 'row-bad' : ''}>
                  <td>
                    {i.name} {!i.active && <Badge tone="muted">Archived</Badge>}
                  </td>
                  <td className="num">
                    {quantityText(i.onHandMilli, i.baseUnit)} {i.onHandMilli < 0 && <Badge tone="bad">Below zero</Badge>}
                  </td>
                  {isOwner && <td className="num">{averageText(i.avgCostE4, i.baseUnit)}</td>}
                  {isOwner && <td>{dateText(i.lastCountDate)}</td>}
                  <td className="actions">
                    {i.active && canWrite && (
                      <button className="link" onClick={() => show({ kind: 'buy', id: i.id })}>
                        Record purchase
                      </button>
                    )}{' '}
                    {isOwner && canWrite && (
                      <button className="link" onClick={() => show({ kind: 'edit', id: i.id })}>
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.some((i) => i.onHandMilli < 0) && (
        <p className="hint">
          Below zero means more was taken out than was recorded as bought. {isOwner ? 'You can' : 'The owner can'} put it right with a stock
          count.
        </p>
      )}
    </>
  );
}

function NewIngredientForm({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [baseUnit, setBaseUnit] = useState<BaseUnit>('g');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const made = await api.post<Ingredient>('/ingredients', { name, baseUnit });
      onDone(`Added ${made.name}, measured in ${made.baseUnit}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>New ingredient</h2>
      <div className="form-grid">
        <label className="wide">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ground pork" maxLength={80} required autoFocus />
        </label>
        <label>
          Measured in
          <select value={baseUnit} onChange={(e) => setBaseUnit(e.target.value as BaseUnit)}>
            {(Object.keys(BASE_UNIT_NAMES) as BaseUnit[]).map((u) => (
              <option key={u} value={u}>
                {BASE_UNIT_NAMES[u]}
              </option>
            ))}
          </select>
          <small>Purchases can still be typed in kg or L. The unit cannot change once stock is recorded.</small>
        </label>
      </div>
      <ErrorNote message={error} />
      <button className="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save ingredient'}
      </button>{' '}
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </form>
  );
}

function EditIngredientForm({ ingredient, onDone, onCancel }: { ingredient: Ingredient; onDone: (message: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(ingredient.name);
  const [baseUnit, setBaseUnit] = useState<BaseUnit>(ingredient.baseUnit);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(body: Record<string, unknown>, message: string) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api.patch<Ingredient>(`/ingredients/${ingredient.id}`, body);
      onDone(message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      setBusy(false);
    }
  }

  const dirty = name !== ingredient.name || baseUnit !== ingredient.baseUnit;

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        save({ name, baseUnit }, `Saved the changes to ${name.trim()}.`);
      }}
    >
      <h2>Edit {ingredient.name}</h2>
      <div className="form-grid">
        <label className="wide">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </label>
        <label>
          Measured in
          <select value={baseUnit} onChange={(e) => setBaseUnit(e.target.value as BaseUnit)}>
            {(Object.keys(BASE_UNIT_NAMES) as BaseUnit[]).map((u) => (
              <option key={u} value={u}>
                {BASE_UNIT_NAMES[u]}
              </option>
            ))}
          </select>
          <small>Only until the first stock entry for this ingredient.</small>
        </label>
      </div>
      <ErrorNote message={error} />
      <button className="primary" disabled={busy || !dirty}>
        {busy ? 'Saving…' : 'Save changes'}
      </button>{' '}
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>{' '}
      <button
        type="button"
        className="link"
        disabled={busy || dirty}
        onClick={() =>
          save(
            { active: !ingredient.active },
            ingredient.active ? `Archived ${ingredient.name}. Its stock and history are kept.` : `${ingredient.name} is turned back on.`,
          )
        }
      >
        {ingredient.active ? 'Archive' : 'Turn back on'}
      </button>
      {dirty && <small className="muted"> Save or undo the changes first.</small>}
    </form>
  );
}

function PurchaseForm({
  ingredient,
  isOwner,
  onDone,
  onCancel,
}: {
  ingredient: Ingredient;
  isOwner: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const units = ENTRY_UNITS[ingredient.baseUnit];
  // Today where the business is, as the server counts it, not by the device's clock.
  const { me } = useAuth();
  const today = me?.timeZone ? todayIn(me.timeZone) : todayISO();
  const [date, setDate] = useState(today);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<EntryUnit>(units[0]!);
  const [total, setTotal] = useState('');
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [askOld, setAskOld] = useState(false);
  const [busy, setBusy] = useState(false);
  // A second click can arrive before the button shows as disabled; this stops it sending a second purchase.
  const sending = useRef(false);

  const warnings = purchaseWarnings({ date, expiryDate, lastCountDate: ingredient.lastCountDate, isOwner });
  const converted = convertedText(quantity, unit);

  const fail = (message: string) => {
    setError(message);
    return null;
  };

  function check(): { quantity: string; totalCostCents: number } | null {
    setError(null);
    if (!date) return fail('Choose the purchase date.');
    if (date > today) return fail('The purchase date cannot be in the future.');
    const q = checkQuantity(quantity, unit);
    if (q.error !== undefined) return fail(q.error);
    const cents = parseCents(total);
    if (cents === null && total.includes(',')) return fail('Use a dot, not a comma, for centavos: for example 1250.50 or 1,250.50.');
    if (cents === null) return fail('Type the total paid in pesos, for example 1250 or 1,250.50.');
    return { quantity: q.quantity, totalCostCents: cents };
  }

  async function send(checked: { quantity: string; totalCostCents: number }) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const r = await api.post<PurchaseResult>(`/ingredients/${ingredient.id}/purchases`, {
        effectiveDate: date,
        quantity: checked.quantity,
        unit,
        totalCostCents: checked.totalCostCents,
        supplier,
        reference,
        expiryDate: expiryDate || null,
      });
      onDone(
        `Saved: ${checked.quantity} ${unit} of ${ingredient.name} for ${peso(checked.totalCostCents)}, dated ${dateText(date)}. ` +
          `On hand now ${quantityText(r.ingredient.onHandMilli, r.ingredient.baseUnit)}.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      setAskOld(false);
      sending.current = false;
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    const checked = check();
    if (!checked) return;
    // D-41: a year typed wrong is hard to undo later, so ask once.
    if (overAYearAgo(date, today) && !askOld) return setAskOld(true);
    void send(checked);
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Record a purchase: {ingredient.name}</h2>
      <div className="form-grid">
        <label>
          Purchase date
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => {
              setDate(e.target.value);
              setAskOld(false);
            }}
            required
          />
        </label>
        <label>
          Quantity
          <span className="linkbox">
            <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="2.5" required autoFocus />
            <select value={unit} onChange={(e) => setUnit(e.target.value as EntryUnit)} aria-label="Unit" disabled={units.length === 1}>
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </span>
          {converted && <small aria-live="polite">{converted}</small>}
        </label>
        <label>
          Total paid (₱)
          <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="1250.00" required />
          <small>For the whole quantity, not per kg.</small>
        </label>
        <label>
          Supplier (optional)
          <input value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} />
        </label>
        <label>
          Receipt or reference no. (optional)
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        </label>
        <label>
          Expiry date (optional)
          <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
        </label>
      </div>
      <div role="status" aria-live="polite">
        {warnings.map((w) => (
          <div key={w} className="note warn">
            {w}
          </div>
        ))}
      </div>
      <ErrorNote message={error} />
      {askOld ? (
        <div className="note confirm">
          <p>
            This purchase is dated <strong>{dateText(date)}</strong>, more than a year ago. Is the year right? An old date is hard to put
            right later.
          </p>
          <button type="submit" className="primary" disabled={busy} autoFocus>
            {busy ? 'Saving…' : 'Yes, save it'}
          </button>{' '}
          <button type="button" onClick={() => setAskOld(false)} disabled={busy}>
            Change the date
          </button>
        </div>
      ) : (
        <>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save purchase'}
          </button>{' '}
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
      )}
    </form>
  );
}
