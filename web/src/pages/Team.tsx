import { useState, type FormEvent } from 'react';
import { ApiError, api, useLoad, type Person } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorNote, LinkBox, Loading } from '../components';
import { dateText } from '../format';

export function Team() {
  const { canWrite } = useAuth();
  const team = useLoad(() => api.get<Person[]>('/team'), []);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; what: string } | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const invite = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ inviteUrl: string }>('/team', { name, email });
      setLink({ url: r.inviteUrl, what: `Invitation link for ${name}` });
      setName('');
      setEmail('');
      team.reload();
    });
  };

  const newLink = (p: Person) =>
    run(async () => {
      const r = await api.post<{ url: string; kind: string }>(`/team/${p.id}/link`);
      setLink({ url: r.url, what: r.kind === 'invite' ? `Invitation link for ${p.name}` : `Password reset link for ${p.name}` });
    });

  const setActive = (p: Person, active: boolean) =>
    run(async () => {
      await api.patch(`/team/${p.id}`, { active });
      team.reload();
    });

  return (
    <>
      <div className="page-head">
        <h1>Team</h1>
      </div>
      <p className="hint">People you add can record runs and see costs for your business only. Only you, the owner, can manage the team.</p>
      <ErrorNote message={error} />
      {link && <LinkBox url={link.url} what={link.what} />}

      <section className="card">
        {team.loading && <Loading />}
        <ErrorNote message={team.error} />
        {team.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {team.data.map((p) => (
                  <tr key={p.id} className={p.active ? '' : 'archived'}>
                    <td>{p.name}</td>
                    <td>{p.email}</td>
                    <td>{p.role === 'owner' ? 'Owner' : 'Staff'}</td>
                    <td>{!p.active ? <Badge tone="muted">Switched off</Badge> : p.hasPassword ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Not joined yet</Badge>}</td>
                    <td>{p.lastLoginAt ? dateText(p.lastLoginAt) : '–'}</td>
                    <td>
                      <div className="row-actions">
                        {p.active && (
                          <button disabled={busy} onClick={() => newLink(p)}>
                            {p.hasPassword ? 'Reset password link' : 'New invite link'}
                          </button>
                        )}
                        {p.role !== 'owner' && (
                          <button disabled={busy} onClick={() => setActive(p, !p.active)}>
                            {p.active ? 'Switch off' : 'Switch on'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="card" onSubmit={invite}>
        <h2>Add a person</h2>
        <div className="form-grid">
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        {!canWrite && <p className="hint">Adding people is paused until the subscription is active.</p>}
        <button className="primary" disabled={busy || !canWrite}>
          Create invitation link
        </button>
      </form>
    </>
  );
}
