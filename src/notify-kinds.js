// The kinds of activity a person can be notified about, and who could ever get each one. People choose, per kind, whether it appears
// in the app's bell and whether it is pushed to their phone (users.notif_prefs: { kind: { bell: false, push: false } }; missing = on).
const { can, effectiveKeys } = require('./permissions');
const isAdminRole = (u) => u.role === 'Admin' || u.role === 'System Admin';

const KINDS = [
  { key: 'plugs_added', label: 'New plugs added', desc: 'Someone adds plugs to the PSD Daily Plug List.', relevant: (u, k) => k.has('plugs') },
  { key: 'workload_vo', label: 'Workload: VO', desc: 'VO is filled in or changed on a workload item that involves your team (VGFX, VEDIT or AUDIO).', relevant: (u, k) => !isAdminRole(u) && [...k].some((x) => /^workload\.(vgfx|vedit|audio)$/i.test(x)) },
  { key: 'workload_script', label: 'Workload: Script', desc: 'Script is filled in or changed on a workload item that involves your team.', relevant: (u, k) => !isAdminRole(u) && [...k].some((x) => /^workload\.(vgfx|vedit|audio)$/i.test(x)) },
  { key: 'workload_art_stb', label: 'Workload: Artwork / STB', desc: 'Artwork / STB is filled in or changed on a workload item that involves your team.', relevant: (u, k) => !isAdminRole(u) && [...k].some((x) => /^workload\.(vgfx|vedit|audio)$/i.test(x)) },
  { key: 'workload_audio_guide', label: 'Workload: Audio Guide', desc: 'Audio Guide is filled in or changed on a workload item that involves your team.', relevant: (u, k) => !isAdminRole(u) && [...k].some((x) => /^workload\.(vgfx|vedit|audio)$/i.test(x)) },
  { key: 'ingest_new', label: 'New ingest requests', desc: 'An ingest request is added or imported and needs approval.', relevant: (u) => can(u, 'ingest.approve') },
  { key: 'ingest_for_approval', label: 'Ingest ready for approval', desc: 'A Destination Folder is filled in, so the request waits for your approval.', relevant: (u) => can(u, 'ingest.approve') },
  { key: 'ingest_approval', label: 'Approval on my ingest requests', desc: 'An ingest request you created or requested is approved, or its approval is withdrawn.', relevant: (u, k) => k.has('ingest') },
  { key: 'ingest_ready_cm', label: 'Ingest ready for CM', desc: 'An ingest request was approved and is waiting for the CM Status.', relevant: (u) => can(u, 'ingest.cm_complete') },
  { key: 'ingest_cm', label: 'CM decision on my ingest requests', desc: 'The CM Status of your ingest request is set (Compliant, Non-compliant) or cleared back to Pending.', relevant: (u, k) => k.has('ingest') },
];
const KEYS = new Set(KINDS.map((k) => k.key));

/** The kinds this user can ever receive (role + group), as [{ key, label, desc }]. */
function relevantKinds(user) {
  const eff = effectiveKeys(user);
  return KINDS.filter((k) => { try { return k.relevant(user, eff); } catch (_) { return false; } }).map(({ key, label, desc }) => ({ key, label, desc }));
}

module.exports = { KINDS, KEYS, relevantKinds };
