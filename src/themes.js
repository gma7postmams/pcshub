// Theme palettes selectable by Admin (Branding). Colours live in public/css/app.css (html[data-theme]).
const THEMES = [
  { key: 'midnight', label: 'Midnight' },
  { key: 'sunset', label: 'Sunset' },
  { key: 'purple', label: 'Purple' },
  { key: 'ocean', label: 'Ocean' },
  { key: 'forest', label: 'Forest' },
  { key: 'rose', label: 'Rose' },
  { key: 'graphite', label: 'Graphite' },
];
const THEME_KEYS = THEMES.map((t) => t.key);
const MODES = ['system', 'dark', 'light']; // per-user appearance

module.exports = { THEMES, THEME_KEYS, MODES };
