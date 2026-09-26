const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };

export const BellIcon = () => (
  <svg {...base} strokeWidth="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
);
export const MenuIcon = () => <svg {...base} strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
export const CloseIcon = () => <svg {...base} strokeWidth="1.8"><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const PlusIcon = () => <svg {...base} strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>;
export const DownloadIcon = () => <svg {...base} strokeWidth="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" /></svg>;
