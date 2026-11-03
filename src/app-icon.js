// Home-screen icon sizing, done on the server with Node's own zlib (no extra packages): the stored icon (the built-in one, or the square the browser
// drew from the uploaded logo) is trimmed of its empty margin and the logo re-fitted so it fills the tile, then served at the size asked for.
// That way an icon saved with a wide margin is fixed without uploading the logo again. Anything this cannot read falls back to the original file.
const fs = require('fs');
const zlib = require('zlib');

const PAD = 0.085;    // margin kept around the logo, as a share of the tile (the logo fills 83%; a circular logo stays inside Android's round mask)
const VERSION = 4;    // bump when the look changes: it is part of the icon's address, so phones fetch the new one
const cache = new Map();

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function decode(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8; let w = 0; let h = 0; let depth = 0; let type = 0; let interlace = 0; const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); const name = buf.toString('latin1', pos + 4, pos + 8); const data = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  if (!w || !h || depth !== 8 || interlace !== 0 || (type !== 2 && type !== 6) || w > 4096 || h > 4096) return null;
  const bpp = type === 6 ? 4 : 3; const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) return null;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0; const b = y ? px[dst - stride + x] : 0; const c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) return null;
      px[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}

function encode(w, h, rgb) {
  const stride = w * 3; const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);   // filter 0 on every row
  const chunk = (name, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(name, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The icon at `size` x `size`: logo trimmed of its margin and refitted. Returns a PNG Buffer, or null when the file cannot be processed. */
function render(file, size) {
  try {
    const st = fs.statSync(file); const key = `${file}|${st.mtimeMs}|${size}|${VERSION}`;
    if (cache.has(key)) return cache.get(key);
    const img = decode(fs.readFileSync(file));
    if (!img) return null;
    const { w, h, bpp, px } = img;
    const at = (x, y, c) => px[(y * w + x) * bpp + c];
    const alpha = (x, y) => (bpp === 4 ? at(x, y, 3) : 255);
    // the tile's own colour: the top-left pixel (white for a light logo, near-black for a dark one); transparent pixels count as white
    const bg = alpha(0, 0) < 200 ? [255, 255, 255] : [at(0, 0, 0), at(0, 0, 1), at(0, 0, 2)];
    const col = (x, y, c) => { const a = alpha(x, y) / 255; return Math.round(at(x, y, c) * a + bg[c] * (1 - a)); };
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Math.max(Math.abs(col(x, y, 0) - bg[0]), Math.abs(col(x, y, 1) - bg[1]), Math.abs(col(x, y, 2) - bg[2])) > 28) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
    const box = size * (1 - 2 * PAD); const s = Math.min(box / bw, box / bh);
    const dw = bw * s; const dh = bh * s; const ox = (size - dw) / 2; const oy = (size - dh) / 2;
    const out = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const sx = (x + 0.5 - ox) / s - 0.5 + x0; const sy = (y + 0.5 - oy) / s - 0.5 + y0;
      const o = (y * size + x) * 3;
      if (sx < x0 - 0.5 || sx > x1 + 0.5 || sy < y0 - 0.5 || sy > y1 + 0.5) { out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; continue; }
      // bilinear sample; shrinking by more than 2x averages a block instead so thin lines do not shimmer
      const r = s < 0.5 ? Math.floor(0.5 / s) : 0;
      for (let c = 0; c < 3; c++) {
        let v = 0;
        if (r) { let n = 0; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = Math.min(w - 1, Math.max(0, Math.round(sx) + i)); const yy = Math.min(h - 1, Math.max(0, Math.round(sy) + j)); v += col(xx, yy, c); n++; } v /= n; }
        else {
          const fx = Math.min(w - 1, Math.max(0, sx)); const fy = Math.min(h - 1, Math.max(0, sy)); const ix = Math.floor(fx); const iy = Math.floor(fy); const tx = fx - ix; const ty = fy - iy;
          const ix2 = Math.min(w - 1, ix + 1); const iy2 = Math.min(h - 1, iy + 1);
          v = col(ix, iy, c) * (1 - tx) * (1 - ty) + col(ix2, iy, c) * tx * (1 - ty) + col(ix, iy2, c) * (1 - tx) * ty + col(ix2, iy2, c) * tx * ty;
        }
        out[o + c] = Math.round(v);
      }
    }
    const png = encode(size, size, out);
    cache.set(key, png);
    return png;
  } catch (e) { return null; }
}

module.exports = { render, VERSION };
