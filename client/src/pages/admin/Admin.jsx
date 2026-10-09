import { useCallback, useEffect, useState } from 'react';
import { get } from '../../lib/api.js';
import { Empty } from '../../components/ui.jsx';
import Users from './Users.jsx';
import Groups from './Groups.jsx';
import Roles from './Roles.jsx';
import Dropdowns from './Dropdowns.jsx';
import Branding from './Branding.jsx';
import Audit from './Audit.jsx';
import Backup from './Backup.jsx';

const TABS = [
  ['users', 'Users', Users], ['groups', 'Groups', Groups], ['roles', 'Roles', Roles],
  ['dropdowns', 'Dropdowns', Dropdowns], ['branding', 'Branding', Branding], ['backup', 'Backup and Restore', Backup], ['audit', 'Audit Log', Audit],
];
const fromHash = () => {
  const h = window.location.hash.slice(1);
  return TABS.some(([k]) => k === h) ? h : 'users';
};

export default function Admin() {
  const [tab, setTab] = useState(fromHash);
  const [model, setModel] = useState(null);

  const refreshModel = useCallback(() => get('/api/admin/access-model').then(setModel), []);
  useEffect(() => { refreshModel(); }, [refreshModel]);
  useEffect(() => {
    const onHash = () => setTab(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { window.history.replaceState(null, '', `#${tab}`); }, [tab]);

  const Tab = (TABS.find(([k]) => k === tab) || TABS[0])[2];
  return (
    <main className="container wide wl-page">
      <h1 className="sr-only">Admin</h1>
      <div className="tabs" id="tabs">
        {TABS.map(([k, l]) => <button key={k} type="button" data-t={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div id="pane">{model ? <Tab model={model} refreshModel={refreshModel} /> : <Empty>Loading…</Empty>}</div>
    </main>
  );
}

