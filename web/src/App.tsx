import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, User, getToken, setToken, clearToken } from './api';
import { applyTheme } from './theme';
import { ImageZoom } from './components/ImageZoom';
import Login from './pages/Login';
import Shell from './pages/Shell';

interface Ctx {
  user: User | null;
  theme: { primary: string; mode: string };
  toast: (msg: string, tone?: 'ok' | 'error') => void;
  logout: () => void;
  refreshTheme: () => void;
}
export const AppCtx = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppCtx);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  // primary 为空 = 跟随 design-tokens.css 的 --accent（不在此硬编码色值）
  const [theme, setTheme] = useState({ primary: '', mode: 'light' });
  const [toastMsg, setToastMsg] = useState('');
  const [toastTone, setToastTone] = useState<'ok' | 'error'>('ok');
  const [ready, setReady] = useState(false);

  // toast 支持语义色调：默认 ok（绿点），tone='error' 显示红点（语义 Token，非硬编码色值）
  const toastTimer = useRef<number | undefined>(undefined);
  const toast = (msg: string, tone: 'ok' | 'error' = 'ok') => {
    setToastMsg(msg);
    setToastTone(tone);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 2400);
  };

  const loadTheme = async () => {
    try {
      const t = await api.get('/api/settings/theme');
      setTheme(t); applyTheme(t.primary, t.mode);
    } catch { applyTheme('', 'light'); }
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
      {toastMsg && <div className={'toast' + (toastTone === 'error' ? ' toast-error' : '')}>{toastMsg}</div>}
      <Login onLogin={(u, t) => { setToken(t); setUser(u); loadTheme(); }} />
    </AppCtx.Provider>
  );

  return (
    <AppCtx.Provider value={{
      user, theme, toast,
      logout: () => { api.post('/api/auth/logout').catch(() => {}); clearToken(); setUser(null); },
      refreshTheme: loadTheme,
    }}>
      {toastMsg && <div className={'toast' + (toastTone === 'error' ? ' toast-error' : '')}>{toastMsg}</div>}
      <ImageZoom />
      <Shell />
    </AppCtx.Provider>
  );
}
