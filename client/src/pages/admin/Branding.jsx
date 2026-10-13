import { useEffect, useState } from 'react';
import { api, del, get, put } from '../../lib/api.js';
import { mix, setPalette, THEME_PREVIEW } from '../../lib/theme.js';
import { useBranding } from '../../context.jsx';
import { Empty, useToast } from '../../components/ui.jsx';

function Swatch({ themeKey }) {
  const c = THEME_PREVIEW[themeKey] || THEME_PREVIEW.midnight;
  return (
    <div className="sw">
      <span style={{ background: mix(c.tint, 0.08, '#0b0d11') }}><i style={{ background: c.dark }} /><i style={{ background: c.a2 }} /></span>
      <span style={{ background: mix(c.tint, 0.05, '#f5f6f8'), border: '1px solid #e1e4ea' }}><i style={{ background: c.light }} /><i style={{ background: c.a2 }} /></span>
    </div>
  );
}

function LogoSlot({ mode, label, url, set, onUpload, onRemove }) {
  const [file, setFile] = useState(null);
  const [key, setKey] = useState(0);
  return (
    <form className="stack" id={`lf-${mode}`} onSubmit={async (e) => { e.preventDefault(); if (await onUpload(mode, file)) { setFile(null); setKey((k) => k + 1); } }}>
      <div className="dim">{label}</div>
      <div><img className="logo-preview" src={url} alt={label} style={{ background: mode === 'dark' ? '#0b0e14' : '#ffffff' }} />{set ? null : <div className="dim mt-8">Not uploaded.</div>}</div>
      <input key={key} type="file" name="logo" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files[0] || null)} />
      <div className="row">
        <button className="btn primary">Upload</button>
        {set ? <button type="button" className="btn danger" id={`rmlogo-${mode}`} onClick={() => onRemove(mode)}>Remove</button> : null}
      </div>
    </form>
  );
}

export default function Branding() {
  const toast = useToast();
  const { reload } = useBranding();
  const [b, setB] = useState(null);
  const [f, setF] = useState(null);

  const load = async () => {
    const x = await get('/api/branding');
    setB(x);
    setF({ app_name: x.app_name, tagline: x.tagline || '', theme: x.theme, custom: !!x.accent_color, accent: x.accent_color || '#4f8cff' });
  };
  useEffect(() => { load(); }, []);
  // Live preview while editing; restore saved branding when leaving the tab
  useEffect(() => { if (f) setPalette(f.theme, f.custom ? f.accent : ''); }, [f]);
  useEffect(() => () => { reload(); }, [reload]);

  if (!b || !f) return <Empty>Loading…</Empty>;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    try {
      await put('/api/admin/branding', { app_name: f.app_name, tagline: f.tagline, theme: f.theme, accent_color: f.custom ? f.accent : '' });
      toast('Branding & theme saved');
      await reload();
      await load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const upload = async (mode, file) => {
    if (!file) { toast('Choose a file first', 'err'); return false; }
    const fd = new FormData();
    fd.append('logo', file);
    try { await api('POST', `/api/admin/branding/logo?mode=${mode}`, fd); toast(`${mode === 'dark' ? 'Dark mode' : 'Light mode'} logo uploaded`); await reload(); await load(); return true; } catch (ex) { toast(ex.message, 'err'); return false; }
  };
  const removeLogo = async (mode) => {
    try { await del(`/api/admin/branding/logo?mode=${mode}`); toast(`${mode === 'dark' ? 'Dark mode' : 'Light mode'} logo removed`); await reload(); await load(); } catch (ex) { toast(ex.message, 'err'); }
  };

  return (
    <>
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>Identity</h2></div>
          <form className="card-pad stack" id="bf" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className="f"><span>App name</span><input name="app_name" maxLength={80} value={f.app_name} onChange={(e) => set('app_name', e.target.value)} /></label>
            <label className="f"><span>Tagline (login page)</span><input name="tagline" maxLength={120} value={f.tagline} onChange={(e) => set('tagline', e.target.value)} /></label>
          </form>
        </div>
        <div className="card">
          <div className="card-head"><h2>Logo</h2></div>
          <div className="card-pad stack">
            <LogoSlot mode="light" label="Light mode logo" url={b.logo_url} set={b.logo_light_set} onUpload={upload} onRemove={removeLogo} />
            <LogoSlot mode="dark" label="Dark mode logo" url={b.logo_dark_url} set={b.logo_dark_set} onUpload={upload} onRemove={removeLogo} />
            <div className="dim">{b.logo_custom ? 'Upload one logo and it is used in both modes; upload both and each mode uses its own.' : 'Using the default PULSE logo (black lettering in light mode, white in dark mode).'} PNG, JPEG or WebP · max 2 MB · transparent PNG works best.</div>
          </div>
        </div>
      </div>

      <div className="card mt-16">
        <div className="card-head"><h2 title="Applies to everyone. Each user picks Dark / Light / System in their Profile.">Theme</h2></div>
        <div className="card-pad stack">
          <div className="theme-grid" id="tg">
            {b.themes.map((t) => (
              <button type="button" key={t.key} className={`theme-card ${f.theme === t.key ? 'on' : ''}`} data-theme-key={t.key} onClick={() => set('theme', t.key)}>
                <Swatch themeKey={t.key} />
                <div className="nm">{t.label}</div>
              </button>
            ))}
          </div>
          <div className="row gap-16">
            <label className="check"><input type="checkbox" id="cust" checked={f.custom} onChange={(e) => set('custom', e.target.checked)} /> Custom accent colour</label>
            <input type="color" id="bc" value={f.accent} disabled={!f.custom} onChange={(e) => set('accent', e.target.value)} />
            
            <input
              id="bh"
              maxLength={7}
              className="mono w-auto"
              value={f.accent}
              disabled={!f.custom}
              onChange={(e) => {
                set('accent', e.target.value);
              }}
            />
                            
            <span className="dim">Overrides the theme accent in both modes. Button text colour is picked automatically for contrast.</span>
          </div>
          <div className="row">
            <button type="button" className="btn primary" id="save-theme" onClick={save}>Save branding &amp; theme</button>

            <button
              type="button"
              className="btn ghost"
              id="reset-prev"
              onClick={async () => {
                await load();
                toast('Preview reset');
              }}
            >
              Reset preview
            </button>

          </div>
        </div>
      </div>
    </>
  );
}
