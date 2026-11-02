// ติดต่อเรา (contact.html): who to call about news. Anyone may read it.
// - GET /api/contact                   { team: [person], faculties: [{ unit, people: [person + sent] }] }
// - GET /api/contact/photo/:id.webp    the profile photo of someone on that list: the one they uploaded, else their Google
//                                      photo, fetched once by this server and kept small (the page loads nothing from outside)
// team: the central PR team (role pr, and ผู้พัฒนาระบบ, who works in it).
// faculties: staff of a faculty whose profile position says they do PR, with how many pieces they have sent.
// Only work details: name, position, internal extension and the profile photo. Never the email.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Router } from 'express';
import sharp from 'sharp';
import { DEVELOPERS } from './auth.mjs';
import { one, query } from './db.mjs';
import { abs, sendMedia } from './files.mjs';
import { ORG } from './org.mjs';

export const router = Router();

// Positions that mean "does PR for the faculty" (the free-text position from login.html step 2)
export const PR_POSITION = '(ประชาสัมพันธ์|สื่อสารองค์กร|\\mPR\\M)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOOGLE_PHOTO = /^https:\/\/lh\d\.googleusercontent\.com\//;

// Who is on the page (the same rules for the list and for the photos)
const NAMED = 'u.consent_at is not null and u.first_name is not null and u.last_name is not null';
const onTeam = (devs) => `(u.role = 'pr' or u.email = any(${devs}::text[]))`;
const onFaculty = (units, pos) => `(u.role in ('staff', 'coordinator', 'secretary', 'executive') and u.unit = any(${units}::text[]) and u.position ~* ${pos})`;

// A version in the photo link, so a new photo is not hidden by the browser's cache (also used by documents.mjs)
export const photoSource = (u) => u.photo_path || (GOOGLE_PHOTO.test(u.avatar_url || '') ? u.avatar_url : null);
export const version =(src) => createHash('sha256').update(src).digest('hex').slice(0, 10);

const person = (u) => {
  const src = photoSource(u);
  return {
    name: `${u.first_name} ${u.last_name}`, position: u.position || null,
    // Staff phone numbers are the 4-digit internal extension (auth.mjs); anything else is not shown here
    ext: /^\d{4}$/.test(u.phone || '') ? u.phone : null,
    photo: src ? `/api/contact/photo/${u.id}.webp?v=${version(src)}` : null,
  };
};

router.get('/contact', async (req, res) => {
  const [team, staff] = await Promise.all([
    query(`select u.id, u.first_name, u.last_name, u.position, u.phone, u.photo_path, u.avatar_url from users u
            where ${onTeam('$1')} and ${NAMED}
            order by u.first_name, u.last_name`, [[...DEVELOPERS]]),
    query(`select u.id, u.first_name, u.last_name, u.position, u.phone, u.photo_path, u.avatar_url, u.unit,
                  (select count(*) from submissions s where s.sender_id = u.id)::int sent
             from users u
            where ${onFaculty('$1', '$2')} and ${NAMED}
            order by sent desc, u.first_name, u.last_name`, [Object.keys(ORG.faculties), PR_POSITION]),
  ]);
  res.json({
    team: team.rows.map(person),
    faculties: Object.keys(ORG.faculties)
      .map((unit) => ({ unit, people: staff.rows.filter((u) => u.unit === unit).map((u) => ({ ...person(u), sent: u.sent })) }))
      .filter((f) => f.people.length),
  });
});

const inFlight = new Map();
export async function googlePhoto(url) {
  const rel = `contact/${version(url)}.webp`;
  if (existsSync(abs(rel))) return rel;
  if (!inFlight.has(rel)) {
    inFlight.set(rel, (async () => {
      const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`google photo ${r.status}`);
      await mkdir(abs('contact'), { recursive: true });
      await sharp(Buffer.from(await r.arrayBuffer())).resize(192, 192, { fit: 'cover' }).webp({ quality: 82 }).toFile(abs(rel));
      return rel;
    })().finally(() => inFlight.delete(rel)));
  }
  return inFlight.get(rel);
}

router.get('/contact/photo/:file', async (req, res) => {
  const id = req.params.file.match(/^(.+)\.webp$/)?.[1];
  if (!id || !UUID.test(id)) return res.status(404).end();
  // Only someone the contact list shows (not anyone's photo)
  const u = await one(`select u.photo_path, u.avatar_url from users u where u.id = $1 and ${NAMED} and (${onTeam('$2')} or ${onFaculty('$3', '$4')})`,
    [id, [...DEVELOPERS], Object.keys(ORG.faculties), PR_POSITION]);
  const src = u && photoSource(u);
  if (!src) return res.status(404).end();
  try {
    sendMedia(res, u.photo_path || await googlePhoto(src), 'public, max-age=86400');
  } catch {
    res.status(404).end();
  }
});
