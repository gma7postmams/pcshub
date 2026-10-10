const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };

export const BellIcon = () => (
  <svg {...base} strokeWidth="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
);
export const MenuIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
export const CloseIcon = () => <svg {...base} strokeWidth="1.8"><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const PlusIcon = () => <svg {...base} strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>;
export const DownloadIcon = () => <svg {...base} strokeWidth="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" /></svg>;

// ---- Workload Tracker ----
export const CalendarIcon = () => <svg {...base} strokeWidth="1.8"><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></svg>;
export const SearchIcon = () => <svg {...base} strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
export const ChevronDownIcon = () => <svg {...base} strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>;
export const KebabIcon = () => <svg {...base} strokeWidth="2.4"><circle cx="12" cy="5" r=".6" /><circle cx="12" cy="12" r=".6" /><circle cx="12" cy="19" r=".6" /></svg>;
export const PencilIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></svg>;
export const TrashIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></svg>;
export const CopyIcon = () => <svg {...base} strokeWidth="1.8"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
export const FileIcon = () => <svg {...base} strokeWidth="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>;
export const UploadIcon = () => <svg {...base} strokeWidth="1.8"><path d="M12 15V3m0 0l-4 4m4-4l4 4M4 21h16" /></svg>;
export const ColumnIcon = () => <svg {...base} strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M14 4v16M18 9v6" /></svg>;
export const LockIcon = () => <svg {...base} strokeWidth="1.8"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
export const FlagIcon = () => <svg {...base} strokeWidth="1.8"><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></svg>;
export const FilterIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 5h16l-6 8v6l-4-2v-4z" /></svg>;
export const MoreHIcon = () => <svg {...base} strokeWidth="2.6"><circle cx="5" cy="12" r=".7" /><circle cx="12" cy="12" r=".7" /><circle cx="19" cy="12" r=".7" /></svg>;
export const FullscreenIcon = () => <svg {...base} strokeWidth="1.9"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
export const ExitFullscreenIcon = () => <svg {...base} strokeWidth="1.9"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>;
export const SaveIcon = () => <svg {...base} strokeWidth="1.8"><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></svg>;
