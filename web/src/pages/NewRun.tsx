import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, useLoad, type CostCategory, type Product, type RunBody, type RunPreview } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorNote, Loading, marginTone } from '../components';
import { addDaysISO, dateText, parseCents, parseCount, peso, pct, remember, todayISO } from '../format';

interface Row {
  productId: number;
  loose: string;
  rejected: string;
  packs: Record<number, string>;
  productionDate: string;
  expiryDate: string;
}
interface Cost {
  key: string;
  category: CostCategory;
  description: string;
  amount: string;
  scope: 'shared' | 'specific';
  targets: number[];
}
interface Draft {
  runDate: string;
  note: string;
  rows: Row[];
  costs: Cost[];
}

const DRAFT_KEY = 'costing.newRunDraft.v1';
const CATEGORIES: { value: CostCategory; label: string }[] = [
  { value: 'ingredient', label: 'Ingredient' },
  { value: 'gas', label: 'Gas' },
  { value: 'electricity', label: 'Electricity' },
  { value: 'labor', label: 'Labor' },
  { value: 'other', label: 'Other' },
];

let keyCounter = 0;
const newKey = () => `c${Date.now()}-${keyCounter++}`;

function emptyDraft(): Draft {
  return { runDate: todayISO(), note: '', rows: [], costs: [] };
}

/** Turn what is typed on screen into a request. Returns what is wrong if it cannot yet. */
function buildBody(d: Draft, products: Product[]): { body: RunBody | null; problems: string[] } {
  const problems: string[] = [];
  if (d.rows.length === 0) return { body: null, problems: ['Add the products made in this run.'] };

  const rows = d.rows.map((r) => {
    const name = products.find((p) => p.id === r.productId)?.name ?? 'A product';
    const loose = parseCount(r.loose);
    const rejected = parseCount(r.rejected);
    const packings = Object.entries(r.packs).map(([id, text]) => ({ packSizeId: Number(id), packs: parseCount(text) }));
    if ([loose, rejected, ...packings.map((k) => k.packs)].some(Number.isNaN)) {
      problems.push(`${name}: pieces and packs must be whole numbers.`);
    }
    return {
      productId: r.productId,
      loosePieces: loose,
      rejectedPieces: rejected,
      ...(r.productionDate ? { productionDate: r.productionDate } : {}),
      ...(r.expiryDate ? { expiryDate: r.expiryDate } : {}),
      packings: packings.filter((k) => k.packs > 0 || Number.isNaN(k.packs)),
    };
  });

  const inRun = new Set(d.rows.map((r) => r.productId));
  const costs: RunBody['costs'] = [];
  for (const c of d.costs) {
    if (c.amount.trim() === '') continue;
    const cents = parseCents(c.amount);
    const label = c.description || CATEGORIES.find((x) => x.value === c.category)!.label;
    if (cents === null) {
      problems.push(`Cost "${label}": type the amount like 1250 or 1250.50.`);
      continue;
    }
    const targets = c.targets.filter((t) => inRun.has(t));
    if (c.scope === 'specific' && targets.length === 0) {
      problems.push(`Cost "${label}": tick the products it belongs to, or make it shared.`);
      continue;
    }
    costs.push({ category: c.category, description: c.description, amountCents: cents, scope: c.scope, targetProductIds: targets });
  }

  if (problems.length) return { body: null, problems };
  return { body: { runDate: d.runDate, note: d.note, products: rows, costs }, problems };
}

export function NewRun() {
  const navigate = useNavigate();
  const { data: products, error: loadError, loading } = useLoad(() => api.get<Product[]>('/products'), []);
  const [draft, setDraft] = useState<Draft>(() => remember.get<Draft>(DRAFT_KEY, emptyDraft()));
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const seq = useRef(0);

  // Keep the draft so a refresh or closed tab does not lose typing.
  useEffect(() => remember.set(DRAFT_KEY, draft), [draft]);

  // A restored draft may mention products that were archived or removed since: drop those.
  useEffect(() => {
    if (!products) return;
    const ids = new Set(products.map((p) => p.id));
    setDraft((d) => {
      if (d.rows.every((r) => ids.has(r.productId))) return d;
      const rows = d.rows.filter((r) => ids.has(r.productId));
      return { ...d, rows, costs: d.costs.map((c) => ({ ...c, targets: c.targets.filter((t) => ids.has(t)) })) };
    });
  }, [products]);

  const { body, problems } = useMemo(() => buildBody(draft, products ?? []), [draft, products]);
  const bodyKey = body ? JSON.stringify(body) : '';

  // Ask the server for the numbers whenever the entries change (the calculation lives only on the server).
  useEffect(() => {
    setConfirming(false);
    if (!body) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api.post<RunPreview>('/runs/preview', body).then(
        (p) => {
          if (mine !== seq.current) return;
          setPreview(p);
          setPreviewError(null);
        },
        (e: Error) => {
          if (mine !== seq.current) return;
          setPreview(null);
          setPreviewError(e.message);
        },
      );
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey]);

  if (loading) return <Loading />;
  if (loadError || !products) return <ErrorNote message={loadError} />;

  const available = products.filter((p) => !draft.rows.some((r) => r.productId === p.id));
  const productById = (id: number) => products.find((p) => p.id === id) ?? { id, code: '?', name: 'Unknown product', shelfLifeDays: 0, notes: '', active: false, packSizes: [] };

  if (products.length === 0) {
    return (
      <div className="empty">
        <h2>Set up your products first</h2>
        <p>Add each product you make, and the pack sizes you sell, before recording a run.</p>
        <button className="primary" onClick={() => navigate('/products')}>
          Go to Products
        </button>
      </div>
    );
  }

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateRow = (productId: number, patch: Partial<Row>) =>
    setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.productId === productId ? { ...r, ...patch } : r)) }));

  const addProduct = (id: number) => {
    const p = productById(id);
    const row: Row = { productId: id, loose: '', rejected: '', packs: {}, productionDate: '', expiryDate: '' };
    for (const s of p.packSizes) row.packs[s.id] = '';
    setDraft((d) => ({ ...d, rows: [...d.rows, row] }));
  };
  const removeProduct = (id: number) =>
    setDraft((d) => ({
      ...d,
      rows: d.rows.filter((r) => r.productId !== id),
      costs: d.costs.map((c) => ({ ...c, targets: c.targets.filter((t) => t !== id) })),
    }));

  const addCost = (category: CostCategory) =>
    setDraft((d) => ({
      ...d,
      costs: [...d.costs, { key: newKey(), category, description: '', amount: '', scope: 'shared', targets: [] }],
    }));
  const updateCost = (key: string, patch: Partial<Cost>) =>
    setDraft((d) => ({ ...d, costs: d.costs.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const removeCost = (key: string) => setDraft((d) => ({ ...d, costs: d.costs.filter((c) => c.key !== key) }));

  async function save() {
    if (!body) return;
    setSaving(true);
    setSaveError(null);
    try {
      const run = await api.post<{ id: number }>('/runs', body);
      remember.clear(DRAFT_KEY);
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Could not save the run.');
      setSaving(false);
      setConfirming(false);
    }
  }

  const startOver = () => {
    if (draft.rows.length === 0 && draft.costs.length === 0 && !draft.note) return;
    if (window.confirm('Clear everything typed on this page and start over?')) setDraft(emptyDraft());
  };

  const { canWrite } = useAuth();
  const canSave = canWrite && !!preview && !previewError && problems.length === 0 && !saving;

  return (
    <>
      <div className="page-head">
        <h1>New production run</h1>
        <button className="link" onClick={startOver}>
          Start over
        </button>
      </div>

      <section className="card">
        <h2>1. The run</h2>
        <div className="form-grid">
          <label>
            Run date
            <input type="date" value={draft.runDate} onChange={(e) => update({ runDate: e.target.value })} />
          </label>
          <label className="wide">
            Note (optional)
            <input value={draft.note} maxLength={500} placeholder="e.g. Saturday batch, new supplier for pork" onChange={(e) => update({ note: e.target.value })} />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>2. What was made</h2>
        <p className="hint">
          For each product, enter the packs you packed (by size), the loose pieces left unpacked, and the pieces that were rejected.
        </p>
        {draft.rows.map((row, i) => {
          const p = productById(row.productId);
          const res = preview?.result.products[i];
          const meta = preview?.products[i];
          const defaultExpiry = addDaysISO(row.productionDate || draft.runDate, p.shelfLifeDays);
          return (
            <div className="product-block" key={row.productId}>
              <div className="product-block-head">
                <strong>{p.name}</strong> <span className="muted">{p.code}</span>
                <button className="link danger" onClick={() => removeProduct(row.productId)}>
                  Remove
                </button>
              </div>
              {p.packSizes.length === 0 && (
                <p className="note warn">This product has no pack sizes yet. Add them in Products to record packs; loose pieces still work.</p>
              )}
              <div className="form-grid">
                {p.packSizes.map((s) => (
                  <label key={s.id}>
                    Packs of {s.piecesPerPack}
                    <input
                      inputMode="numeric"
                      value={row.packs[s.id] ?? ''}
                      placeholder="0"
                      onChange={(e) => updateRow(row.productId, { packs: { ...row.packs, [s.id]: e.target.value } })}
                    />
                    <small>
                      sells {peso(s.retailPriceCents)} · packaging {peso(s.packagingCostCents)}
                    </small>
                  </label>
                ))}
                <label>
                  Loose pieces
                  <input inputMode="numeric" value={row.loose} placeholder="0" onChange={(e) => updateRow(row.productId, { loose: e.target.value })} />
                </label>
                <label>
                  Rejected pieces
                  <input inputMode="numeric" value={row.rejected} placeholder="0" onChange={(e) => updateRow(row.productId, { rejected: e.target.value })} />
                </label>
              </div>
              <div className="form-grid dates">
                <label>
                  Production date
                  <input type="date" value={row.productionDate || draft.runDate} onChange={(e) => updateRow(row.productId, { productionDate: e.target.value === draft.runDate ? '' : e.target.value })} />
                </label>
                <label>
                  Expiry date
                  <input type="date" value={row.expiryDate || defaultExpiry} onChange={(e) => updateRow(row.productId, { expiryDate: e.target.value === defaultExpiry ? '' : e.target.value })} />
                  <small>{row.expiryDate ? 'Changed by you' : `Default: ${p.shelfLifeDays} days shelf life`}</small>
                </label>
              </div>
              {res && (
                <p className="pieces-line">
                  <strong>{res.piecesMade}</strong> pieces made · <strong>{res.goodPieces}</strong> good
                  {meta && (
                    <>
                      {' '}
                      · batch <code>{meta.batchCode}</code>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
        <div className="add-row">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addProduct(Number(e.target.value));
            }}
            aria-label="Add a product to this run"
          >
            <option value="">{draft.rows.length ? '+ Add another product' : '+ Add a product'}</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="card">
        <h2>3. Costs of the run</h2>
        <p className="hint">
          <strong>Shared</strong> costs (base ingredients, gas, electricity) are split between all products by the pieces each made.{' '}
          <strong>Specific</strong> costs go only to the products you tick.
        </p>
        {draft.costs.map((c) => (
          <div className="cost-line" key={c.key}>
            <select value={c.category} onChange={(e) => updateCost(c.key, { category: e.target.value as CostCategory })} aria-label="Cost type">
              {CATEGORIES.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
            <input value={c.description} maxLength={120} placeholder="What was it? (optional)" onChange={(e) => updateCost(c.key, { description: e.target.value })} aria-label="Description" />
            <div className="money-input">
              <span>₱</span>
              <input inputMode="decimal" value={c.amount} placeholder="0.00" onChange={(e) => updateCost(c.key, { amount: e.target.value })} aria-label="Amount in pesos" />
            </div>
            <select value={c.scope} onChange={(e) => updateCost(c.key, { scope: e.target.value as Cost['scope'] })} aria-label="Shared or specific">
              <option value="shared">Shared by all</option>
              <option value="specific">Specific products</option>
            </select>
            <button className="link danger" onClick={() => removeCost(c.key)} aria-label="Remove this cost">
              Remove
            </button>
            {c.scope === 'specific' && (
              <div className="targets">
                {draft.rows.length === 0 && <span className="muted">Add products above first.</span>}
                {draft.rows.map((r) => (
                  <label key={r.productId} className="check">
                    <input
                      type="checkbox"
                      checked={c.targets.includes(r.productId)}
                      onChange={(e) =>
                        updateCost(c.key, {
                          targets: e.target.checked ? [...c.targets, r.productId] : c.targets.filter((t) => t !== r.productId),
                        })
                      }
                    />
                    {productById(r.productId).name}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="quick-add">
          {CATEGORIES.map((x) => (
            <button key={x.value} onClick={() => addCost(x.value)}>
              + {x.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card review">
        <h2>4. Review</h2>
        {problems.length > 0 && draft.rows.length > 0 && (
          <div className="note warn">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        <ErrorNote message={previewError} />
        {!preview && !previewError && problems.length === 0 && <p className="muted">Fill in the sections above to see the costing.</p>}
        {preview && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Made</th>
                    <th className="num">Good</th>
                    <th className="num">Shared share</th>
                    <th className="num">Specific</th>
                    <th className="num">Packaging</th>
                    <th className="num">Total cost</th>
                    <th className="num">Per good piece</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.result.products.map((r, i) => (
                    <tr key={r.productId}>
                      <td>{preview.products[i]?.name}</td>
                      <td className="num">{r.piecesMade}</td>
                      <td className="num">{r.goodPieces}</td>
                      <td className="num">{peso(r.sharedShareCents)}</td>
                      <td className="num">{peso(r.specificCents)}</td>
                      <td className="num">{peso(r.packagingCents)}</td>
                      <td className="num">{peso(r.totalCostCents)}</td>
                      <td className="num">{peso(Math.round(r.costPerGoodPiece))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Run total</th>
                    <td colSpan={2}></td>
                    <td className="num">{peso(preview.result.sharedCents)}</td>
                    <td className="num">{peso(preview.result.specificCents)}</td>
                    <td className="num">{peso(preview.result.packagingCents)}</td>
                    <td className="num">{peso(preview.result.totalCostCents)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <h3>Cost and margin per pack</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Pack</th>
                    <th className="num">Packs</th>
                    <th className="num">Cost per pack</th>
                    <th className="num">Retail price</th>
                    <th className="num">Margin</th>
                    <th className="num">Markup</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.result.products.flatMap((r, i) =>
                    r.packings.map((k) => (
                      <tr key={`${r.productId}-${k.packSizeId}`}>
                        <td>{preview.products[i]?.name}</td>
                        <td>{k.piecesPerPack} pcs</td>
                        <td className="num">{k.packs}</td>
                        <td className="num">{peso(k.packCostCents)}</td>
                        <td className="num">{peso(k.retailPriceCents)}</td>
                        <td className="num">
                          <Badge tone={marginTone(k.marginPct)}>{pct(k.marginPct)}</Badge>
                        </td>
                        <td className="num">{pct(k.markupPct)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <p className="hint">
              Batches: {preview.products.map((p) => `${p.batchCode} (expires ${dateText(p.expiryDate)})`).join(' · ')}
            </p>
          </>
        )}

        <ErrorNote message={saveError} />
        {!confirming ? (
          <button className="primary big" disabled={!canSave} onClick={() => setConfirming(true)}>
            Save run
          </button>
        ) : (
          <div className="note confirm">
            <p>
              Save this run with a total cost of <strong>{peso(preview?.result.totalCostCents)}</strong>? A saved run cannot be edited. If
              something is wrong you can void it and enter it again.
            </p>
            <button className="primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Yes, save it'}
            </button>{' '}
            <button onClick={() => setConfirming(false)} disabled={saving}>
              Go back
            </button>
          </div>
        )}
      </section>
    </>
  );
}
