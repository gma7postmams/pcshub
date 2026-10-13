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

const CELL_HUES = ['#4f8cff', '#a78bfa', '#34c38f', '#f0883e', '#e5568f', '#26b5ad', '#f1b44c'];
const cellHue = (name) => CELL_HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % CELL_HUES.length];

/**
 * Cells other people have open or selected right now.
 *   topic   'workload' | 'ingest'
 *   curRef  a ref holding my current cell, { key: "<row id>:<column>", kind: 'edit' | 'select' }, or null. The page keeps it up to date on every render.
 * My cell is announced when it changes (checked every 0.4 s) and refreshed every 10 s; it is withdrawn when I leave it.
 * Returns { "<row id>:<column>": { name, uid, kind, hue } } for everybody else's cells; each fades by itself after 25 s without a refresh.
 */
export function useCellPresence(topic, curRef) {
  const [peers, setPeers] = useState({});
  useEffect(() => {
    const off = onLive((m) => {
      if (!m || m.t !== 'cell' || m.topic !== topic || m.by === TAB) return;
      setPeers((cur) => {
        const n = { ...cur };
        Object.keys(n).forEach((k) => { if (n[k].by === m.by) delete n[k]; });   // a person has one cell at a time
        if (m.on) n[m.key] = { name: m.name, uid: m.uid, kind: m.kind, hue: cellHue(m.name), by: m.by, at: Date.now() };
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
    const send = (c, on) => { post('/api/live/focus', { topic, key: c.key, kind: c.kind, on }, { quiet: true }).catch(() => {}); };
    const tick = () => {
      const c = curRef.current || null;
      const same = c && last && c.key === last.key && c.kind === last.kind;
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
