import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, type Me } from './api';

interface AuthState {
  /** undefined while checking, null when signed out. */
  me: Me | null | undefined;
  /** Can this person add and change things right now? */
  canWrite: boolean;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  setMe: (me: Me | null) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [offline, setOffline] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/auth/me'));
      setOffline(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setOffline(e instanceof Error ? e.message : 'Cannot reach the server.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const out = () => setMe(null);
    window.addEventListener('signed-out', out);
    return () => window.removeEventListener('signed-out', out);
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    setMe(await api.post<Me>('/auth/login', { email, password }));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setMe(null);
    }
  }, []);

  if (offline && me === undefined) {
    return (
      <main>
        <div className="note error" role="alert">
          {offline} <button onClick={() => void refresh()}>Try again</button>
        </div>
      </main>
    );
  }

  const canWrite = !!me && (me.user.role === 'platform_admin' || me.tenant?.access.level === 'full');
  return <Ctx.Provider value={{ me, canWrite, refresh, signIn, signOut, setMe }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
