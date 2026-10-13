import Audit from './admin/Audit.jsx';
import { useBranding } from '../context.jsx';
import { initials } from '../lib/util.js';

export default function ActivityHistory() {
  const { branding } = useBranding();
  return (
    <main className="container wide wl-page">
      <div className="page-logo">
        {branding.logo_url
          ? <img src={branding.logo_url} alt="" />
          : <span className="mark">{initials(branding.app_name).slice(0, 2) || 'P'}</span>}
        <h1>Activity History</h1>
      </div>

      <Audit />
    </main>
  );
}
