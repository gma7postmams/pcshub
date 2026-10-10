import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../../lib/api.js';
import { Empty } from '../../components/ui.jsx';
import Overview from './Overview.jsx';
import Users from './Users.jsx';
import Access from './Access.jsx';
import Dropdowns from './Dropdowns.jsx';
import Branding from './Branding.jsx';
import Audit from './Audit.jsx';
import Backup from './Backup.jsx';
import Security from './Security.jsx';

// Roles and Groups live together in Access. Old links (#roles, #groups) still land there.
const TABS = [
  ['overview', 'Overview', Overview], ['users', 'Users', Users], ['access', 'Access', Access],
  ['dropdowns', 'Dropdowns', Dropdowns], ['branding', 'Branding', Branding], ['backup', 'Backup and Restore', Backup],
  ['security', 'Security', Security], ['audit', 'Audit Log', Audit],
];
const ALIAS = { roles: 'access', groups: 'access' };
const fromHash = () => {
  const h = window.location.hash.slice(1);
  const k = ALIAS[h] || h;
  return TABS.some(([t]) => t === k) ? k : 'overview';
};

export default function Admin() {
  const [tab, setTab] = useState(fromHash);
  const [model, setModel] = useState(null);
  const bar = useRef(null);

  const refreshModel = useCallback(() => get('/api/admin/access-model').then(setModel), []);
  useEffect(() => { refreshModel(); }, [refreshModel]);
  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { window.history.replaceState(null, '', `#${tab}`); }, [tab]);
  // On a phone the tab row scrolls sideways; keep the chosen tab in view.
  useEffect(() => {
    const on = bar.current && bar.current.querySelector('button.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [tab]);

  const Tab = (TABS.find(([k]) => k === tab) || TABS[0])[2];
  return (
    <main className="container wide wl-page">
      <h1 className="sr-only">Admin</h1>
      <div className="tabs admin-tabs" id="tabs" ref={bar} role="tablist">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} data-t={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div id="pane">{model ? <Tab model={model} refreshModel={refreshModel} go={setTab} /> : <Empty>Loading…</Empty>}</div>
    </main>
  );
}
