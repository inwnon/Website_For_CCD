// npm run build:images — page-sized copies of the brand images in assets/img (the originals in brand_assets/ are
// 1254px PNGs of 0.5–1.8 MB; pages show the logo at about 44px and Hawky at up to about 380px).
//   logo-96.webp, logo-192.webp   header and footer logo (1× / 2×+ screens)
//   icon-32.png, icon-180.png     browser tab and home-screen icons
//   hawky-480.webp, hawky-640.webp, hawky-960.webp
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'brand_assets');
const OUT = join(ROOT, 'assets', 'img');
mkdirSync(OUT, { recursive: true });
const jobs = [
  ['Logo-CCD.png', 'logo-96.webp', 96, (s) => s.webp({ quality: 86 })],
  ['Logo-CCD.png', 'logo-192.webp', 192, (s) => s.webp({ quality: 86 })],
  ['Logo-CCD.png', 'icon-32.png', 32, (s) => s.png({ compressionLevel: 9, palette: true })],
  ['Logo-CCD.png', 'icon-180.png', 180, (s) => s.png({ compressionLevel: 9, palette: true })],
  ['Hawky-bgTran.png', 'hawky-480.webp', 480, (s) => s.webp({ quality: 82, alphaQuality: 90 })],
  ['Hawky-bgTran.png', 'hawky-640.webp', 640, (s) => s.webp({ quality: 80, alphaQuality: 90 })],
  ['Hawky-bgTran.png', 'hawky-960.webp', 960, (s) => s.webp({ quality: 80, alphaQuality: 90 })],
];
for (const [src, out, w, enc] of jobs) {
  const info = await enc(sharp(join(SRC, src)).resize(w, w, { fit: 'inside' })).toFile(join(OUT, out));
  console.log(`${out.padEnd(16)} ${info.width}x${info.height} ${Math.round(info.size / 1024)} KB`);
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
