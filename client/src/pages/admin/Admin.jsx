import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../../lib/api.js';
import { Empty } from '../../components/ui.jsx';
import { useSession } from '../../context.jsx';
import Overview from './Overview.jsx';
import Access from './Access.jsx';
import Dropdowns from './Dropdowns.jsx';
import Branding from './Branding.jsx';
import Audit from './Audit.jsx';
import Backup from './Backup.jsx';
import Security from './Security.jsx';
import Maintenance from './Maintenance.jsx';
import IpAccess from './IpAccess.jsx';
import ClearData from './ClearData.jsx';
import NodeTab from './NodeTab.jsx';


const TABS = [
  ['overview', 'Overview', Overview], ['access', 'Access', Access],
  ['dropdowns', 'Dropdowns', Dropdowns], ['branding', 'Branding', Branding], ['backup', 'Backup and Restore', Backup],
  ['security', 'Security', Security], ['ipaccess', 'IP Access', IpAccess], ['maintenance', 'Maintenance', Maintenance], ['node', 'Backup Server', NodeTab], ['cleardata', 'Clear Data', ClearData], ['audit', 'Audit Log', Audit],
];
// Users, Roles and Groups are the Access tab's three parts. Old links (#users, #roles, #groups) still land on the right one.
const ALIAS = { users: 'access/users', roles: 'access/roles', groups: 'access/groups' };
// An Admin (not System Admin) gets only these two tabs; the server enforces the same.
const ADMIN_TABS = ['dropdowns', 'branding', 'audit'];
const fromHash = (tabs = TABS) => {
  const raw = window.location.hash.slice(1);
  const [t, sub = ''] = (ALIAS[raw] || raw).split('/');
  return { tab: tabs.some(([k]) => k === t) ? t : tabs[0][0], sub };
};

export default function Admin() {
  const { user } = useSession();
  const tabs = user.role === 'System Admin' ? TABS : TABS.filter(([k]) => ADMIN_TABS.includes(k));
  const [loc, setLoc] = useState(() => fromHash(tabs));
  const { tab, sub } = loc;
  const setTab = useCallback((t) => { const [k, sb = ''] = (ALIAS[t] || t).split('/'); setLoc({ tab: k, sub: sb }); }, []);
  const setSub = useCallback((sb) => setLoc((l) => ({ ...l, sub: sb })), []);
  const [model, setModel] = useState(null);
  const bar = useRef(null);

  const refreshModel = useCallback(() => get('/api/admin/access-model').then(setModel), []);
  useEffect(() => { refreshModel(); }, [refreshModel]);
  useEffect(() => {
    const onHash = () => setLoc(fromHash(tabs));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { window.history.replaceState(null, '', `#${tab}${sub ? `/${sub}` : ''}`); }, [tab, sub]);
  // On a phone the tab row scrolls sideways; keep the chosen tab in view.
  useEffect(() => {
    const on = bar.current && bar.current.querySelector('button.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [tab]);

  const Tab = (tabs.find(([k]) => k === tab) || tabs[0])[2];
  return (
    <main className="container wide wl-page">
      <h1 className="sr-only">{user.role === 'System Admin' ? 'Administration' : 'Settings'}</h1>
      {/* Same shape as the Ingest and Workload pages: one white card, the tabs along its top edge, the content below. */}
      <div className="card wl-card admin-card">
        <div className="wl-tabbar">
          <div className="tabs admin-tabs" id="tabs" ref={bar} role="tablist">
            {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} data-t={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        </div>
        <div id="pane" className="admin-pane">{model ? <Tab model={model} refreshModel={refreshModel} go={setTab} sub={sub} onSub={setSub} /> : <Empty>Loading…</Empty>}</div>
      </div>
    </main>
  );
}
