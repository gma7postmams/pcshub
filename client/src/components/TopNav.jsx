import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { ago, initials, safeLocalLink } from '../lib/util.js';
import { useBranding, useSession } from '../context.jsx';
import { BellIcon, MenuIcon } from './Icons.jsx';
import { RoleBadge, useToast } from './ui.jsx';
import { BookIcon, CheckCircleIcon, ChevronDownSmall, CloudIcon, DocIcon, GearIcon, HomeIcon, ListIcon } from './DashIcons.jsx';

const NAV_ICON = { '/dashboard': HomeIcon, '/ingest': CloudIcon, '/workload': ListIcon, '/plug-list': DocIcon, '/knowledge': BookIcon, '/admin': GearIcon };

export function BrandMark({ branding }) {
  return (
    <>
      {branding.logo_url
        ? <img src={branding.logo_url} alt="" />
        : <span className="mark">{initials(branding.app_name).slice(0, 2) || 'P'}</span>}
      <span className="name">{branding.app_name}</span>
    </>
  );
}

const MODES = [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']];

export function AppearanceSeg() {
  const s = useSession();
  const toast = useToast();
  const mode = s.user.appearance || 'system';
  return (
    <div className="segmented mode-seg">
      {MODES.map(([k, l]) => (
        <button
          key={k}
          type="button"
          data-appearance={k}
          className={mode === k ? 'on' : ''}
          onClick={(e) => { e.stopPropagation(); s.setAppearance(k).catch((err) => toast(err.message, 'err')); }}
        >{l}</button>
      ))}
    </div>
  );
}

export default function TopNav() {
  const { branding } = useBranding();
  const s = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(null); // 'nav' | 'notif' | 'user' | null
  const [notif, setNotif] = useState({ unread: 0, rows: null });
  const u = s.user;

  const loadNotif = useCallback(async () => {
    try { setNotif(await get('/api/notifications')); } catch (_) { /* ignore */ }
  }, []);

  useEffect(() => {
    loadNotif();
    const t = setInterval(() => { if (!document.hidden) loadNotif(); }, 30000);
    return () => clearInterval(t);
  }, [loadNotif]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const toggle = (which) => (e) => {
    e.stopPropagation();
    setOpen((cur) => (cur === which ? null : which));
    if (which === 'notif') loadNotif();
  };

  const openNotification = async (n) => {
    try { await post(`/api/notifications/${n.id}/read`); } catch (_) { /* ignore */ }
    const link = safeLocalLink(n.link);
    setOpen(null);
    if (link) navigate(link); else loadNotif();
    loadNotif();
  };

  const logout = async () => {
    try { await post('/api/auth/logout'); } catch (_) { /* ignore */ }
    try { localStorage.removeItem('dash:range'); } catch (_) { /* nothing stored */ }   // the Dashboard's period choice does not outlive the sign-in
    window.location.href = '/login';
  };

  return (
    <header className="topnav" id="topnav">
      <button type="button" className="iconbtn menu-toggle" id="nav-toggle" aria-label="Menu" onClick={toggle('nav')}><MenuIcon /></button>
      <a className="brand" href="/"><BrandMark branding={branding} /></a>
      <nav className={`navlinks ${open === 'nav' ? 'open' : ''}`} id="navlinks" onClick={() => setOpen(null)}>
        {s.pages.filter((p) => p.inNav !== false).map((p) => (
          <NavLink key={p.path} to={p.path} className={({ isActive }) => (isActive ? 'active' : '')}>
            {NAV_ICON[p.path] ? <span className="nav-ico">{(() => { const Icon = NAV_ICON[p.path]; return <Icon />; })()}</span> : null}
            <span>{p.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="nav-right">
        <button type="button" className="iconbtn" id="notif-btn" aria-label="Notifications" onClick={toggle('notif')}>
          <BellIcon />
          {notif.unread ? <span className="badge-count" id="notif-count">{notif.unread > 99 ? '99+' : notif.unread}</span> : null}
        </button>
        <button type="button" className="usermenu-btn" id="user-btn" onClick={toggle('user')}>
          <span className="avatar">{initials(u.full_name)}</span>
          <span className="uinfo"><span className="uname">{u.full_name}</span><RoleBadge role={u.role} /></span>
          <span className="uchev"><ChevronDownSmall /></span>
        </button>
      </div>

      {open === 'notif' ? (
        <div className="dropdown" id="notif-dd" onClick={(e) => e.stopPropagation()}>
          <div className="dd-head">
            <strong className="grow">Notifications</strong>
            <button type="button" className="btn sm ghost" onClick={async () => { await post('/api/notifications/read-all'); loadNotif(); }}>Mark all read</button>
          </div>
          <div className="notif-list" id="notif-list">
            {!notif.rows ? <div className="empty">Loading…</div>
              : !notif.rows.length ? <div className="empty">You&apos;re all caught up.</div>
                : notif.rows.map((n) => (
                  <div key={n.id} className={`notif ${n.is_read ? '' : 'unread'}`} onClick={() => openNotification(n)}>
                    <div className="n-title">{n.title}</div>
                    {n.body ? <div className="n-body">{n.body}</div> : null}
                    <div className="n-time">{ago(n.created_at)}</div>
                  </div>
                ))}
          </div>
        </div>
      ) : null}

      {open === 'user' ? (
        <div className="dropdown" id="user-dd" onClick={(e) => e.stopPropagation()}>
          <div className="dd-head">
            <span className="avatar">{initials(u.full_name)}</span>
            <div className="grow"><div><strong>{u.full_name}</strong></div><div className="dim mono">@{u.username}</div></div>
            <RoleBadge role={u.role} />
          </div>
          <div className="dd-mode"><span className="dim">Appearance</span><AppearanceSeg /></div>
          <div className="dd-item dd-static">
            <span className="dim">Group</span>
            {u.group ? <span className="group-chip">{u.group}</span> : <span className="dim">Not enrolled</span>}
          </div>
          <NavLink className="dd-item" to="/profile" onClick={() => setOpen(null)}>Profile &amp; 2FA</NavLink>
          <button type="button" className="dd-item" id="logout-btn" onClick={logout}>Sign out</button>
        </div>
      ) : null}
    </header>
  );
}
