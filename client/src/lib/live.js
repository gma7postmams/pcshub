import { colorFor } from './avatar.js';
import { useEffect, useRef, useState } from 'react';
import { post } from './api.js';

// Live updates: when somebody else saves on the Ingest Tracker, Workload Tracker or PSD Daily Plug List, the server pushes "that list changed"
// (src/live.js) and the open page quietly re-reads it. The push carries no data, only the topic.
//
// Browsers allow only ~6 open connections per site (shared by every tab), and each tracker page already holds one for the "who is here" avatars.
// So all tabs of this app share ONE live connection: the tab that gets the Web Lock owns the EventSource and relays what it hears to the other
// tabs over a BroadcastChannel. When that tab closes the lock passes to another tab, which connects.

/** This tab's id. api.js sends it as X-Tab, so the server can say who made a change and a tab can skip the echo of its own save. */
export const TAB = Math.random().toString(36).slice(2, 12);

const subs = new Set();
let lastHeard = Date.now();
let started = false;

function deliver(m) {
  if (m && m.t) lastHeard = Date.now();
  subs.forEach((fn) => { try { fn(m); } catch (e) { /* one listener must not stop the rest */ } });
}

function start() {
  if (started || typeof EventSource === 'undefined') return;
  started = true;
  let bc = null;
  try { bc = new BroadcastChannel('pcshub-live'); bc.onmessage = (e) => deliver(e.data); } catch (e) { bc = null; }
  const relay = (m) => { deliver(m); if (bc) { try { bc.postMessage(m); } catch (e) { /* closing */ } } };
  const connect = () => {
    let first = true;
    const es = new EventSource('/api/live/stream');
    es.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } relay(m); };
    es.onopen = () => { if (!first) relay({ t: 'reconnect' }); first = false; };   // after a drop, changes may have been missed: every list re-reads
  };
  if (bc && navigator.locks && navigator.locks.request) navigator.locks.request('pcshub-live-stream', () => new Promise(() => connect()));   // never resolves: held until this tab closes
  else connect();
}

/**
 * Re-read a list when somebody else changes it.
 *   topics   'ingest' | 'workload' | 'plugs'
 *   refresh  function that re-reads the list quietly (keep the person's selection, no spinner)
 *   busy     function; true while the person is in the middle of something (a cell open for editing, a form, unsaved rows). The refresh waits
 *            until it turns false, so nothing is ever overwritten under their hands.
 * Falls back to a re-read every 30 seconds while the live connection is silent (no message or keep-alive for 50 s), and on returning to the tab.
 */
export function useLive(topics, refresh, busy) {
  const ref = useRef({});
  ref.current = { refresh, busy };
  const key = topics.join(',');
  useEffect(() => {
    start();
    const mine = key.split(',');
    let pending = false;
    let timer = null;
    let dead = false;
    const run = () => {
      if (dead || !pending || document.hidden) return;   // hidden: wait for the person to come back (onVis)
      if (ref.current.busy && ref.current.busy()) { timer = setTimeout(run, 1000); return; }
      pending = false;
      Promise.resolve(ref.current.refresh && ref.current.refresh()).catch(() => {});
    };
    const want = () => { pending = true; clearTimeout(timer); timer = setTimeout(run, 300); };   // a burst of changes becomes one re-read
    const onMsg = (m) => {
      if (!m) return;
      if (m.t === 'reconnect') { want(); return; }
      if (!mine.includes(m.t)) return;
      if (m.by && m.by === TAB) return;   // my own save: the page already shows it
      want();
    };
    subs.add(onMsg);
    const onVis = () => {
      if (document.hidden) return;
      if (pending || Date.now() - lastHeard > 50000) want();
    };
    document.addEventListener('visibilitychange', onVis);
    const poll = setInterval(() => { if (!document.hidden && Date.now() - lastHeard > 50000) want(); }, 30000);
    return () => { dead = true; subs.delete(onMsg); clearTimeout(timer); clearInterval(poll); document.removeEventListener('visibilitychange', onVis); };
  }, [key]);
}

/** Listen to every live message (the bell uses this for { t: 'notif' }). Returns an unsubscribe function. */
export function onLive(fn) {
  start();
  subs.add(fn);
  return () => subs.delete(fn);
}


/**
 * Cells other people have open or selected right now.
 *   topic   'workload' | 'ingest'
 *   curRef  a ref holding my current cell(s), { cells: ["<row id>:<column>|<outer edges>", ...], kind: 'edit' | 'select' }, or null (see rangeCells). The page keeps it up to date on every render.
 * My cell is announced when it changes (checked every 0.4 s) and refreshed every 10 s; it is withdrawn when I leave it.
 * Returns { "<row id>:<column>": { name, uid, kind, hue } } for everybody else's cells; each fades by itself after 25 s without a refresh.
 */
// What is typed in the cell editor that has the focus right now (text boxes, number / date boxes, drop-downs), or null when there is none. The editors of all
// three trackers are plain boxes inside a td.editing / .cell-editor, so one listener on the page covers every table and tab.
let typing = null;
const EDITOR = '.editing, .cell-editor, .cell-editor-inline';
function readBox(el) {
  if (!el || !el.matches || !el.matches('input, textarea, select') || !el.closest || !el.closest(EDITOR)) return;
  if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') return;
  typing = { el, text: el.tagName === 'SELECT' ? (el.value === '' ? '' : ((el.options[el.selectedIndex] || {}).text || '')) : String(el.value || '') };
}
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => readBox(e.target), true);
  document.addEventListener('input', (e) => readBox(e.target), true);
  document.addEventListener('change', (e) => readBox(e.target), true);
}
function typedText() {
  if (!typing || !typing.el.isConnected || !typing.el.closest(EDITOR)) return null;
  if (typing.el.tagName !== 'SELECT') typing.text = String(typing.el.value || '');
  return typing.text;
}
export function useCellPresence(topic, curRef) {
  const [peers, setPeers] = useState({});
  useEffect(() => {
    const off = onLive((m) => {
      if (!m || m.t !== 'cell' || m.topic !== topic || m.by === TAB) return;
      setPeers((cur) => {
        const n = { ...cur };
        Object.keys(n).forEach((k) => { if (n[k].by === m.by) delete n[k]; });   // a person has one cell at a time
        if (m.on) (m.cells || [m.key]).forEach((c, i) => { const [key, edges = 'tblr'] = String(c).split('|'); n[key] = { name: m.name, uid: m.uid, kind: m.kind, text: m.text == null ? null : String(m.text), hue: colorFor(m.uid ?? m.name), by: m.by, at: Date.now(), edges, first: i === 0 }; });
        return n;
      });
    });
    const sweep = setInterval(() => setPeers((cur) => {
      const keys = Object.keys(cur).filter((k) => Date.now() - cur[k].at > 25000);
      if (!keys.length) return cur;
      const n = { ...cur }; keys.forEach((k) => delete n[k]); return n;
    }), 5000);
    return () => { off(); clearInterval(sweep); };
  }, [topic]);
  useEffect(() => {
    let last = null; let lastSent = 0;
    const send = (c, on) => { post('/api/live/focus', { topic, cells: c.cells, kind: c.kind, text: c.text, on }, { quiet: true }).catch(() => {}); };
    const sig = (c) => (c ? `${c.kind}|${c.cells.length}|${c.cells[0]}|${c.cells[c.cells.length - 1]}|${c.text == null ? '' : `t${c.text}`}` : '');
    const tick = () => {
      const c0 = curRef.current || null;
      const c = c0 && c0.kind === 'edit' ? { ...c0, text: typedText() } : c0;   // an open editor also shares what is typed in it, as it is typed
      const same = c && last && sig(c) === sig(last);
      if (same) { if (Date.now() - lastSent > 10000) { send(c, true); lastSent = Date.now(); } return; }
      if (last && !c) send(last, false);
      if (c) { send(c, true); lastSent = Date.now(); }
      last = c;
    };
    const t = setInterval(tick, 400);
    return () => { clearInterval(t); if (last) send(last, false); };
  }, [topic, curRef]);
  return peers;
}

/** The cells of a picked block as announced to the others: rows[r0..r1] x cols[c0..c1], each "<row id>:<column>|<outer edges>" so only the block's outline is drawn. */
export function rangeCells(rows, cols, r0, r1, c0, c1) {
  const out = [];
  for (let r = r0; r <= r1 && out.length < 800; r++) {
    const row = rows[r]; if (!row) continue;
    for (let c = c0; c <= c1 && out.length < 800; c++) {
      if (!cols[c]) continue;
      out.push(`${row.id}:${cols[c]}|${r === r0 ? 't' : ''}${r === r1 ? 'b' : ''}${c === c0 ? 'l' : ''}${c === c1 ? 'r' : ''}`);
    }
  }
  return out;
}

/** Inline style for a lit cell: the person's colour, and only the outer edges of their block get the line. */
export function peerStyle(p) {
  const e = p.edges == null ? 'tblr' : p.edges;
  return { '--peer': p.hue, '--pt': e.includes('t') ? '2px' : '0px', '--pb': e.includes('b') ? '2px' : '0px', '--pl': e.includes('l') ? '2px' : '0px', '--pr': e.includes('r') ? '2px' : '0px' };
}
