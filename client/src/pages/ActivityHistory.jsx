import Audit from './admin/Audit.jsx';

export default function ActivityHistory() {
  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>Activity History</h1>
          <div className="sub">
            Review your account activity, sign-ins, and actions performed within the system.
          </div>
        </div>
      </div>

      <Audit />
    </main>
  );
}