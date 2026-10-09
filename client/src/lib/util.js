const pad = (n) => String(n).padStart(2, '0');

export function fmtDate(d) {
  if (!d) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTimeSec(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}


export function fmtBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(v >= 100 ? 0 : 1) : v} ${units[i]}`;
}

export function ago(d) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(d);
}

export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

export function download(filename, text, type) {
  const blob = new Blob([text], { type: type || 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** Only follow same-origin relative links from server data (notifications). */
export const safeLocalLink = (link) => (typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link : null);

/** '14:30' -> '2:30 PM' */
export function fmtTime(t) {
  const m = /^(\d{2}):(\d{2})/.exec(t || '');
  if (!m) return t || '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** 'YYYY-MM-DDTHH:MM' -> 'Sep 28, 2026 2:45 PM' (12:00 AM is treated as "no time" and shows the date only) */
export function fmtBreakdate(v) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  if (!m) return v || '';
  return m[2] === '00' && m[3] === '00' ? fmtDate(m[1]) : `${fmtDate(m[1])} ${fmtTime(`${m[2]}:${m[3]}`)}`;
}

/** Download a file the server builds (e.g. an Excel export): fetches with the session, then saves it under the name the server chose. */
export async function downloadFile(url, fallbackName = 'export.xlsx') {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'PromoHub' } });
  if (!res.ok) {
    let msg = `Export failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
