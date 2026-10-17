// Removes GPS location from photos without re-encoding them (the original stays the original):
// - EXIF: the GPS IFD (tag 0x8825) is emptied and its values zeroed — JPEG (APP1), PNG (eXIf), WebP (EXIF chunk), HEIC (Exif item)
// - XMP: exif:GPS… values (attributes or elements) are blanked with spaces
// Every edit keeps the byte length, so no offsets move; PNG chunk CRCs are recomputed.
// stripGps(path) → number of places changed (0 = nothing to remove or not a photo it knows)
import { readFile, writeFile } from 'node:fs/promises';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// TIFF structure starting at `t` (II*\0 or MM\0*), inside buffer b ending at `end`
function scrubTiff(b, t, end) {
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return 0;
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(t + 2) !== 42) return 0;
  const inside = (o, n) => o >= t && o + n <= end;
  const ifd0 = t + u32(t + 4);
  if (!inside(ifd0, 2)) return 0;
  const n0 = u16(ifd0);
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (!inside(e, 12)) return 0;
    if (u16(e) !== 0x8825) continue;
    const gps = t + u32(e + 8);
    if (!inside(gps, 2)) return 0;
    const n = u16(gps);
    if (!n || !inside(gps + 2, n * 12)) return 0;
    for (let j = 0; j < n; j++) {
      const g = gps + 2 + j * 12;
      const size = (TYPE_SIZE[u16(g + 2)] || 1) * u32(g + 4);
      if (size > 4 && inside(t + u32(g + 8), size)) b.fill(0, t + u32(g + 8), t + u32(g + 8) + size);
    }
    b.fill(0, gps + 2, gps + 2 + n * 12); // the entries
    b.fill(0, gps, gps + 2);              // entry count 0: an empty GPS IFD
    return 1;
  }
  return 0;
}

// XMP packet text between [from, to): blank GPS values, same length
function scrubXmp(b, from, to) {
  const s = b.toString('latin1', from, to);
  let n = 0;
  const t = s
    .replace(/(exif:GPS\w+\s*=\s*")([^"]*)(")/g, (m, a, v, z) => { n++; return a + ' '.repeat(v.length) + z; })
    .replace(/(<exif:GPS(\w+)[^>]*>)([\s\S]*?)(<\/exif:GPS\2>)/g, (m, a, k, v, z) => { n++; return a + v.replace(/[^\s<>]/g, ' ') + z; });
  if (n) b.write(t, from, 'latin1');
  return n;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b, from, to) => { let c = 0xffffffff; for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function jpeg(b) {
  let n = 0;
  for (let o = 2; o + 4 <= b.length;) {
    if (b[o] !== 0xff) break;
    const m = b[o + 1];
    if (m === 0xd9 || m === 0xda) break; // end / start of scan: no more metadata
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    const len = b.readUInt16BE(o + 2);
    const seg = o + 4, end = o + 2 + len;
    if (m === 0xe1) {
      if (b.toString('latin1', seg, seg + 6) === 'Exif\0\0') n += scrubTiff(b, seg + 6, end);
      else if (b.toString('latin1', seg, seg + 28) === 'http://ns.adobe.com/xap/1.0/') n += scrubXmp(b, seg, end);
    }
    o = end;
  }
  return n;
}

function png(b) {
  let n = 0;
  for (let o = 8; o + 12 <= b.length;) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8), d = o + 8;
    let c = 0;
    if (type === 'eXIf') c = scrubTiff(b, d, d + len);
    else if (type === 'iTXt' && b.toString('latin1', d, d + 17) === 'XML:com.adobe.xmp') c = scrubXmp(b, d, d + len);
    if (c) { b.writeUInt32BE(crc32(b, o + 4, d + len), d + len); n += c; }
    if (type === 'IEND') break;
    o = d + len + 4;
  }
  return n;
}

function webp(b) {
  let n = 0;
  for (let o = 12; o + 8 <= b.length;) {
    const type = b.toString('latin1', o, o + 4), len = b.readUInt32LE(o + 4), d = o + 8;
    if (type === 'EXIF') n += scrubTiff(b, b.toString('latin1', d, d + 6) === 'Exif\0\0' ? d + 6 : d, d + len);
    else if (type === 'XMP ') n += scrubXmp(b, d, d + len);
    o = d + len + (len & 1);
  }
  return n;
}

// HEIC (and anything else): every "Exif\0\0" followed by a valid TIFF header, and every XMP packet
function generic(b) {
  let n = 0;
  for (let i = b.indexOf('Exif\0\0', 0, 'latin1'); i >= 0; i = b.indexOf('Exif\0\0', i + 6, 'latin1')) n += scrubTiff(b, i + 6, b.length);
  for (let i = b.indexOf('<x:xmpmeta', 0, 'latin1'); i >= 0; i = b.indexOf('<x:xmpmeta', i + 10, 'latin1')) {
    const end = b.indexOf('</x:xmpmeta>', i, 'latin1');
    if (end > i) n += scrubXmp(b, i, end);
  }
  return n;
}

export function stripGpsBuffer(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b.toString('latin1', 1, 4) === 'PNG') return png(b);
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return webp(b);
  if (b.toString('latin1', 4, 8) === 'ftyp') return generic(b);
  return 0;
}

export async function stripGps(path) {
  const b = await readFile(path);
  const n = stripGpsBuffer(b);
  if (n) await writeFile(path, b);
  return n;
}
