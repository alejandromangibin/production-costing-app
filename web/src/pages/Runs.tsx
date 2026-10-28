import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLoad, type Product, type RunSummary } from '../api';
import { Badge, Empty, ErrorNote, Loading } from '../components';
import { dateText, peso } from '../format';

export function Runs() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [productId, setProductId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (productId) params.set('productId', productId);
  if (status) params.set('status', status);
  if (q.trim()) params.set('q', q.trim());
  const qs = params.toString();

  const products = useLoad(() => api.get<Product[]>('/products?includeInactive=1'), []);
  const runs = useLoad(() => api.get<RunSummary[]>(`/runs${qs ? `?${qs}` : ''}`), [qs]);

  return (
    <>
      <div className="page-head">
        <h1>Run history</h1>
        <a className="button" href={`/api/runs/export.csv${qs ? `?${qs}` : ''}`}>
          Download CSV
        </a>
      </div>

      <div className="card filters">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Product
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="saved">Saved</option>
            <option value="void">Voided</option>
          </select>
        </label>
        <label>
          Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Batch code, product, note" />
        </label>
      </div>

      <ErrorNote message={runs.error} />
      {runs.loading && !runs.data && <Loading />}
      {runs.data && runs.data.length === 0 && (
        <Empty>
          {qs ? 'No runs match these filters.' : 'No runs yet. Record your first one under “New run”.'}
        </Empty>
      )}
      {runs.data && runs.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Products</th>
                <th className="num">Good pieces</th>
                <th className="num">Total cost</th>
                <th>Note</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className={r.status === 'void' ? 'voided' : ''}>
                  <td>
                    <Link to={`/runs/${r.id}`}>{dateText(r.runDate)}</Link>
                  </td>
                  <td>{r.productNames}</td>
                  <td className="num">{r.goodPieces}</td>
                  <td className="num">{peso(r.totalCostCents)}</td>
                  <td>{r.note}</td>
                  <td>{r.status === 'void' ? <Badge tone="bad">Voided</Badge> : <Badge tone="good">Saved</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.data && runs.data.length === 500 && <p className="hint">Showing the 500 most recent runs. Narrow the dates to see older ones.</p>}
    </>
  );
}
