// npm run build:pdf — copies PDF.js from node_modules to assets/pdfjs-<version>/ and points documents.html at it, so previews load nothing from other sites.
// /assets is cached for good, so a new version must get a new folder.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PKG = join(ROOT, 'node_modules', 'pdfjs-dist');
const { version } = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const dir = `pdfjs-${version}`;

for (const old of readdirSync(join(ROOT, 'assets')).filter((f) => f.startsWith('pdfjs-'))) rmSync(join(ROOT, 'assets', old), { recursive: true });
mkdirSync(join(ROOT, 'assets', dir));
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE']) cpSync(join(PKG, f), join(ROOT, 'assets', dir, f.split('/').pop()));

const page = join(ROOT, 'documents.html');
writeFileSync(page, readFileSync(page, 'utf8').replace(/\/assets\/pdfjs-[0-9.]+\//g, `/assets/${dir}/`));
console.log(`assets/${dir} ready`);
