import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, User, getToken, setToken, clearToken } from './api';
import Login from './pages/Login';
import Shell from './pages/Shell';

interface Ctx {
  user: User | null;
  theme: { primary: string; mode: string };
  toast: (msg: string) => void;
  logout: () => void;
  refreshTheme: () => void;
}
export const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

function applyTheme(primary: string, mode: string) {
  document.documentElement.style.setProperty('--primary', primary);
  document.documentElement.dataset.mode = mode;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [theme, setTheme] = useState({ primary: '#4f7cff', mode: 'light' });
  const [toastMsg, setToastMsg] = useState('');
  const [ready, setReady] = useState(false);

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 2400);
  };

  const loadTheme = async () => {
    try {
      const t = await api.get('/api/settings/theme');
      setTheme(t); applyTheme(t.primary, t.mode);
    } catch { applyTheme('#4f7cff', 'light'); }
  };

  useEffect(() => {
    (async () => {
      if (getToken()) {
        try { setUser(await api.get('/api/me')); await loadTheme(); } catch { clearToken(); }
      }
      setReady(true);
    })();
  }, []);

  if (!ready) return null;

  if (!user) return (
    <AppCtx.Provider value={{ user, theme, toast, logout: () => {}, refreshTheme: loadTheme }}>
      {toastMsg && <div className="toast">{toastMsg}</div>}
      <Login onLogin={(u, t) => { setToken(t); setUser(u); loadTheme(); }} />
    </AppCtx.Provider>
  );

  return (
    <AppCtx.Provider value={{
      user, theme, toast,
      logout: () => { api.post('/api/auth/logout').catch(() => {}); clearToken(); setUser(null); },
      refreshTheme: loadTheme,
    }}>
      {toastMsg && <div className="toast">{toastMsg}</div>}
      <Shell />
    </AppCtx.Provider>
  );
}
