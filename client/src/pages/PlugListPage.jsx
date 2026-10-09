import { useSession } from '../context.jsx';
import PlugList from './PlugList.jsx';

// PSD Daily Plug List — its own page, next to the Workload Tracker.
// The Workload Tracker copies Plug ID, PSD and PROG. NAME / PROJ. TITLE
// from this list (see PlugList.jsx for the screen itself).

export default function PlugListPage() {
  const s = useSession();
  const canWorkload = s.can('workload.write');

  return (
    <main className="container wide wl-page">
      <h1 className="sr-only">PSD Daily Plug List</h1>

      <div className="card">
        <PlugList
          canWrite={s.can('plugs.write')}
          canWorkload={canWorkload}
          isAdmin={!!(s.user && s.user.role === 'Admin')}
        />
      </div>
    </main>
  );
}
