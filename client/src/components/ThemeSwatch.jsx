import { mix, THEME_PREVIEW } from '../lib/theme.js';

export function Swatch({ themeKey }) {
  const c = THEME_PREVIEW[themeKey] || THEME_PREVIEW.graphite;
  return (
    <div className="sw">
      <span style={{ background: mix(c.tint, 0.08, '#0b0d11') }}><i style={{ background: c.dark }} /><i style={{ background: c.a2 }} /></span>
      <span style={{ background: mix(c.tint, 0.05, '#f5f6f8'), border: '1px solid #e1e4ea' }}><i style={{ background: c.light }} /><i style={{ background: c.a2 }} /></span>
    </div>
  );
}
