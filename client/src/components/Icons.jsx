const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };

export const BellIcon = () => (
  <svg {...base} strokeWidth="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
);
export const MenuIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
export const CloseIcon = () => <svg {...base} strokeWidth="1.8"><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const PlusIcon = () => <svg {...base} strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>;
export const DownloadIcon = () => <svg {...base} strokeWidth="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" /></svg>;

// ---- Workload Tracker ----
export const DocIcon = () => <svg {...base} strokeWidth="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
export const CalendarIcon = () => <svg {...base} strokeWidth="1.8"><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></svg>;
export const LayersIcon = () => <svg {...base} strokeWidth="1.8"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 12.5l9 5 9-5M3 17l9 5 9-5" /></svg>;
export const FilmIcon = () => <svg {...base} strokeWidth="1.8"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4" /></svg>;
export const SpeakerIcon = () => <svg {...base} strokeWidth="1.8"><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>;
export const ClockIcon = () => <svg {...base} strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
export const SearchIcon = () => <svg {...base} strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
export const ChevronDownIcon = () => <svg {...base} strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>;
export const KebabIcon = () => <svg {...base} strokeWidth="2.4"><circle cx="12" cy="5" r=".6" /><circle cx="12" cy="12" r=".6" /><circle cx="12" cy="19" r=".6" /></svg>;
export const PaperclipIcon = () => <svg {...base} strokeWidth="1.8"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2L9.9 17.5a1.8 1.8 0 0 1-2.6-2.6L15 7.2" /></svg>;
export const PencilIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></svg>;
export const TrashIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></svg>;
