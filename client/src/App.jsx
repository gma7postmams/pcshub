import { lazy, Suspense, useEffect, useRef } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BrandingProvider, SessionProvider, useBranding, useSession } from './context.jsx';
import TopNav from './components/TopNav.jsx';
import { ConfirmProvider, ToastProvider } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import { post } from './lib/api.js';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Ingest = lazy(() => import('./pages/Ingest.jsx'));
const Workload = lazy(() => import('./pages/Workload.jsx'));
const PlugListPage = lazy(() => import('./pages/PlugListPage.jsx'));
const Approval = lazy(() => import('./pages/Approval.jsx'));
const Knowledge = lazy(() => import('./pages/Knowledge.jsx'));
const Admin = lazy(() => import('./pages/admin/Admin.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));

const ActivityHistory = lazy(() => import('./pages/ActivityHistory.jsx'));

const PAGES = {
  '/dashboard': Dashboard,
  '/ingest': Ingest,
  '/workload': Workload,
  '/plug-list': PlugListPage,
  '/approval': Approval,
  '/activity-history': ActivityHistory,
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

/** Tells the server this person is working (about once a minute, and when they change page) so the Dashboard can show who is active.
    Only counts real use — mouse, keys, touch or scroll in the last two minutes, with the tab visible — so an idle open tab is not "active". */
function Presence() {
  const { pathname } = useLocation();
  const sess = useSession();
  // someone who still has to change their password or set up 2FA isn't "using the app" yet — and the server only lets them reach Profile
  const gated = !!(sess.user.must_change_password || (sess.user.totp_required && !sess.user.totp_enabled));
  const gatedRef = useRef(gated);
  gatedRef.current = gated;
  const lastInput = useRef(Date.now());
  const path = useRef(pathname);
  const beat = useRef(null);
  path.current = pathname;
  beat.current = () => {
    if (gatedRef.current || document.visibilityState !== 'visible' || Date.now() - lastInput.current > 120000) return;
    post('/api/presence', { path: path.current }, { quiet: true }).catch(() => { /* presence is best-effort */ });
  };
  useEffect(() => {
    const mark = () => { lastInput.current = Date.now(); };
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'wheel', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const onVisible = () => { if (document.visibilityState === 'visible') { mark(); beat.current(); } };
    document.addEventListener('visibilitychange', onVisible);
    // The tab or browser is closing: say so, so this person leaves the Active users list at once. `keepalive` lets the request finish while
    // the page unloads (and, unlike sendBeacon, can carry the CSRF header). Best-effort: a crash or power cut falls back to the heartbeat window.
    const onLeave = () => {
      if (gatedRef.current) return;
      try { fetch('/api/presence/leave', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'X-Requested-With': 'PromoHub', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}); } catch (e) { /* closing anyway */ }
    };
    window.addEventListener('pagehide', onLeave);
    const timer = setInterval(() => beat.current(), 60000);
    return () => { events.forEach((e) => window.removeEventListener(e, mark)); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pagehide', onLeave); clearInterval(timer); };
  }, []);
  useEffect(() => { lastInput.current = Date.now(); beat.current(); }, [pathname]);   // opening a page counts as using the app
  return null;
}

function AppShell() {
  return (
    <SessionProvider fallback={<Loading />}>
      <TopNav />
      <Presence />
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
