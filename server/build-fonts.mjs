// npm run build:fonts — the site's fonts in assets/fonts, one WOFF2 per face with Thai and Latin together
// (fewer files than Google Fonts' per-script subsets: fewer downloads and fewer re-layouts while a page loads).
//   Prompt-500/600/700.woff2  headings (Google Fonts TTF, subset)
//   NotoSansThai.woff2        text, variable weight 400–700 (google/fonts repository, width axis fixed at 100)
// Needs internet once; the result is kept in assets/fonts. SIL Open Font License (both families).
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import subsetFont from 'subset-font';

const OUT = join(resolve(import.meta.dirname, '..'), 'assets', 'fonts');
// Thai + what Google Fonts calls "latin" (Basic Latin, Latin-1, punctuation, € ™ arrows −)
const RANGES = [[0x20, 0x7e], [0xa0, 0xff], [0x131, 0x131], [0x152, 0x153], [0x2bb, 0x2bc], [0x2c6, 0x2c6], [0x2d7, 0x2d7], [0x2da, 0x2da], [0x2dc, 0x2dc],
  [0x303, 0x304], [0x308, 0x308], [0x329, 0x329], [0x331, 0x331], [0xe01, 0xe5b], [0x2000, 0x206f], [0x20ac, 0x20ac], [0x2122, 0x2122],
  [0x2191, 0x2191], [0x2193, 0x2193], [0x2212, 0x2212], [0x2215, 0x2215], [0x25cc, 0x25cc], [0xfeff, 0xfeff], [0xfffd, 0xfffd]];
const TEXT = RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i))).join('');
const get = async (url, ua) => Buffer.from(await (await fetch(url, { headers: ua ? { 'user-agent': ua } : {} })).arrayBuffer());

// An old browser's user agent gets whole TTF files (one per weight) instead of subsets
const css = await (await fetch('https://fonts.googleapis.com/css2?family=Prompt:wght@500;600;700', { headers: { 'user-agent': 'Mozilla/4.0' } })).text();
for (const block of css.split('@font-face').slice(1)) {
  const w = block.match(/font-weight: (\d+);/)[1];
  const out = await subsetFont(await get(block.match(/url\((https:[^)]+)\)/)[1]), TEXT, { targetFormat: 'woff2' });
  writeFileSync(join(OUT, `Prompt-${w}.woff2`), out);
  console.log(`Prompt-${w}.woff2 ${Math.round(out.length / 1024)} KB`);
}
for (const [name, file] of [['NotoSansThai', 'notosansthai/NotoSansThai']]) {
  const ttf = await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${file}%5Bwdth,wght%5D.ttf`);
  const out = await subsetFont(ttf, TEXT, { targetFormat: 'woff2', variationAxes: { wdth: 100, wght: { min: 400, max: 700 } } });
  writeFileSync(join(OUT, `${name}.woff2`), out);
  console.log(`${name}.woff2 ${Math.round(out.length / 1024)} KB`);
}
