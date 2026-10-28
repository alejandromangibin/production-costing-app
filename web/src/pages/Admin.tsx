import { useState, type FormEvent } from 'react';
import { ApiError, api, useLoad, type AdminTenant, type Payment, type Person, type TenantStatus } from '../api';
import { Badge, Empty, ErrorNote, LinkBox, Loading } from '../components';
import { dateText, parseCents, peso, todayISO } from '../format';

const STATUS_LABEL: Record<TenantStatus, string> = { trial: 'Trial', active: 'Subscribed', cancelled: 'Cancelled', suspended: 'Suspended' };

function message(err: unknown) {
  return err instanceof ApiError ? err.message : 'Something went wrong.';
}

export function Admin() {
  const list = useLoad(() => api.get<AdminTenant[]>('/admin/tenants'), []);
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <>
      <div className="page-head">
        <h1>Businesses</h1>
      </div>
      <NewBusiness onCreated={list.reload} />
      <section className="card">
        <h2>All businesses</h2>
        {list.loading && !list.data && <Loading />}
        <ErrorNote message={list.error} />
        {list.data?.length === 0 && <Empty>No businesses yet. Create the first one above.</Empty>}
        {list.data && list.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Until</th>
                  <th className="num">Runs</th>
                  <th>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((t) => (
                  <tr key={t.id} className={openId === t.id ? 'selected' : ''} onClick={() => setOpenId(openId === t.id ? null : t.id)} style={{ cursor: 'pointer' }}>
                    <td>
                      <button className="link" aria-expanded={openId === t.id}>
                        {t.name}
                      </button>
                    </td>
                    <td>{t.ownerEmail ?? <Badge tone="warn">No owner</Badge>}</td>
                    <td>
                      <Badge tone={t.access.level === 'full' ? 'good' : t.access.level === 'read_only' ? 'warn' : 'bad'}>{STATUS_LABEL[t.status]}</Badge>
                      {t.access.level === 'read_only' && <span className="hint"> read-only</span>}
                    </td>
                    <td>{t.status === 'trial' ? dateText(t.trialEndsOn) : dateText(t.paidThrough)}</td>
                    <td className="num">{t.savedRuns}</td>
                    <td>{t.lastLoginAt ? dateText(t.lastLoginAt) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {list.data?.map((t) => (openId === t.id ? <TenantPanel key={t.id} tenant={t} onChanged={list.reload} /> : null))}
    </>
  );
}

function NewBusiness({ onCreated }: { onCreated: () => void }) {
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [trialDays, setTrialDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; what: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ inviteUrl: string }>('/admin/tenants', { businessName, ownerName, ownerEmail, trialDays: Number(trialDays) });
      setLink({ url: r.inviteUrl, what: `Invitation link for ${ownerName} (${businessName})` });
      setBusinessName('');
      setOwnerName('');
      setOwnerEmail('');
      onCreated();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Add a business</h2>
      <div className="form-grid">
        <label>
          Business name
          <input required value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
        </label>
        <label>
          Owner name
          <input required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
        </label>
        <label>
          Owner email
          <input type="email" required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
        </label>
        <label>
          Free trial (days)
          <input inputMode="numeric" required value={trialDays} onChange={(e) => setTrialDays(e.target.value)} />
        </label>
      </div>
      <ErrorNote message={error} />
      {link && <LinkBox url={link.url} what={link.what} />}
      <button className="primary" disabled={busy}>
        Create business and invitation link
      </button>
    </form>
  );
}

function TenantPanel({ tenant, onChanged }: { tenant: AdminTenant; onChanged: () => void }) {
  const payments = useLoad(() => api.get<Payment[]>(`/admin/tenants/${tenant.id}/payments`), [tenant.id]);
  const people = useLoad(() => api.get<Person[]>(`/admin/tenants/${tenant.id}/people`), [tenant.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; what: string } | null>(null);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('GCash');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayISO());
  const [months, setMonths] = useState('1');
  const [trialEnds, setTrialEnds] = useState(tenant.trialEndsOn);
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const pay = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const cents = parseCents(amount);
      if (cents === null || cents <= 0) throw new ApiError('Enter the amount received, like 1500.00.', 400);
      await api.post(`/admin/tenants/${tenant.id}/payments`, { amountCents: cents, method, reference, paidOn, months: Number(months) });
      setAmount('');
      setReference('');
      payments.reload();
      onChanged();
    });
  };

  const patch = (body: object) =>
    run(async () => {
      await api.patch(`/admin/tenants/${tenant.id}`, body);
      onChanged();
    });

  const signInLink = (p: Person) =>
    run(async () => {
      const r = await api.post<{ url: string; kind: string }>(`/admin/tenants/${tenant.id}/people/${p.id}/link`);
      setLink({ url: r.url, what: r.kind === 'invite' ? `Invitation link for ${p.name}` : `Password reset link for ${p.name}` });
    });

  const addOwner = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ inviteUrl: string }>(`/admin/tenants/${tenant.id}/owner`, { name: ownerName, email: ownerEmail });
      setLink({ url: r.inviteUrl, what: `Invitation link for ${ownerName}` });
      people.reload();
      onChanged();
    });
  };

  return (
    <section className="card">
      <h2>{tenant.name}</h2>
      <p className="hint">
        {tenant.access.message ?? 'All good.'} · {tenant.people} active {tenant.people === 1 ? 'person' : 'people'} · {tenant.savedRuns} saved runs
      </p>
      <ErrorNote message={error} />
      {link && <LinkBox url={link.url} what={link.what} />}

      <h3>Record a payment</h3>
      <form className="inline-form" onSubmit={pay}>
        <label>
          Amount (₱)
          <input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1500.00" />
        </label>
        <label>
          Method
          <input value={method} onChange={(e) => setMethod(e.target.value)} />
        </label>
        <label>
          Reference
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          Paid on
          <input type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
        <label>
          Months covered
          <input inputMode="numeric" required value={months} onChange={(e) => setMonths(e.target.value)} />
        </label>
        <button className="primary" disabled={busy}>
          Record payment
        </button>
      </form>

      {payments.data && payments.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Paid on</th>
                <th className="num">Amount</th>
                <th>Method</th>
                <th>Reference</th>
                <th className="num">Months</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((p) => (
                <tr key={p.id}>
                  <td>{dateText(p.paidOn)}</td>
                  <td className="num">{peso(p.amountCents)}</td>
                  <td>{p.method}</td>
                  <td>{p.reference}</td>
                  <td className="num">{p.months}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Status</h3>
      <div className="inline-form">
        <label>
          Account status
          <select value={tenant.status} disabled={busy} onChange={(e) => void patch({ status: e.target.value })}>
            <option value="trial">Trial</option>
            <option value="active">Subscribed</option>
            <option value="cancelled">Cancelled (read-only)</option>
            <option value="suspended">Suspended (locked out)</option>
          </select>
        </label>
        <label>
          Trial ends
          <input type="date" value={trialEnds} onChange={(e) => setTrialEnds(e.target.value)} />
        </label>
        <button disabled={busy || trialEnds === tenant.trialEndsOn || !trialEnds} onClick={() => void patch({ trialEndsOn: trialEnds })}>
          Change trial end
        </button>
      </div>

      <h3>People</h3>
      {people.data?.length === 0 && (
        <form className="inline-form" onSubmit={addOwner}>
          <label>
            Owner name
            <input required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label>
            Owner email
            <input type="email" required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          </label>
          <button className="primary" disabled={busy}>
            Invite owner
          </button>
        </form>
      )}
      {people.data && people.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <tbody>
              {people.data.map((p) => (
                <tr key={p.id} className={p.active ? '' : 'archived'}>
                  <td>{p.name}</td>
                  <td>{p.email}</td>
                  <td>{p.role === 'owner' ? 'Owner' : 'Staff'}</td>
                  <td>{p.hasPassword ? 'Joined' : 'Not joined yet'}</td>
                  <td>
                    {p.active && (
                      <button disabled={busy} onClick={() => signInLink(p)}>
                        {p.hasPassword ? 'Reset password link' : 'New invite link'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
