import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, put } from './lib/api.js';
import { cachedMode, isPreview, setMode, setPalette, setUserTheme } from './lib/theme.js';
import { applyFavicon } from './lib/favicon.js';

// The server writes the current Branding name into <meta name="app-name"> (src/app-shell.js), so even the fallback shows the right name.
const metaName = () => { try { const m = document.querySelector('meta[name="app-name"]'); return (m && m.content) || ''; } catch (e) { return ''; } };
const DEFAULT_BRANDING = { app_name: metaName() || 'PULSE', tagline: '', theme: 'graphite', accent_color: '', themes: [], logo_url: null, logo_dark_url: null };

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
  // An Admin changing the default theme reaches everyone still on it: re-read it when the tab comes back into view
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible' && !isPreview()) get('/api/branding').then((b) => { setPalette(b.theme, b.accent_color); setBranding((x) => (x && x.theme === b.theme && x.accent_color === b.accent_color ? x : { ...x, theme: b.theme, accent_color: b.accent_color })); }).catch(() => {}); };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again); };
  }, []);
  // the offline page (served by the service worker, no server) reads the name from here
  const appName = branding ? branding.app_name : null;
  useEffect(() => { if (appName) { try { localStorage.setItem('phub-app-name', appName); } catch (e) { /* storage blocked */ } } }, [appName]);
  // the browser-tab icon follows the logo on the Branding page (transparent background); no logo = the built-in icon
  const logoUrl = branding ? (branding.logo_custom ? branding.logo_url : '') : null;   // the built-in logo keeps the built-in favicon
  useEffect(() => { if (logoUrl !== null) applyFavicon(logoUrl); }, [logoUrl]);
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
    setUserTheme(m.user.theme);
    setMe(m);
    return m;
  }, []);
  useEffect(() => { load().catch(() => { setUserTheme(null); }); }, [load]);
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
    setTheme: async (theme) => {
      setUserTheme(theme);
      setMe((prev) => ({ ...prev, user: { ...prev.user, theme: theme || null } }));
      await put('/api/profile/theme', { theme: theme || null });
    },
    patchUser: (patch) => setMe((prev) => ({ ...prev, user: { ...prev.user, ...patch } })),
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
