import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CloseIcon } from './Icons.jsx';

// ---------- Status pill ----------
const PILL = {
  'New': 's-new', 'Pending Approval': 's-pending', 'Pending': 's-pending', 'Approved': 's-approved', 'Rejected': 's-rejected',
  'DONE': 's-done', 'NON-COMPLIANT': 's-rejected',
  'Not Started': 's-notstarted', 'In Progress': 's-progress', 'On Hold': 's-hold', 'Done': 's-done',
  'Low': 's-low', 'Normal': 's-normal', 'High': 's-high', 'Urgent': 's-urgent',
};
export const Pill = ({ s, children }) => <span className={`pill ${PILL[s] || 's-normal'}`}>{children || s}</span>;

// Admin / Manager / Editor / Viewer / Ingest have their own colours (app.css, .r-<name>); a role created later in Admin → Roles gets a colour of its own
// from this palette, always the same one for the same name, so no role ever shows as a plain, colourless label.
const ROLE_PALETTE = ['#0ea5e9', '#ec4899', '#f59e0b', '#6366f1', '#84cc16', '#14b8a6', '#f97316', '#a855f7'];
const BUILT_IN_ROLES = ['Admin', 'Manager', 'Editor', 'Viewer', 'Ingest'];
export const RoleBadge = ({ role }) => {
  if (BUILT_IN_ROLES.includes(role)) return <span className={`role-badge r-${role}`}>{role}</span>;
  const hue = ROLE_PALETTE[[...String(role)].reduce((a, c) => a + c.charCodeAt(0), 0) % ROLE_PALETTE.length];
  return <span className="role-badge r-custom" style={{ '--rc': hue }}>{role}</span>;
};

export const Empty = ({ children }) => <div className="empty">{children}</div>;

// ---------- KPI tile ----------
export function Kpi({ label, value, foot, color, onClick }) {
  return (
    <div className={`card kpi ${color || ''} ${onClick ? 'link' : ''}`} onClick={onClick || undefined}>
      <div className="k-label">{label}</div>
      <div className="k-value">{value}</div>
      {foot ? <div className="k-foot">{foot}</div> : null}
    </div>
  );
}

// ---------- Select options ----------
export function Options({ list, blank }) {
  return (
    <>
      {blank !== undefined ? <option value="">{blank}</option> : null}
      {list.map((o) => {
        const value = typeof o === 'object' ? o.value : o;
        const label = typeof o === 'object' ? o.label : o;
        return <option key={value} value={value}>{label}</option>;
      })}
    </>
  );
}

// ---------- Toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const toast = useCallback((msg, type = 'ok') => {
    const id = ++seq.current;
    setItems((x) => [...x, { id, msg, type }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), type === 'err' ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div id="toasts">{items.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}

// ---------- Modal ----------
const modalStack = [];
const isTopModal = (id) => modalStack[modalStack.length - 1] === id;

export function Modal({ title, size, onClose, footer, children }) {
  const ref = useRef(null);
  const id = useRef(Symbol('modal'));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const modalId = id.current;
    const previouslyFocused = document.activeElement;
    modalStack.push(modalId);

    const onKey = (e) => {
      if (e.key === 'Escape' && isTopModal(modalId)) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const first = ref.current && ref.current.querySelector('.modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea');
    const focusTimer = first ? setTimeout(() => {
      if (isTopModal(modalId)) first.focus();
    }, 30) : null;

    return () => {
      if (focusTimer !== null) clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);

      const wasTopModal = isTopModal(modalId);
      const index = modalStack.lastIndexOf(modalId);
      if (index !== -1) modalStack.splice(index, 1);

      if (wasTopModal && previouslyFocused && previouslyFocused.isConnected
        && typeof previouslyFocused.focus === 'function' && !previouslyFocused.matches?.(':disabled')
        && !previouslyFocused.closest?.('[inert], [hidden], [aria-hidden="true"]')) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  const close = () => {
    if (isTopModal(id.current)) onCloseRef.current();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={`modal ${size || ''}`} role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="iconbtn" aria-label="Close" onClick={close}><CloseIcon /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

// ---------- Confirm dialog (promise-based) ----------
const ConfirmCtx = createContext(async () => null);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }) {
  const [req, setReq] = useState(null);
  const [value, setValue] = useState('');
  const toast = useToast();
  const confirm = useCallback((title, message, opts = {}) => new Promise((resolve) => {
    setValue('');
    setReq({ title, message, opts, resolve });
  }), []);
  const close = (result) => { if (req) req.resolve(result); setReq(null); };
  const ok = () => {
    const { input } = req.opts;
    if (input && input.required && !value.trim()) { toast(`${input.label} is required`, 'err'); return; }
    close(input ? { value: value.trim() } : true);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req ? (
        <Modal
          title={req.title}
          size="sm"
          onClose={() => close(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
              <button type="button" className={`btn ${req.opts.danger ? 'danger' : 'primary'}`} onClick={ok}>{req.opts.okText || 'Confirm'}</button>
            </>
          )}
        >
          <p className="muted m-0">{req.message}</p>
          {req.opts.input ? (
            <label className="f mt-12">
              <span>{req.opts.input.label}{req.opts.input.required ? <span className="req"> *</span> : null}</span>
              <textarea maxLength={2000} value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
          ) : null}
        </Modal>
      ) : null}
    </ConfirmCtx.Provider>
  );
}

// ---------- Small hooks ----------
/** Controlled form state: const [f, set, setAll] = useForm({...}); <input value={f.x} onChange={set('x')}> */
export function useForm(initial) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => {
    const v = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setF((prev) => ({ ...prev, [k]: v }));
  };
  return [f, set, setF];
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
