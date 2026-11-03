// The installed-app (PWA) icon, drawn in the browser from an uploaded logo: the empty transparent margin is trimmed, the logo is fitted
// (never stretched) into the middle of a 512 x 512 square with a small margin, on white for the light-mode logo or near-black for the dark-mode one.
// The server keeps the PNG next to the logo and puts it in the app manifest. Returns a PNG Blob, or null if the image can't be read.
const SIZE = 512;
const PAD = 0.07;   // a small safe margin: iPhone draws the icon as is (a wide margin made the logo look tiny); Android's round crop may trim a circular logo's very edge

const load = (file) => new Promise((resolve) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
  img.src = url;
});

export async function makeAppIcon(file, mode) {
  try {
    const img = await load(file);
    if (!img || !img.naturalWidth) return null;
    const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    const sx = src.getContext('2d', { willReadFrequently: true }); sx.drawImage(img, 0, 0, w, h);
    const d = sx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;   // fully transparent
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const out = document.createElement('canvas'); out.width = SIZE; out.height = SIZE;
    const ox = out.getContext('2d');
    ox.fillStyle = mode === 'dark' ? '#0b0e14' : '#ffffff'; ox.fillRect(0, 0, SIZE, SIZE);
    const box = SIZE * (1 - 2 * PAD), s = Math.min(box / bw, box / bh);
    const dw = bw * s, dh = bh * s;
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(src, x0, y0, bw, bh, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
    return await new Promise((r) => out.toBlob((b) => r(b), 'image/png'));
  } catch (e) { return null; }
}
