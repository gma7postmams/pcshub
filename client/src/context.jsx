import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, put } from './lib/api.js';
import { cachedMode, setMode, setPalette } from './lib/theme.js';

const DEFAULT_BRANDING = { app_name: 'Promotional Content Hub', tagline: '', theme: 'midnight', accent_color: '', themes: [], logo_url: null };

// ---------- Branding (public — used by login too) ----------
const BrandingCtx = createContext({ branding: DEFAULT_BRANDING, reload: () => {} });
export const useBranding = () => useContext(BrandingCtx);

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState(null);
  const reload = useCallback(async () => {
    let b;
    try { b = await get('/api/branding'); } catch (_) { b = DEFAULT_BRANDING; }
    setMode(cachedMode());
    setPalette(b.theme, b.accent_color);
    setBranding(b);
    return b;
  }, []);
  useEffect(() => { reload(); }, [reload]);
  if (!branding) return null;
  return <BrandingCtx.Provider value={{ branding, reload }}>{children}</BrandingCtx.Provider>;
}

// ---------- Signed-in session (role, group, allowed pages/sections/actions) ----------
const SessionCtx = createContext(null);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children, fallback }) {
  const [me, setMe] = useState(null);
  const load = useCallback(async () => {
    const m = await get('/api/auth/me');
    setMode(m.user.appearance || 'system');
    setMe(m);
    return m;
  }, []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  if (!me) return fallback || null;

  const value = {
    ...me,
    reload: load,
    can: (a) => me.actions.includes(a),
    canPage: (p) => me.pages.some((x) => x.path === p),
    hasSection: (k) => me.sections.includes(k),
    setAppearance: async (mode) => {
      setMode(mode);
      setMe((prev) => ({ ...prev, user: { ...prev.user, appearance: mode } }));
      await put('/api/profile/appearance', { mode });
    },
    patchUser: (patch) => setMe((prev) => ({ ...prev, user: { ...prev.user, ...patch } })),
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
