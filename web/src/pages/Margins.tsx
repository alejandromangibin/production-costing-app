import { Link } from 'react-router-dom';
import { api, useLoad, type MarginRow } from '../api';
import { Badge, Empty, ErrorNote, Loading, marginTone } from '../components';
import { dateText, peso, pct } from '../format';

export function Margins() {
  const { data, error, loading } = useLoad(() => api.get<MarginRow[]>('/margins'), []);

  return (
    <>
      <div className="page-head">
        <h1>Margins</h1>
      </div>
      <p className="hint">
        For each product and pack size: the cost from your most recent saved run, and the margin that cost gives at the price set today.
        If you changed a price since that run, the two margins differ. Voided runs are ignored.
      </p>
      <ErrorNote message={error} />
      {loading && !data && <Loading />}
      {data && data.length === 0 && <Empty>No saved runs with packs yet.</Empty>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Pack</th>
                <th>Latest run</th>
                <th className="num">Cost per pack</th>
                <th className="num">Price then</th>
                <th className="num">Margin then</th>
                <th className="num">Price now</th>
                <th className="num">Margin now</th>
                <th className="num">Markup now</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={`${r.productId}-${r.piecesPerPack}`}>
                  <td>{r.productName}</td>
                  <td>{r.piecesPerPack} pcs</td>
                  <td>
                    <Link to={`/runs/${r.runId}`}>{dateText(r.runDate)}</Link>
                  </td>
                  <td className="num">{peso(r.packCostCents)}</td>
                  <td className="num">{peso(r.runRetailPriceCents)}</td>
                  <td className="num">{pct(r.runMarginPct)}</td>
                  <td className="num">{r.packActive ? peso(r.currentRetailPriceCents) : <span className="muted">archived</span>}</td>
                  <td className="num">
                    {r.packActive ? <Badge tone={marginTone(r.currentMarginPct)}>{pct(r.currentMarginPct)}</Badge> : '–'}
                  </td>
                  <td className="num">{r.packActive ? pct(r.currentMarkupPct) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Margin = (price − cost) ÷ price. Markup = (price − cost) ÷ cost. Red means a loss, amber means under 20%.
      </p>
    </>
  );
}
