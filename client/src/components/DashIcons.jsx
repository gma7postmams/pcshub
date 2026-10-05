// Icons for the top navigation and the Dashboard (24×24, 1.8 stroke, currentColor) plus the two small illustrations on the greeting banner.
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false };

export const HomeIcon = () => <svg {...base}><path d="M3.5 11 12 3.8l8.5 7.2" /><path d="M5.5 9.8V20h4.7v-5.6h3.6V20h4.7V9.8" /></svg>;
export const CloudIcon = () => <svg {...base}><path d="M7.2 18.5a4.6 4.6 0 0 1-.7-9.15 6 6 0 0 1 11.4 1.4 3.9 3.9 0 0 1-.4 7.75z" /></svg>;
export const ListIcon = () => <svg {...base}><path d="M9.5 6.5h10.5M9.5 12h10.5M9.5 17.5h10.5" /><circle cx="4.9" cy="6.5" r=".9" fill="currentColor" /><circle cx="4.9" cy="12" r=".9" fill="currentColor" /><circle cx="4.9" cy="17.5" r=".9" fill="currentColor" /></svg>;
export const DocIcon = () => <svg {...base}><path d="M7 3h7l4.5 4.5V20.5a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V3.5A.5.5 0 0 1 7 3z" /><path d="M13.8 3.2V8h4.7M9.5 12.5h6M9.5 16h6" /></svg>;
export const CheckCircleIcon = () => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="m8.2 12.4 2.6 2.6 5-5.3" /></svg>;
export const XCircleIcon = () => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>;
export const BarChartIcon = () => <svg {...base}><path d="M6 20.5v-8M12 20.5V4.5M18 20.5v-12" strokeWidth="2.6" /></svg>;
export const BookIcon = () => <svg {...base}><path d="M12 6.2C10.3 4.9 8 4.4 4.5 4.5v13.8c3.5-.1 5.8.4 7.5 1.7 1.7-1.3 4-1.8 7.5-1.7V4.5C16 4.4 13.7 4.9 12 6.2zM12 6.2V20" /></svg>;
export const GearIcon = () => <svg {...base}><circle cx="12" cy="12" r="3.1" /><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9" /><circle cx="12" cy="12" r="6.4" strokeWidth="1.5" /></svg>;
export const CalendarGridIcon = () => <svg {...base}><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /><g fill="currentColor" stroke="none"><circle cx="8.2" cy="13.8" r=".95" /><circle cx="12" cy="13.8" r=".95" /><circle cx="15.8" cy="13.8" r=".95" /><circle cx="8.2" cy="17.2" r=".95" /><circle cx="12" cy="17.2" r=".95" /></g></svg>;
export const CalendarCheckIcon = () => <svg {...base}><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17M9 15l2.2 2.2L15.2 13" /></svg>;
export const ClockIcon = () => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.4 2" /></svg>;
export const FlagIcon = () => <svg {...base}><path d="M6 21V4" /><path d="M6 4.8h11.2l-2.4 3.9 2.4 3.9H6" fill="currentColor" /></svg>;
export const HourglassIcon = () => <svg {...base}><path d="M7 3h10M7 21h10M8 3.2c0 4.6 4 5 4 8.8s-4 4.2-4 8.8M16 3.2c0 4.6-4 5-4 8.8s4 4.2 4 8.8" /></svg>;
export const PulseIcon = () => <svg {...base}><path d="M3 12.5h4l2.6-7 4.6 14 2.6-7H21" /></svg>;
export const UsersIcon = () => <svg {...base}><circle cx="9" cy="8.2" r="3.3" /><path d="M2.8 20c0-3.4 2.8-6 6.2-6s6.2 2.6 6.2 6" /><circle cx="17.2" cy="9.2" r="2.5" /><path d="M16.4 14.2c2.8.3 4.8 2.5 4.8 5.6" /></svg>;
export const ChevronRightIcon = () => <svg {...base} strokeWidth="2.2"><path d="m9.5 6 6 6-6 6" /></svg>;
export const ChevronDownSmall = () => <svg {...base} strokeWidth="2.2"><path d="m6 9.5 6 6 6-6" /></svg>;

/** The sun beside the greeting. */
export const SunArt = () => (
  <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className="dsh-sun">
    <defs><radialGradient id="dshSunCore" cx="40%" cy="36%" r="70%"><stop offset="0" stopColor="#ffd35c" /><stop offset="1" stopColor="#ff9a1f" /></radialGradient></defs>
    <g stroke="#ffb53d" strokeWidth="3.6" strokeLinecap="round">
      <path d="M32 4v7M32 53v7M4 32h7M53 32h7M12.2 12.2l5 5M46.8 46.8l5 5M51.8 12.2l-5 5M17.2 46.8l-5 5" />
    </g>
    <circle cx="32" cy="32" r="14.5" fill="url(#dshSunCore)" />
  </svg>
);

/** The clapperboard illustration on the right of the greeting banner (decorative). */
export const HeroArt = () => (
  <svg viewBox="0 0 360 150" aria-hidden="true" focusable="false" className="dsh-heroart" preserveAspectRatio="xMaxYMid meet">
    <defs>
      <linearGradient id="dshBoard" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4d86ff" /><stop offset="1" stopColor="#6a4df0" /></linearGradient>
      <linearGradient id="dshClap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#1f4ed8" /><stop offset="1" stopColor="#4d3fe0" /></linearGradient>
      <linearGradient id="dshWave" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#ffffff" stopOpacity="0" /><stop offset="1" stopColor="#ffffff" stopOpacity=".55" /></linearGradient>
    </defs>
    <path d="M0 150C40 90 80 70 130 92s90 30 130-20 70-40 100-20v98z" fill="url(#dshWave)" />
    <path d="M60 150C110 112 160 110 210 126s90 8 150-34v58z" fill="#fff" opacity=".28" />
    <g transform="translate(-56 -44) scale(1.25)">
      <g transform="rotate(-9 255 82)">
        <rect x="205" y="64" width="104" height="70" rx="11" fill="url(#dshBoard)" />
        <path d="m238 82 28 17-28 17z" fill="#fff" />
        <g transform="rotate(-11 205 64)">
          <rect x="203" y="40" width="108" height="24" rx="7" fill="url(#dshClap)" />
          <path d="M222 40l-13 24M242 40l-13 24M262 40l-13 24M282 40l-13 24M302 40l-13 24" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
        </g>
      </g>
    </g>
    <g stroke="#7a6ff0" strokeWidth="3" strokeLinecap="round" opacity=".75">
      <path d="M300 14l8-9M312 28l12-4M318 46l9 3" />
    </g>
    <path d="M168 78c-6-10-3-18 4-22" stroke="#5fa8ff" strokeWidth="4" strokeLinecap="round" fill="none" opacity=".8" />
    <circle cx="150" cy="40" r="3" fill="#ffffff" opacity=".8" /><circle cx="344" cy="104" r="2.5" fill="#ffffff" opacity=".8" />
  </svg>
);
