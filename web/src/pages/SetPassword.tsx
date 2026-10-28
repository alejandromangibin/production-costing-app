import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, useLoad } from '../api';
import { useAuth } from '../auth';
import { ErrorNote, Loading } from '../components';

interface TokenInfo {
  kind: 'invite' | 'reset';
  email: string;
  name: string;
  businessName: string | null;
}

/** The page behind an invite or password-reset link: choose a password, then you are signed in. */
export function SetPassword() {
  const token = useSearchParams()[0].get('token') ?? '';
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const info = useLoad(() => api.get<TokenInfo>(`/auth/token-info?token=${encodeURIComponent(token)}`), [token]);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setError('The two passwords are not the same.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/accept', { token, password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the password.');
      setBusy(false);
    }
  }

  return (
    <main className="narrow">
      <h1>Production Costing</h1>
      {info.loading && <Loading />}
      {info.error && (
        <div className="card">
          <ErrorNote message={info.error} />
          <p>
            <a href="/">Go to sign in</a>
          </p>
        </div>
      )}
      {info.data && (
        <form className="card stack" onSubmit={submit}>
          <h2>{info.data.kind === 'invite' ? 'Welcome' : 'Choose a new password'}, {info.data.name}</h2>
          <p className="hint">
            {info.data.businessName ? `${info.data.businessName} · ` : ''}
            {info.data.email}
          </p>
          <label>
            New password <small>at least 10 characters; a few random words is fine</small>
            <input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            Type it again
            <input type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
          <ErrorNote message={error} />
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save password and continue'}
          </button>
        </form>
      )}
    </main>
  );
}
