// One colour per person, the same everywhere (presence avatars, dashboard, the cell other people have open). It comes from the user's id, spaced by the
// golden angle round the colour wheel, so two people never share a colour until the wheel is crowded (the old name-hash gave several people the same one of
// seven colours). The lightness alternates a little so neighbouring hues stay apart; white initials stay readable on all of them.
export function colorFor(key) {
  const n = Number(key);
  const seed = Number.isFinite(n) && key !== '' && key != null ? n : [...String(key ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);   // no id: a hash of the name
  const hue = Math.round((seed * 137.508) % 360);
  const light = [44, 50, 38][Math.abs(seed) % 3];
  return `hsl(${hue} 62% ${light}%)`;
}
