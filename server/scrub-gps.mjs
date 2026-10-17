// node --env-file=.env server/scrub-gps.mjs — removes GPS location from photos uploaded before uploads did it (files.mjs).
// Safe to run again: files without GPS are left as they are.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stripGps } from './exif.mjs';
import { UPLOAD_DIR } from './files.mjs';

let checked = 0, cleaned = 0;
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (/\.(jpe?g|png|webp|heic)$/i.test(e.name)) { checked++; if (await stripGps(p)) cleaned++; }
  }
}
await walk(join(UPLOAD_DIR, 'submissions'));
await walk(join(UPLOAD_DIR, 'media'));
console.log(`checked ${checked} photo(s), removed GPS from ${cleaned}`);
