// Theme engine. Palette (data-theme): a user's personal theme if they picked one, else the Admin default. Appearance (data-mode) is per user.
// Colours live in app.css; theme-boot.js applies the cached state in <head> before first paint.
const cache = () => { try { return JSON.parse(localStorage.getItem('phub-theme') || '{}') || {}; } catch (_) { return {}; } };
// name/accent = the Admin default; user = the personal theme (null = follow the Admin default); preview = Admin Branding page live preview
const state = { name: 'graphite', accent: '', mode: 'system', user: cache().user || null, preview: false };
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

export function contrastFor(hex) {
  const ch = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  const white = 1.05 / (L + 0.05);
  const dark = (L + 0.05) / 0.0561;
  return white >= dark ? '#ffffff' : '#0b0e14';
}

function resolvedMode() {
  if (state.mode === 'dark' || state.mode === 'light') return state.mode;
  return mq && mq.matches ? 'light' : 'dark';
}

export function applyTheme() {
  const d = document.documentElement;
  const personal = !state.preview && state.user ? state.user : '';
  const name = personal || state.name;
  d.setAttribute('data-theme', name);
  d.setAttribute('data-mode', resolvedMode());
  // the Admin's custom accent belongs to the Admin theme; a personal theme uses its own accent
  const custom = !personal && /^#[0-9a-f]{6}$/i.test(state.accent || '') ? state.accent : '';
  if (custom) {
    d.style.setProperty('--accent', custom);
    d.style.setProperty('--accent-contrast', contrastFor(custom));
  } else {
    d.style.removeProperty('--accent');
    d.style.removeProperty('--accent-contrast');
  }
  requestAnimationFrame(() => {
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.body).backgroundColor);
  });
  try {
    localStorage.setItem('phub-theme', JSON.stringify({
      theme: name, user: state.user || '', mode: state.mode, accent: custom, contrast: custom ? contrastFor(custom) : '',
    }));
  } catch (_) { /* storage unavailable: theme-boot falls back to defaults */ }
}

export function cachedMode() {
  try { return JSON.parse(localStorage.getItem('phub-theme') || '{}').mode || 'system'; } catch (_) { return 'system'; }
}

export function setPalette(name, accent, preview) {
  state.name = name || 'graphite';
  state.accent = accent || '';
  state.preview = !!preview;
  applyTheme();
}

// the signed-in user's personal theme (null/'' = none, follow the Admin default)
export function setUserTheme(name) {
  state.user = name || null;
  applyTheme();
}

export function isPreview() { return state.preview; }

export function setMode(mode) {
  state.mode = mode || 'system';
  applyTheme();
}

export function getMode() { return state.mode; }

if (mq) {
  const onChange = () => { if (state.mode === 'system') applyTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

// Swatch colours for the Admin theme picker (mirror of the palettes in app.css)
export const THEME_PREVIEW = {
  midnight: { tint: '#4f8cff', dark: '#4f8cff', light: '#2563eb', a2: '#a78bfa' },
  sunset: { tint: '#ff7a45', dark: '#ff7a45', light: '#c2410c', a2: '#ff4f8b' },
  purple: { tint: '#8b5cf6', dark: '#9b6bff', light: '#7c3aed', a2: '#ec4899' },
  ocean: { tint: '#14b8c4', dark: '#22c3d6', light: '#0e7490', a2: '#3b82f6' },
  forest: { tint: '#22c55e', dark: '#34c77b', light: '#15803d', a2: '#a3e635' },
  rose: { tint: '#f43f5e', dark: '#fb6f8f', light: '#e11d48', a2: '#fb923c' },
  graphite: { tint: '#94a3b8', dark: '#cbd5e1', light: '#334155', a2: '#64748b' },
};

export function mix(hex, pct, base) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(hex), p(base)];
  return `rgb(${a.map((v, i) => Math.round(v * pct + b[i] * (1 - pct))).join(',')})`;
}
