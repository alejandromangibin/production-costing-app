import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorNote } from '../components';
import { dateText } from '../format';

const STATUS_TEXT = { trial: 'Free trial', active: 'Subscribed', cancelled: 'Cancelled', suspended: 'Suspended' } as const;

export function Account() {
  const { me } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!me) return null;
  const t = me.tenant;

  async function change(e: FormEvent) {
    e.preventDefault();
    setDone(false);
    if (next !== again) return setError('The two new passwords are not the same.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password', { currentPassword: current, newPassword: next });
      setDone(true);
      setCurrent('');
      setNext('');
      setAgain('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Account</h1>
      </div>

      <section className="card">
        <h2>{me.user.name}</h2>
        <p className="hint">
          {me.user.email} · {me.user.role === 'platform_admin' ? 'Platform admin' : me.user.role === 'owner' ? 'Owner' : 'Staff'}
        </p>
      </section>

      {t && (
        <section className="card">
          <h2>{t.name}</h2>
          <p>
            <Badge tone={t.access.level === 'full' ? 'good' : t.access.level === 'read_only' ? 'warn' : 'bad'}>{STATUS_TEXT[t.status]}</Badge>{' '}
            {t.status === 'trial' && <>Trial ends {dateText(t.trialEndsOn)}.</>}
            {t.status !== 'trial' && t.paidThrough && <>Paid through {dateText(t.paidThrough)}.</>}
          </p>
          {t.access.message && <p>{t.access.message}</p>}
          <p className="hint">To subscribe or renew, pay the person who runs this service and send them the payment reference. Your access updates as soon as they record it.</p>
          {me.user.role === 'owner' && (
            <>
              <h3>Your data is yours</h3>
              <p>Download everything your business has recorded here, any time, even if your subscription has ended.</p>
              <a className="button" href="/api/export" download>
                Download my data
              </a>
            </>
          )}
        </section>
      )}

      <form className="card stack" onSubmit={change}>
        <h2>Change password</h2>
        <div className="form-grid">
          <label>
            Current password <small></small>
            <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label>
            New password <small>at least 10 characters</small>
            <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label>
            New password again <small></small>
            <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
        </div>
        <ErrorNote message={error} />
        {done && <div className="note good">Password changed. Other devices have been signed out.</div>}
        <div>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </>
  );
}
