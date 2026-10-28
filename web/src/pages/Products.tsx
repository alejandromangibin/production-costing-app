import { useState } from 'react';
import { ApiError, api, useLoad, type PackSize, type Product } from '../api';
import { useAuth } from '../auth';
import { Badge, Empty, ErrorNote, Loading } from '../components';
import { centsToInput, parseCents } from '../format';

export function Products() {
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, reload } = useLoad(
    () => api.get<Product[]>(`/products${showArchived ? '?includeInactive=1' : ''}`),
    [showArchived],
  );
  const [adding, setAdding] = useState(false);
  const { canWrite } = useAuth();

  return (
    <>
      <div className="page-head">
        <h1>Products</h1>
        <div>
          <label className="check inline">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>{' '}
          <button className="primary" onClick={() => setAdding(true)} disabled={adding || !canWrite}>
            + New product
          </button>
        </div>
      </div>
      <p className="hint">
        Set up each product once: its shelf life and the pack sizes you sell, with their prices. Changing a price later never changes runs
        you already saved.
      </p>

      {adding && (
        <NewProductForm
          onDone={() => {
            setAdding(false);
            reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <ErrorNote message={error} />
      {loading && !data && <Loading />}
      {data && data.length === 0 && !adding && <Empty>No products yet. Click “New product” to add your first one.</Empty>}
      {data?.map((p) => <ProductCard key={p.id} product={p} onChanged={reload} />)}
    </>
  );
}

function NewProductForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [shelf, setShelf] = useState('');
  const [notes, setNotes] = useState('');
  const [pieces, setPieces] = useState('12');
  const [price, setPrice] = useState('');
  const [packaging, setPackaging] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const shelfDays = Number(shelf);
    if (!Number.isInteger(shelfDays) || shelfDays < 0 || shelf.trim() === '') return setError('Shelf life must be a whole number of days, for example 90.');
    const retail = parseCents(price);
    const pack = packaging.trim() === '' ? 0 : parseCents(packaging);
    const ppp = Number(pieces);
    const wantsPack = price.trim() !== '';
    if (wantsPack && (retail === null || retail <= 0)) return setError('Type the retail price like 70 or 70.00.');
    if (wantsPack && (!Number.isInteger(ppp) || ppp < 1)) return setError('Pieces per pack must be a whole number, 1 or more.');
    if (pack === null) return setError('Type the packaging cost like 5 or 5.50.');

    setBusy(true);
    try {
      await api.post('/products', {
        code,
        name,
        shelfLifeDays: shelfDays,
        notes,
        packSizes: wantsPack ? [{ piecesPerPack: ppp, retailPriceCents: retail, packagingCostCents: pack, isDefault: true }] : [],
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>New product</h2>
      <div className="form-grid">
        <label>
          Short code
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PORK" maxLength={12} required />
          <small>Used in batch codes, e.g. 20261019-PORK</small>
        </label>
        <label className="wide">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pork Siomai" maxLength={80} required />
        </label>
        <label>
          Shelf life (days)
          <input inputMode="numeric" value={shelf} onChange={(e) => setShelf(e.target.value)} placeholder="90" required />
        </label>
        <label className="wide">
          Notes (optional)
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </label>
      </div>
      <h3>First pack size (you can add more later)</h3>
      <div className="form-grid">
        <label>
          Pieces per pack
          <input inputMode="numeric" value={pieces} onChange={(e) => setPieces(e.target.value)} />
        </label>
        <label>
          Retail price per pack (₱)
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="70.00" />
        </label>
        <label>
          Packaging cost per pack (₱)
          <input inputMode="decimal" value={packaging} onChange={(e) => setPackaging(e.target.value)} placeholder="5.00" />
        </label>
      </div>
      <ErrorNote message={error} />
      <button className="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save product'}
      </button>{' '}
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </form>
  );
}

function ProductCard({ product, onChanged }: { product: Product; onChanged: () => void }) {
  const [name, setName] = useState(product.name);
  const [shelf, setShelf] = useState(String(product.shelfLifeDays));
  const [notes, setNotes] = useState(product.notes);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [addingSize, setAddingSize] = useState(false);

  const dirty = name !== product.name || shelf !== String(product.shelfLifeDays) || notes !== product.notes;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setSaved(false);
    try {
      await action();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
      return false;
    }
  }

  const saveDetails = async () => {
    const days = Number(shelf);
    if (!Number.isInteger(days) || days < 0 || shelf.trim() === '') return setError('Shelf life must be a whole number of days.');
    if (await run(() => api.patch(`/products/${product.id}`, { name, shelfLifeDays: days, notes }))) setSaved(true);
  };

  return (
    <section className={`card ${product.active ? '' : 'archived'}`}>
      <div className="product-block-head">
        <h2>
          {product.name} <span className="muted">{product.code}</span> {!product.active && <Badge tone="muted">Archived</Badge>}
        </h2>
        <button className="link" onClick={() => run(() => api.patch(`/products/${product.id}`, { active: !product.active }))}>
          {product.active ? 'Archive' : 'Turn back on'}
        </button>
      </div>

      <div className="form-grid">
        <label className="wide">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
        <label>
          Shelf life (days)
          <input inputMode="numeric" value={shelf} onChange={(e) => setShelf(e.target.value)} />
        </label>
        <label className="wide">
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </label>
      </div>
      {dirty && (
        <button className="primary" onClick={saveDetails}>
          Save changes
        </button>
      )}
      {saved && !dirty && <span className="muted"> Saved.</span>}

      <h3>Pack sizes</h3>
      {product.packSizes.length === 0 && <p className="muted">No pack sizes yet.</p>}
      {product.packSizes.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pieces</th>
                <th className="num">Retail price</th>
                <th className="num">Reseller price</th>
                <th className="num">Packaging</th>
                <th>Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {product.packSizes.map((s) => (
                <PackSizeRow key={`${s.id}-${s.retailPriceCents}-${s.resellerPriceCents}-${s.packagingCostCents}-${s.active}`} size={s} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {addingSize ? (
        <AddPackSize
          productId={product.id}
          run={run}
          onClose={() => setAddingSize(false)}
        />
      ) : (
        <button onClick={() => setAddingSize(true)}>+ Add pack size</button>
      )}
      <ErrorNote message={error} />
    </section>
  );
}

type Run = (action: () => Promise<unknown>) => Promise<boolean>;

function PackSizeRow({ size, run }: { size: PackSize; run: Run }) {
  const [retail, setRetail] = useState(centsToInput(size.retailPriceCents));
  const [reseller, setReseller] = useState(centsToInput(size.resellerPriceCents));
  const [packaging, setPackaging] = useState(centsToInput(size.packagingCostCents));
  const [error, setError] = useState<string | null>(null);

  const dirty =
    retail !== centsToInput(size.retailPriceCents) ||
    reseller !== centsToInput(size.resellerPriceCents) ||
    packaging !== centsToInput(size.packagingCostCents);

  async function save() {
    const r = parseCents(retail);
    const p = parseCents(packaging);
    const rs = reseller.trim() === '' ? null : parseCents(reseller);
    if (r === null || r <= 0) return setError('Retail price?');
    if (p === null) return setError('Packaging cost?');
    if (reseller.trim() !== '' && (rs === null || rs <= 0)) return setError('Reseller price?');
    setError(null);
    await run(() => api.patch(`/pack-sizes/${size.id}`, { retailPriceCents: r, packagingCostCents: p, resellerPriceCents: rs }));
  }

  return (
    <tr className={size.active ? '' : 'archived'}>
      <td>
        {size.piecesPerPack} pcs {!size.active && <Badge tone="muted">Archived</Badge>}
      </td>
      <td className="num">
        <input className="price" inputMode="decimal" value={retail} onChange={(e) => setRetail(e.target.value)} aria-label="Retail price" />
      </td>
      <td className="num">
        <input className="price" inputMode="decimal" value={reseller} placeholder="–" onChange={(e) => setReseller(e.target.value)} aria-label="Reseller price" />
      </td>
      <td className="num">
        <input className="price" inputMode="decimal" value={packaging} onChange={(e) => setPackaging(e.target.value)} aria-label="Packaging cost" />
      </td>
      <td>
        {size.active ? (
          <input
            type="radio"
            name={`default-${size.productId}`}
            checked={size.isDefault}
            onChange={() => run(() => api.patch(`/pack-sizes/${size.id}`, { isDefault: true }))}
            aria-label="Default pack size"
          />
        ) : null}
      </td>
      <td className="actions">
        {dirty && (
          <button className="primary small" onClick={save}>
            Save
          </button>
        )}{' '}
        <button className="link" onClick={() => run(() => api.patch(`/pack-sizes/${size.id}`, { active: !size.active }))}>
          {size.active ? 'Archive' : 'Turn on'}
        </button>
        {error && <span className="field-error"> {error}</span>}
      </td>
    </tr>
  );
}

function AddPackSize({ productId, run, onClose }: { productId: number; run: Run; onClose: () => void }) {
  const [pieces, setPieces] = useState('');
  const [retail, setRetail] = useState('');
  const [reseller, setReseller] = useState('');
  const [packaging, setPackaging] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ppp = Number(pieces);
    const r = parseCents(retail);
    const p = packaging.trim() === '' ? 0 : parseCents(packaging);
    const rs = reseller.trim() === '' ? null : parseCents(reseller);
    if (!Number.isInteger(ppp) || ppp < 1) return setError('Pieces per pack must be a whole number, 1 or more.');
    if (r === null || r <= 0) return setError('Type the retail price like 110 or 110.00.');
    if (p === null) return setError('Type the packaging cost like 5 or 5.50.');
    if (reseller.trim() !== '' && (rs === null || rs <= 0)) return setError('Type the reseller price like 90 or 90.00.');
    setError(null);
    if (await run(() => api.post(`/products/${productId}/pack-sizes`, { piecesPerPack: ppp, retailPriceCents: r, resellerPriceCents: rs, packagingCostCents: p }))) onClose();
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <label>
        Pieces per pack
        <input inputMode="numeric" value={pieces} onChange={(e) => setPieces(e.target.value)} placeholder="20" autoFocus />
      </label>
      <label>
        Retail price (₱)
        <input inputMode="decimal" value={retail} onChange={(e) => setRetail(e.target.value)} />
      </label>
      <label>
        Reseller price (₱, optional)
        <input inputMode="decimal" value={reseller} onChange={(e) => setReseller(e.target.value)} />
      </label>
      <label>
        Packaging (₱)
        <input inputMode="decimal" value={packaging} onChange={(e) => setPackaging(e.target.value)} />
      </label>
      <button className="primary">Add</button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
      {error && <span className="field-error">{error}</span>}
    </form>
  );
}
