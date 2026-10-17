// npm run build:css — builds assets/app.css with Tailwind (tailwind.config.cjs) and points every page at the new version.
// Pages link /assets/app.css?v=<first 10 hex of its sha256>, so browsers cache it for good and fetch a new build at once.
// Also copies the @font-face rules to assets/fonts.css for the pages that use the fonts without Tailwind (status, 404, maintenance).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const bin = join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
execFileSync(process.execPath, [bin, '-c', 'tailwind.config.cjs', '-i', 'assets/src/app.css', '-o', 'assets/app.css', '--minify'], { cwd: ROOT, stdio: 'inherit' });
writeFileSync(join(ROOT, 'assets', 'fonts.css'), readFileSync(join(ROOT, 'assets', 'src', 'fonts.css')));

const v = createHash('sha256').update(readFileSync(join(ROOT, 'assets', 'app.css'))).digest('hex').slice(0, 10);
let changed = 0;
for (const f of readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
  const s = readFileSync(join(ROOT, f), 'utf8');
  const t = s.replace(/\/assets\/app\.css(\?v=[0-9a-f]+)?/g, `/assets/app.css?v=${v}`);
  if (t !== s) { writeFileSync(join(ROOT, f), t); changed++; }
}
console.log(`assets/app.css v=${v}, ${changed} page(s) updated`);
