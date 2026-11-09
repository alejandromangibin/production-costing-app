import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Account } from './pages/Account';
import { Admin } from './pages/Admin';
import { Expiry } from './pages/Expiry';
import { IngredientDetail } from './pages/IngredientDetail';
import { Ingredients } from './pages/Ingredients';
import { Login } from './pages/Login';
import { Margins } from './pages/Margins';
import { NewRun } from './pages/NewRun';
import { Products } from './pages/Products';
import { RunDetailPage } from './pages/RunDetail';
import { Runs } from './pages/Runs';
import { SetPassword } from './pages/SetPassword';
import { Team } from './pages/Team';
import { Loading } from './components';

export function App() {
  const { me, signOut } = useAuth();
  const location = useLocation();

  // Invite and reset links work whether or not someone is signed in.
  if (location.pathname === '/set-password') {
    return <SetPassword />;
  }
  if (me === undefined) {
    return (
      <main>
        <Loading />
      </main>
    );
  }
  if (me === null) return <Login />;

  const isAdmin = me.user.role === 'platform_admin';
  const isOwner = me.user.role === 'owner';
  const access = me.tenant?.access;

  if (access?.level === 'blocked') {
    return (
      <main className="narrow">
        <h1>{me.tenant!.name}</h1>
        <div className="card stack">
          <div className="note error">{access.message ?? 'This account is switched off.'}</div>
          <p>Please contact the person who runs this service.</p>
          <div>
            <button onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
      </main>
    );
  }

  const links = isAdmin
    ? [{ to: '/admin', label: 'Businesses' }]
    : [
        { to: '/new', label: 'New run' },
        { to: '/runs', label: 'History' },
        { to: '/expiry', label: 'Expiry' },
        { to: '/margins', label: 'Margins' },
        { to: '/products', label: 'Products' },
        { to: '/ingredients', label: 'Ingredients' },
        ...(isOwner ? [{ to: '/team', label: 'Team' }] : []),
      ];
  links.push({ to: '/account', label: 'Account' });

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">{me.tenant ? me.tenant.name : 'Production Costing'}</span>
          <nav>
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <span className="topbar-user">
            {me.user.name}
            <button onClick={() => void signOut()}>Sign out</button>
          </span>
        </div>
      </header>
      {access?.message && (
        <div className={`banner ${access.level === 'full' ? 'warn' : 'bad'}`} role="status">
          {access.message}
        </div>
      )}
      <main>
        <Routes>
          <Route path="/" element={<Navigate to={isAdmin ? '/admin' : '/new'} replace />} />
          {isAdmin ? (
            <Route path="/admin" element={<Admin />} />
          ) : (
            <>
              <Route path="/new" element={<NewRun />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:id" element={<RunDetailPage />} />
              <Route path="/expiry" element={<Expiry />} />
              <Route path="/margins" element={<Margins />} />
              <Route path="/products" element={<Products />} />
              <Route path="/ingredients" element={<Ingredients />} />
              <Route path="/ingredients/:id" element={<IngredientDetail />} />
              {isOwner && <Route path="/team" element={<Team />} />}
            </>
          )}
          <Route path="/account" element={<Account />} />
          <Route path="/backup" element={<Navigate to="/account" replace />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
