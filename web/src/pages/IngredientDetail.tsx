import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, useLoad, type Movement, type MovementHistory } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorNote, Loading } from '../components';
import { dateText, parseCents, peso, todayIn, todayISO } from '../format';
import {
  COUNT_END_OF_DAY_NOTE,
  ENTRY_UNITS,
  averageText,
  changeText,
  checkQuantity,
  convertedText,
  correctionSavedText,
  correctionWarnings,
  isNothingToCorrect,
  movementLabel,
  overAYearAgo,
  quantityText,
  recountNotice,
  type BaseUnit,
  type CorrectionKind,
  type EntryUnit,
} from '../stockForm';

/**
 * One ingredient for the owner: its price history (INV-10), every stock change, and the corrections (INV-08).
 * Staff never see prices (INV-14), so they get a plain message here; the server refuses them as well.
 */
export function IngredientDetail() {
  const { me } = useAuth();
  const { id } = useParams();
  if (me?.user.role !== 'owner') {
    return (
      <>
        <h1>Ingredient</h1>
        <div className="note warn">Only the owner can see an ingredient’s price history and make corrections.</div>
        <p>
          <Link to="/ingredients">Back to the ingredients</Link>
        </p>
      </>
    );
  }
  if (!id || !/^\d+$/.test(id)) {
    return (
      <>
        <h1>Ingredient</h1>
        <div className="note error">That ingredient was not found.</div>
        <p>
          <Link to="/ingredients">Back to the ingredients</Link>
        </p>
      </>
    );
  }
  return <OwnerView ingredientId={Number(id)} />;
}

const FORM_NAMES: Record<CorrectionKind, string> = {
  count_correction: 'Stock count',
  spillage: 'Spillage',
  spoilage: 'Spoilage',
  opening: 'Opening balance',
};

function OwnerView({ ingredientId }: { ingredientId: number }) {
  const { me, canWrite } = useAuth();
  const today = me?.timeZone ? todayIn(me.timeZone) : todayISO();
  const { data, error, loading, reload } = useLoad(() => api.get<MovementHistory>(`/ingredients/${ingredientId}/movements`), [ingredientId]);
  const [form, setForm] = useState<CorrectionKind | null>(null);
  const [reversing, setReversing] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ tone: 'good' | 'warn'; text: string } | null>(null);

  const done = (text: string, tone: 'good' | 'warn' = 'good') => {
    setForm(null);
    setReversing(null);
    setSaved({ tone, text });
    reload();
  };

  if (error && !data) {
    return (
      <>
        <h1>Ingredient</h1>
        <ErrorNote message={error} />
        <p>
          <Link to="/ingredients">Back to the ingredients</Link>
        </p>
      </>
    );
  }
  if (!data) return <Loading />;

  const { ingredient, movements, reversibleMovementId } = data;
  const unit = ingredient.baseUnit;
  const newestFirst = [...movements].reverse();
  const priceLines = newestFirst.filter((m) => m.kind === 'purchase' || m.kind === 'opening');
  const hasOpening = movements.some((m) => m.kind === 'opening' && m.reversedById === null);
  const below = ingredient.onHandMilli < 0;
  const kinds: CorrectionKind[] = hasOpening ? ['count_correction', 'spillage', 'spoilage'] : ['count_correction', 'spillage', 'spoilage', 'opening'];

  return (
    <>
      <div className="page-head">
        <h1>
          {ingredient.name} {!ingredient.active && <Badge tone="muted">Archived</Badge>}
        </h1>
        <Link to="/ingredients">Back to the ingredients</Link>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Measured in</th>
              <th className="num">On hand</th>
              <th className="num">Average cost</th>
              <th>Last count</th>
            </tr>
          </thead>
          <tbody>
            <tr className={below ? 'row-bad' : ''}>
              <td>{unit}</td>
              <td className="num">
                {quantityText(ingredient.onHandMilli, unit)} {below && <Badge tone="bad">Below zero</Badge>}
              </td>
              <td className="num">{averageText(ingredient.avgCostE4, unit)}</td>
              <td>{dateText(ingredient.lastCountDate)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {below && (
        <div className="note error">
          More was taken out than was recorded as bought. New runs that use this ingredient are blocked until a stock count puts it right.
        </div>
      )}

      {saved && (
        <div className={`note ${saved.tone}`} role="status">
          {saved.text}
        </div>
      )}
      <ErrorNote message={error} />

      <h2>Corrections</h2>
      {!canWrite ? (
        <p className="hint">Changes are switched off for this account right now, so corrections cannot be saved.</p>
      ) : (
        <>
          <div>
            {kinds.map((k) => (
              <button key={k} className={form === k ? 'primary' : ''} onClick={() => { setSaved(null); setForm(form === k ? null : k); }}>
                {FORM_NAMES[k]}
              </button>
            ))}
          </div>
          {form && (
            <CorrectionForm
              key={form}
              kind={form}
              ingredientId={ingredient.id}
              baseUnit={unit}
              lastCountDate={ingredient.lastCountDate}
              today={today}
              onDone={done}
              onCancel={() => setForm(null)}
            />
          )}
        </>
      )}

      <h2>Price history</h2>
      <p className="hint">
        Purchases and opening balances, newest first. The average after each one is worked out in date order, so anything entered later with an
        earlier date (a purchase, an opening balance, a spillage, a spoilage or a count) can change the averages shown for the purchases after
        it. Runs already saved never change.
      </p>
      {priceLines.length === 0 ? (
        <p className="muted">No purchases or opening balance yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Supplier</th>
                <th>Reference</th>
                <th className="num">Quantity</th>
                <th className="num">Total</th>
                <th className="num">Price</th>
                <th className="num">Average after it</th>
              </tr>
            </thead>
            <tbody>
              {priceLines.map((m) => (
                <tr key={m.id} className={m.reversedById !== null ? 'archived' : ''}>
                  <td>
                    {dateText(m.effectiveDate)} {m.kind === 'opening' && <Badge tone="muted">Opening balance</Badge>}{' '}
                    {m.reversedById !== null && <Badge tone="muted">Reversed</Badge>}
                  </td>
                  <td>{m.supplier || '–'}</td>
                  <td>{m.reference || '–'}</td>
                  <td className="num">{quantityText(m.quantityMilli, unit)}</td>
                  <td className="num">{peso(m.totalCostCents)}</td>
                  <td className="num">{averageText(m.unitPriceE4, unit)}</td>
                  <td className="num">{averageText(m.averageAfterE4, unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Stock changes</h2>
      {newestFirst.length === 0 ? (
        <p className="muted">Nothing recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th className="num">Change</th>
                <th className="num">On hand after</th>
                <th>Reason</th>
                <th>Entered by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((m) => (
                <MovementRow
                  key={m.id}
                  m={m}
                  baseUnit={unit}
                  canReverse={canWrite && m.id === reversibleMovementId}
                  isReversing={reversing === m.id}
                  onReverse={() => { setSaved(null); setReversing(m.id); }}
                  onCancel={() => setReversing(null)}
                  ingredientId={ingredient.id}
                  onDone={done}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MovementRow(props: {
  m: Movement;
  baseUnit: BaseUnit;
  canReverse: boolean;
  isReversing: boolean;
  ingredientId: number;
  onReverse: () => void;
  onCancel: () => void;
  onDone: (text: string) => void;
}) {
  const { m, baseUnit } = props;
  return (
    <>
      <tr className={m.reversedById !== null ? 'archived' : ''}>
        <td>{dateText(m.effectiveDate)}</td>
        <td>
          {movementLabel(m.kind)}
          {m.reversedById !== null && <> <Badge tone="muted">Reversed</Badge></>}
          {m.reversesMovementId !== null && <> <Badge tone="muted">Undoes an earlier entry</Badge></>}
        </td>
        <td className="num">{changeText(m.quantityMilli, baseUnit)}</td>
        <td className="num">{m.onHandAfterMilli === null ? '–' : quantityText(m.onHandAfterMilli, baseUnit)}</td>
        <td>
          {m.reason || (m.runId !== null ? <Link to={`/runs/${m.runId}`}>Run</Link> : '–')}
          {m.needsRecount && <div className="note warn">{recountNotice(m.effectiveDate, m.needsRecount, m.kind === 'count_correction')}</div>}
        </td>
        <td>
          {m.enteredByName}
          <br />
          <small className="muted">{dateText(m.enteredAt)}</small>
        </td>
        <td className="actions">
          {props.canReverse && !props.isReversing && (
            <button className="link" onClick={props.onReverse}>
              Reverse
            </button>
          )}
        </td>
      </tr>
      {props.isReversing && (
        <tr>
          <td colSpan={7}>
            <ReverseForm m={m} baseUnit={baseUnit} ingredientId={props.ingredientId} onDone={props.onDone} onCancel={props.onCancel} />
          </td>
        </tr>
      )}
    </>
  );
}

function ReverseForm({
  m,
  baseUnit,
  ingredientId,
  onDone,
  onCancel,
}: {
  m: Movement;
  baseUnit: BaseUnit;
  ingredientId: number;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sending.current) return;
    if (!reason.trim()) return setError('Type the reason.');
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/ingredients/${ingredientId}/movements/${m.id}/reversal`, { reason: reason.trim() });
      onDone(`Reversed the ${movementLabel(m.kind).toLowerCase()} dated ${dateText(m.effectiveDate)}. It is kept in the history, marked as reversed.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="note confirm" onSubmit={submit}>
      <p>
        Reverse the {movementLabel(m.kind).toLowerCase()} of <strong>{quantityText(m.quantityMilli, baseUnit)}</strong> dated{' '}
        <strong>{dateText(m.effectiveDate)}</strong>? Stock and the average go back as if it had never been entered. The line stays in the history.
      </p>
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required autoFocus />
      </label>
      <ErrorNote message={error} />
      <button className="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Yes, reverse it'}
      </button>{' '}
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </form>
  );
}

/** Count, spillage, spoilage or opening balance. The server checks everything again. */
function CorrectionForm({
  kind,
  ingredientId,
  baseUnit,
  lastCountDate,
  today,
  onDone,
  onCancel,
}: {
  kind: CorrectionKind;
  ingredientId: number;
  baseUnit: BaseUnit;
  lastCountDate: string | null;
  today: string;
  onDone: (text: string, tone?: 'good' | 'warn') => void;
  onCancel: () => void;
}) {
  const units = ENTRY_UNITS[baseUnit];
  const isCount = kind === 'count_correction';
  const isOpening = kind === 'opening';
  const [date, setDate] = useState(today);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<EntryUnit>(units[0]!);
  const [total, setTotal] = useState('');
  const [reason, setReason] = useState(isOpening ? 'Opening balance' : '');
  const [error, setError] = useState<string | null>(null);
  const [askOld, setAskOld] = useState(false);
  const [busy, setBusy] = useState(false);
  // A second click can arrive before the button shows as disabled; this stops it saving twice.
  const sending = useRef(false);

  const warnings = correctionWarnings({ kind, date, lastCountDate });
  const converted = convertedText(quantity, unit);

  const fail = (message: string) => {
    setError(message);
    return null;
  };

  function check(): { quantity: string; totalCostCents: number | null; reason: string } | null {
    setError(null);
    if (!date) return fail('Choose the date.');
    if (date > today) return fail('The date cannot be in the future.');
    const q = checkQuantity(quantity, unit);
    if (q.error !== undefined) return fail(q.error);
    let cents: number | null = null;
    if (isOpening) {
      cents = parseCents(total);
      if (cents === null && total.includes(',')) return fail('Use a dot, not a comma, for centavos: for example 1250.50 or 1,250.50.');
      if (cents === null) return fail('Type the total cost in pesos, for example 1250 or 1,250.50.');
    }
    // A count does not ask for a reason; a note is optional and a standard one is kept.
    const why = reason.trim() || (isCount ? 'Stock count' : '');
    if (!why) return fail('Type the reason.');
    return { quantity: q.quantity, totalCostCents: cents, reason: why };
  }

  async function send(checked: { quantity: string; totalCostCents: number | null; reason: string }) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const base = { effectiveDate: date, quantity: checked.quantity, unit, reason: checked.reason };
      const r = isOpening
        ? await api.post<{ movementId: number; quantityMilli: number; ingredient: { onHandMilli: number } }>(`/ingredients/${ingredientId}/opening`, { ...base, totalCostCents: checked.totalCostCents })
        : await api.post<{ movementId: number; quantityMilli: number; ingredient: { onHandMilli: number } }>(`/ingredients/${ingredientId}/corrections`, { ...base, kind });
      // The server says what it stored, which for a count is the difference and not the number typed.
      onDone(correctionSavedText({ kind, date, baseUnit, quantityMilli: r.quantityMilli, totalCostCents: checked.totalCostCents, onHandNowMilli: r.ingredient.onHandMilli }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not save.';
      if (isCount && isNothingToCorrect(message)) {
        // Stock already matches the count: good news, and nothing was saved.
        onDone('Nothing to correct: the count matches the recorded stock for that date, so stock is right. Nothing was saved.');
        return;
      }
      setError(message);
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

  const quantityLabel = isCount ? 'Quantity counted' : isOpening ? 'Quantity on hand' : 'Quantity lost';

  return (
    <form className="card" onSubmit={submit}>
      <h3>{FORM_NAMES[kind]}</h3>
      {isCount && (
        <p className="hint">
          Type what you counted on the shelf. The app works out the difference from what it has recorded for that date. {COUNT_END_OF_DAY_NOTE}
        </p>
      )}
      {isOpening && <p className="hint">The stock you already had when you started, and what it cost. It can be entered once.</p>}
      <div className="form-grid">
        <label>
          Date
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
          {quantityLabel}
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
        {isOpening && (
          <label>
            Total cost (₱)
            <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="1250.00" required />
            <small>For the whole quantity, not per kg.</small>
          </label>
        )}
        <label className="wide">
          {isCount ? 'Note (optional)' : 'Reason'}
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required={!isCount} />
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
            This is dated <strong>{dateText(date)}</strong>, more than a year ago. Is the year right? An old date is hard to put right later.
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
            {busy ? 'Saving…' : `Save ${FORM_NAMES[kind].toLowerCase()}`}
          </button>{' '}
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
      )}
    </form>
  );
}
