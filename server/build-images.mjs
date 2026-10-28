// npm run build:images — page-sized copies of the brand images in assets/img (the originals in brand_assets/ are
// 1254px PNGs of 0.5–1.8 MB; pages show the logo at about 44px and Hawky at up to about 380px).
//   logo-96.webp, logo-192.webp   header and footer logo (1× / 2×+ screens)
//   icon-32.png, icon-180.png     browser tab (the circle only, transparent) and home-screen icons
//   hawky-480.webp, hawky-640.webp, hawky-960.webp
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'brand_assets');
const OUT = join(ROOT, 'assets', 'img');
mkdirSync(OUT, { recursive: true });
/** @type {[string, string, number, (s: import('sharp').Sharp) => import('sharp').Sharp][]} */
const jobs = [
  ['Logo-CCD.png', 'logo-96.webp', 96, (s) => s.webp({ quality: 86 })],
  ['Logo-CCD.png', 'logo-192.webp', 192, (s) => s.webp({ quality: 86 })],
  ['Logo-CCD.png', 'icon-180.png', 180, (s) => s.png({ compressionLevel: 9, palette: true })],
  ['Hawky-bgTran.png', 'hawky-480.webp', 480, (s) => s.webp({ quality: 82, alphaQuality: 90 })],
  ['Hawky-bgTran.png', 'hawky-640.webp', 640, (s) => s.webp({ quality: 80, alphaQuality: 90 })],
  ['Hawky-bgTran.png', 'hawky-960.webp', 960, (s) => s.webp({ quality: 80, alphaQuality: 90 })],
];
for (const [src, out, w, enc] of jobs) {
  const info = await enc(sharp(join(SRC, src)).resize(w, w, { fit: 'inside' })).toFile(join(OUT, out));
  console.log(`${out.padEnd(16)} ${info.width}x${info.height} ${Math.round(info.size / 1024)} KB`);
}

// icon-32.png: the browser tab icon is the logo's purple circle alone on a transparent background (no near-white square
// around it). The circle sits off-centre in Logo-CCD.png, so find it: the box of everything that is not the background.
{
  const { data, info } = await sharp(join(SRC, 'Logo-CCD.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [br, bg, bb] = data; // the top-left pixel is background
  let x0 = info.width, y0 = info.height, x1 = 0, y1 = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3;
    if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 40) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const size = Math.max(x1 - x0, y1 - y0) + 1;
  // The mask sits 1% inside the circle's edge, so no light anti-aliased rim shows against a dark tab bar
  const r = size / 2;
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r * 0.99}"/></svg>`);
  const disc = await sharp(join(SRC, 'Logo-CCD.png')).extract({ left: x0, top: y0, width: size, height: size }).ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const info32 = await sharp(disc).resize(32, 32).png({ compressionLevel: 9 }).toFile(join(OUT, 'icon-32.png'));
  console.log(`${'icon-32.png'.padEnd(16)} 32x32 ${Math.round(info32.size / 1024)} KB (circle ${size}px at ${x0},${y0}, transparent)`);
}

// og-default.jpg 1200×630: the picture shown when a page without its own photo is shared (Facebook, LINE)
const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2642C8"/><stop offset=".6" stop-color="#7A3CE2"/><stop offset="1" stop-color="#D11327"/></linearGradient>
  <radialGradient id="r" cx=".8" cy=".2" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/><rect width="1200" height="630" fill="url(#r)"/></svg>`);
// The logo as the site shows it (.logo-crop): zoomed 1.42× and cut to a circle
const circle = Buffer.from('<svg width="300" height="300"><circle cx="150" cy="150" r="150"/></svg>');
const logo = await sharp(await sharp(join(SRC, 'Logo-CCD.png')).resize(426, 426).extract({ left: 62, top: 44, width: 300, height: 300 }).png().toBuffer())
  .composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
const hawky = await sharp(join(SRC, 'Hawky-bgTran.png')).resize(560, 560).png().toBuffer();
const og = await sharp(bg).composite([{ input: logo, left: 120, top: 165 }, { input: hawky, left: 600, top: 70 }]).jpeg({ quality: 84, mozjpeg: true }).toFile(join(OUT, 'og-default.jpg'));
console.log(`og-default.jpg   1200x630 ${Math.round(og.size / 1024)} KB`);
