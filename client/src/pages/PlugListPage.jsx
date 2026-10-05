import { Link } from 'react-router-dom';
import { useSession } from '../context.jsx';
import PlugList from './PlugList.jsx';

// PSD Daily Plug List — its own page, next to the Workload Tracker. The Workload Tracker copies Plug ID, PSD and
// PROG. NAME / PROJ. TITLE from this list (see PlugList.jsx for the screen itself).
export default function PlugListPage() {
  const s = useSession();
  const canWorkload = s.can('workload.write');
  return (
    <main className="container wide wl-page">
      <div className="page-head">
        <div>
          <h1>PSD Daily Plug List</h1>
          <div className="sub">
            The PSD’s daily plug list, one list per day. The <Link to="/workload">Workload Tracker</Link> copies Plug ID, PSD and PROG. NAME / PROJ. TITLE from here.
          </div>
        </div>
      </div>
      <div className="card">
        <PlugList canWrite={s.can('plugs.write')} canWorkload={canWorkload} isAdmin={!!(s.user && s.user.role === 'Admin')} />
      </div>
    </main>
  );
}
