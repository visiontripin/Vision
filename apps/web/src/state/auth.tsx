import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, hasToken, IS_LOCAL_MODE, saveToken } from '../api';

type Status = 'loading' | 'anon' | 'authed';

type AuthValue = {
  status: Status;
  busy: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (IS_LOCAL_MODE) {
        // Локальный режим: данные в браузере, пароль не нужен
        if (!cancelled) setStatus('authed');
        return;
      }
      if (!hasToken()) {
        setStatus('anon');
        return;
      }
      try {
        await api.me();
        if (!cancelled) setStatus('authed');
      } catch {
        saveToken(null);
        if (!cancelled) setStatus('anon');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (password: string) => {
    setBusy(true);
    try {
      const result = await api.login(password);
      saveToken(result.token);
      await api.me();
      setStatus('authed');
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = useCallback(() => {
    saveToken(null);
    setStatus(IS_LOCAL_MODE ? 'authed' : 'anon');
  }, []);

  const value = useMemo(() => ({ status, busy, login, logout }), [status, busy, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
