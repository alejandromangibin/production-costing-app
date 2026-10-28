import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, useLoad, type RunDetail } from '../api';
import { Badge, ErrorNote, Loading, marginTone } from '../components';
import { dateText, peso, pct } from '../format';

const CATEGORY_LABEL: Record<string, string> = {
  ingredient: 'Ingredient',
  gas: 'Gas',
  electricity: 'Electricity',
  labor: 'Labor',
  other: 'Other',
};

export function RunDetailPage() {
  const { id } = useParams();
  const { data: run, error, loading, reload } = useLoad(() => api.get<RunDetail>(`/runs/${id}`), [id]);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [voidError, setVoidError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !run) return <Loading />;
  if (error || !run) return <ErrorNote message={error ?? 'Run not found.'} />;

  async function doVoid() {
    setBusy(true);
    setVoidError(null);
    try {
      await api.post(`/runs/${run!.id}/void`, { reason });
      setVoiding(false);
      reload();
    } catch (e) {
      setVoidError(e instanceof ApiError ? e.message : 'Could not void the run.');
    } finally {
      setBusy(false);
    }
  }

  const productName = (runProductId: number) => run.products.find((p) => p.id === runProductId)?.productName ?? '';

  return (
    <>
      <p>
        <Link to="/runs">← Back to history</Link>
      </p>
      <div className="page-head">
        <h1>
          Run on {dateText(run.runDate)}{' '}
          {run.status === 'void' ? <Badge tone="bad">Voided</Badge> : <Badge tone="good">Saved</Badge>}
        </h1>
        {run.status === 'saved' && !voiding && (
          <button className="danger" onClick={() => setVoiding(true)}>
            Void this run
          </button>
        )}
      </div>

      {run.status === 'void' && (
        <div className="note error">
          This run was voided{run.voidedAt ? ` on ${dateText(run.voidedAt)}` : ''}: {run.voidReason}. It is left out of the expiry list and
          margins.
        </div>
      )}
      {voiding && (
        <div className="note confirm">
          <p>
            Voiding keeps the run in your history but removes it from the expiry list and margins. It cannot be undone. Enter the correct
            run again under “New run”.
          </p>
          <label>
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Wrong cost entered" autoFocus />
          </label>
          <ErrorNote message={voidError} />
          <button className="danger" disabled={busy || !reason.trim()} onClick={doVoid}>
            {busy ? 'Voiding…' : 'Void run'}
          </button>{' '}
          <button onClick={() => setVoiding(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}

      <p>
        <strong>Total cost {peso(run.totalCostCents)}</strong>
        {run.note && <> · {run.note}</>}
      </p>

      {run.products.map((p) => (
        <section className="card" key={p.id}>
          <h2>
            {p.productName} <span className="muted">batch {p.batchCode}</span>
          </h2>
          <p className="muted">
            Produced {dateText(p.productionDate)} · expires {dateText(p.expiryDate)}
          </p>
          <div className="stats">
            <div>
              <span>Pieces made</span>
              <strong>{p.piecesMade}</strong>
            </div>
            <div>
              <span>Packed</span>
              <strong>{p.packedPieces}</strong>
            </div>
            <div>
              <span>Loose</span>
              <strong>{p.loosePieces}</strong>
            </div>
            <div>
              <span>Rejected</span>
              <strong>{p.rejectedPieces}</strong>
            </div>
            <div>
              <span>Good pieces</span>
              <strong>{p.goodPieces}</strong>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Shared share</th>
                  <td className="num">{peso(p.sharedShareCents)}</td>
                  <th>Specific costs</th>
                  <td className="num">{peso(p.specificCents)}</td>
                </tr>
                <tr>
                  <th>Packaging</th>
                  <td className="num">{peso(p.packagingCents)}</td>
                  <th>Total cost</th>
                  <td className="num">
                    <strong>{peso(p.totalCostCents)}</strong>
                  </td>
                </tr>
                <tr>
                  <th>Cost per good piece</th>
                  <td className="num">{peso(Math.round(p.costPerGoodPiece))}</td>
                  <td colSpan={2}></td>
                </tr>
              </tbody>
            </table>
          </div>
          {p.packings.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pack</th>
                    <th className="num">Packs made</th>
                    <th className="num">Cost per pack</th>
                    <th className="num">Retail price</th>
                    <th className="num">Margin</th>
                    <th className="num">Markup</th>
                  </tr>
                </thead>
                <tbody>
                  {p.packings.map((k) => (
                    <tr key={k.id}>
                      <td>{k.piecesPerPack} pcs</td>
                      <td className="num">{k.packs}</td>
                      <td className="num">{peso(k.packCostCents)}</td>
                      <td className="num">{peso(k.retailPriceCents)}</td>
                      <td className="num">
                        <Badge tone={marginTone(k.marginPct)}>{pct(k.marginPct)}</Badge>
                      </td>
                      <td className="num">{pct(k.markupPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <section className="card">
        <h2>Costs entered</h2>
        {run.costs.length === 0 ? (
          <p className="muted">No ingredient or other costs were entered. Only packaging is counted.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Applies to</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {run.costs.map((c) => (
                  <tr key={c.id}>
                    <td>{CATEGORY_LABEL[c.category] ?? c.category}</td>
                    <td>{c.description}</td>
                    <td>{c.scope === 'shared' ? 'Shared by all products' : c.targetRunProductIds.map(productName).join(', ')}</td>
                    <td className="num">{peso(c.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
