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

// ---- profile pictures ----
/** Where a person's picture is (`v` = the number the server sent; it changes when they upload a new one, so the browser fetches it again). null = no picture. */
export const avatarUrl = (id, v) => (v && id != null ? `/api/profile/avatar/${id}?v=${v}` : null);

/** The picture a person chose, cropped to a centred square and shrunk to 256 x 256 as a JPEG (the server only keeps that). Resolves null if the file is not a readable image. */
export function makeAvatar(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) { resolve(null); return; }
        const c = document.createElement('canvas'); c.width = 256; c.height = 256;
        const x = c.getContext('2d');
        x.fillStyle = '#ffffff'; x.fillRect(0, 0, 256, 256);   // a transparent picture sits on white
        x.imageSmoothingQuality = 'high';
        x.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
        c.toBlob((b) => resolve(b), 'image/jpeg', 0.88);
      } catch (e) { resolve(null); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
