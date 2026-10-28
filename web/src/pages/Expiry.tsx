import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useLoad, type ExpiryBatch } from '../api';
import { Badge, Empty, ErrorNote, Loading } from '../components';
import { dateText, remember } from '../format';

const KEY = 'costing.expiryWarnDays';

export function Expiry() {
  const [warnText, setWarnText] = useState(() => String(remember.get<number>(KEY, 14)));
  const [showExpired, setShowExpired] = useState(true);
  const { data, error, loading } = useLoad(
    // No ?today=: the server counts days left from today in the business time zone.
    () => api.get<{ today: string; batches: ExpiryBatch[]; moreCurrent: boolean; moreExpired: boolean }>('/batches/expiry'),
    [],
  );

  const warn = Number.isInteger(Number(warnText)) && Number(warnText) >= 0 ? Number(warnText) : 14;
  const onWarnChange = (v: string) => {
    setWarnText(v);
    if (Number.isInteger(Number(v)) && Number(v) >= 0 && v.trim() !== '') remember.set(KEY, Number(v));
  };

  const rows = (data?.batches ?? []).filter((b) => showExpired || b.daysRemaining >= 0);

  return (
    <>
      <div className="page-head">
        <h1>Expiry board</h1>
      </div>
      <p className="hint">
        Batches from saved runs, soonest to expire first. Dates are the ones you recorded for each batch; check the actual product before
        selling.
      </p>
      <div className="card filters">
        <label>
          Warn when expiring within (days)
          <input inputMode="numeric" value={warnText} onChange={(e) => onWarnChange(e.target.value)} />
        </label>
        <label className="check inline">
          <input type="checkbox" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} />
          Show expired batches
        </label>
      </div>

      <ErrorNote message={error} />
      {data?.moreCurrent && <p className="hint">Showing the batches that expire soonest. There are more batches with later expiry dates.</p>}
      {data?.moreExpired && showExpired && <p className="hint">Showing the most recently expired batches only. Older expired batches are in History.</p>}
      {loading && !data && <Loading />}
      {data && rows.length === 0 && <Empty>No batches to show.</Empty>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Product</th>
                <th>Produced</th>
                <th>Expires</th>
                <th className="num">Days left</th>
                <th className="num">Good pieces made</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const expired = b.daysRemaining < 0;
                const soon = !expired && b.daysRemaining <= warn;
                return (
                  <tr key={b.runProductId} className={expired ? 'row-bad' : soon ? 'row-warn' : ''}>
                    <td>
                      <Link to={`/runs/${b.runId}`}>{b.batchCode}</Link>
                    </td>
                    <td>{b.productName}</td>
                    <td>{dateText(b.productionDate)}</td>
                    <td>{dateText(b.expiryDate)}</td>
                    <td className="num">{b.daysRemaining}</td>
                    <td className="num">{b.goodPieces}</td>
                    <td>{expired ? <Badge tone="bad">Expired</Badge> : soon ? <Badge tone="warn">Soon</Badge> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">This list shows how much was made, not how much is still in stock. Stock tracking is a later phase.</p>
    </>
  );
}
