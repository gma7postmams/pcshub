import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BrandingProvider, SessionProvider, useBranding, useSession } from './context.jsx';
import TopNav from './components/TopNav.jsx';
import { ConfirmProvider, ToastProvider } from './components/ui.jsx';
import Login from './pages/Login.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Ingest = lazy(() => import('./pages/Ingest.jsx'));
const Workload = lazy(() => import('./pages/Workload.jsx'));
const PlugListPage = lazy(() => import('./pages/PlugListPage.jsx'));
const Approval = lazy(() => import('./pages/Approval.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Knowledge = lazy(() => import('./pages/Knowledge.jsx'));
const Admin = lazy(() => import('./pages/admin/Admin.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));

const PAGES = {
  '/dashboard': Dashboard,
  '/ingest': Ingest,
  '/workload': Workload,
  '/plug-list': PlugListPage,
  '/approval': Approval,
  '/reports': Reports,
  '/knowledge': Knowledge,
  '/admin': Admin,
  '/profile': Profile,
};

const Loading = () => <main className="container"><div className="empty">Loading…</div></main>;

function CenterMessage({ code, title, text }) {
  return (
    <div className="center-page">
      <div className="stack">
        <div className="code">{code}</div>
        <h1>{title}</h1>
        <p className="muted">{text}</p>
        <div><a className="btn primary" href="/">Go to my home page</a></div>
      </div>
    </div>
  );
}

/** Client-side mirror of the server lock (the server already refuses locked pages with 403). */
function Guarded({ path }) {
  const s = useSession();
  const { branding } = useBranding();
  const { search } = useLocation();
  const Page = PAGES[path];
  const allowed = s.canPage(path);
  const label = (s.pages.find((p) => p.path === path) || {}).label || 'Access locked';

  useEffect(() => { document.title = `${label} · ${branding.app_name}`; }, [label, branding.app_name]);

  // Same gates the server enforces: forced password change, then required 2FA
  if (path !== '/profile') {
    if (s.user.must_change_password) return <Navigate to="/profile?force=1" replace />;
    if (s.user.totp_required && !s.user.totp_enabled) return <Navigate to="/profile?setup2fa=1" replace />;
  }
  if (!allowed) {
    return <CenterMessage code="403" title="Access locked" text="Your group does not have access to this page. Ask an Admin if you need it." />;
  }
  return <Page key={path + (path === '/admin' ? '' : search)} />;
}

function AppShell() {
  return (
    <SessionProvider fallback={<Loading />}>
      <TopNav />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          {Object.keys(PAGES).map((p) => <Route key={p} path={p} element={<Guarded path={p} />} />)}
          <Route path="*" element={<CenterMessage code="404" title="Page not found" text="The page you are looking for does not exist." />} />
        </Routes>
      </Suspense>
    </SessionProvider>
  );
}

function Landing() {
  const s = useSession();
  return <Navigate to={s.landing || '/profile'} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          <BrandingProvider>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="*" element={<AppShell />} />
            </Routes>
          </BrandingProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
