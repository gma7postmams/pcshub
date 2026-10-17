// Wrong-password limits that a stranger cannot use to lock a real person out.
//
// Before: five wrong passwords locked the ACCOUNT for everyone, so anyone who knew a username could keep its owner out forever.
// Now: wrong passwords are counted per account AND per IP address. Reaching the limit shuts THAT ADDRESS out of THAT ACCOUNT for the
// lock time (the "Lock after" / "Lock lasts" settings in Administration > Security); the real person, signing in from their own address,
// is not affected. This only works when the app sees real client addresses (TRUST_PROXY, see .env.example).
//
// Guessing spread over many addresses is not answered with a lock (that would give the attacker the lock-out back): the System Admins
// are alerted instead (security-watch distributed()). Counters live in memory (single Node process) and are lost on restart.
const settings = require('./security-settings');

const MAX_KEYS = 5000;
const DISTRIBUTED_FACTOR = 3;   // this many times the limit...
const DISTRIBUTED_IPS = 4;      // ...from at least this many different addresses = a spread-out attack

const pairs = new Map();   // "user|ip" -> { n, first, until }
const users = new Map();   // user -> [{ ip, t }] wrong passwords inside the window (any address)

const key = (user, ip) => `${String(user).toLowerCase()}|${ip || 'unknown'}`;
const norm = (user) => String(user).toLowerCase();
const windowMs = () => settings.get().lockMinutes * 60 * 1000;

function prune(now) {
  if (pairs.size + users.size < MAX_KEYS) return;
  for (const [k, p] of pairs) if (p.until <= now && now - p.first > windowMs()) pairs.delete(k);
  for (const [u, a] of users) { const keep = a.filter((x) => now - x.t < windowMs()); if (keep.length) users.set(u, keep); else users.delete(u); }
  // still too many (someone is inventing usernames): drop the oldest entries
  for (const k of pairs.keys()) { if (pairs.size + users.size < MAX_KEYS) break; pairs.delete(k); }
}

/** Until when (ms since epoch) is this address shut out of this account? 0 = not. */
function blockedUntil(user, ip, now = Date.now()) {
  const p = pairs.get(key(user, ip));
  return p && p.until > now ? p.until : 0;
}

/** A wrong password for `user` from `ip`. Returns { locked, until, minutes, distributed: { ips, failures } | null }. */
function fail(user, ip, now = Date.now()) {
  prune(now);
  const { lockAfterFailures, lockMinutes } = settings.get();
  const k = key(user, ip);
  let p = pairs.get(k);
  if (!p || (p.until <= now && now - p.first > windowMs())) p = { n: 0, first: now, until: 0 };
  p.n += 1;
  let locked = false;
  if (p.n >= lockAfterFailures) { p.until = now + windowMs(); p.n = 0; p.first = now; locked = true; }
  pairs.set(k, p);

  const u = norm(user);
  const recent = [...(users.get(u) || []).filter((x) => now - x.t < windowMs()), { ip: ip || 'unknown', t: now }];
  users.set(u, recent);
  const ips = new Set(recent.map((x) => x.ip)).size;
  const spread = recent.length >= lockAfterFailures * DISTRIBUTED_FACTOR && ips >= DISTRIBUTED_IPS;
  if (spread) users.set(u, []);   // one alert per run (security-watch also throttles it)
  return { locked, until: locked ? p.until : 0, minutes: lockMinutes, distributed: spread ? { ips, failures: recent.length } : null };
}

/** A correct password: forget this address's wrong ones for this account. */
function clear(user, ip) { pairs.delete(key(user, ip)); }

/** An Admin unlocked the account or reset its password: every address starts fresh. */
function clearUser(user) {
  const u = `${norm(user)}|`;
  for (const k of pairs.keys()) if (k.startsWith(u)) pairs.delete(k);
  users.delete(norm(user));
}

function reset() { pairs.clear(); users.clear(); }

module.exports = { blockedUntil, fail, clear, clearUser, reset, DISTRIBUTED_FACTOR, DISTRIBUTED_IPS };
