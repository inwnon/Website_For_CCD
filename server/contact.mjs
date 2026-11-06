// ติดต่อเรา (contact.html): who to call about news. Anyone may read it.
// - GET /api/contact                   { team: [person], faculties: [{ unit, people: [person + sent] }] } (faculties and other units)
// - GET /api/contact/photo/:id.webp    the profile photo of someone on that list: the one they uploaded, else their Google
//                                      photo, fetched once by this server and kept small (the page loads nothing from outside)
// team: the central PR team (role pr, and ผู้พัฒนาระบบ, who works in it).
// faculties: staff of a faculty or unit who ticked "ฉันเป็นประชาสัมพันธ์ของคณะ/หน่วยงาน" in their profile (users.unit_pr),
// and every ประชาสัมพันธ์หน่วยงาน (coordinator)
// under the unit an admin gave them, with how many pieces they have sent. A sub-unit shows in its main unit's card.
// Only work details: name, position, internal extension and the profile photo. Never the email.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Router } from 'express';
import sharp from 'sharp';
import { DEVELOPERS } from './auth.mjs';
import { one, query } from './db.mjs';
import { abs, sendMedia } from './files.mjs';
import { ORG, allUnits } from './org.mjs';

export const router = Router();

// Every unit a staff member can belong to (คณะ / วิทยาลัย, สำนัก / สถาบัน, ศูนย์), in org order; read per call since the org can change
const units = () => [...new Set(ORG.staffGroups.flatMap((g) => g.units))];
// The card a unit goes in: a main unit is its own card, a sub-unit (ศูนย์ภาษา) goes in its parent's (สำนักวิทยบริการฯ)
const mainUnit = (unit) => (units().includes(unit) ? unit : Object.entries(ORG.subUnits).find(([, s]) => s.units.includes(unit))?.[0] || null);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOOGLE_PHOTO = /^https:\/\/lh\d\.googleusercontent\.com\//;

// Who is on the page (the same rules for the list and for the photos)
const NAMED = 'u.consent_at is not null and u.first_name is not null and u.last_name is not null';
const onTeam = (devs) => `(u.role = 'pr' or u.email = any(${devs}::text[]))`;
// ประชาสัมพันธ์หน่วยงาน: the unit an admin gave them on chanon.html (pr_team.unit), whatever their profile position says
const COORD_UNIT = "(select t.unit from pr_team t where t.email = u.email and u.role = 'coordinator')";
const onFaculty = (units, all) => `((u.role in ('staff', 'coordinator', 'secretary', 'executive') and u.unit = any(${units}::text[]) and u.unit_pr)
  or ${COORD_UNIT} = any(${all}::text[]))`;

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
    query(`select u.id, u.first_name, u.last_name, u.position, u.phone, u.photo_path, u.avatar_url, coalesce(${COORD_UNIT}, u.unit) unit,
                  (select count(*) from submissions s where s.sender_id = u.id)::int sent
             from users u
            where ${onFaculty('$1', '$2')} and ${NAMED}
            order by sent desc, u.first_name, u.last_name`, [units(), allUnits()]),
  ]);
  res.json({
    team: team.rows.map(person),
    faculties: units()
      .map((unit) => ({ unit, people: staff.rows.filter((u) => mainUnit(u.unit) === unit).map((u) => ({ ...person(u), sent: u.sent })) }))
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
    [id, [...DEVELOPERS], units(), allUnits()]);
  const src = u && photoSource(u);
  if (!src) return res.status(404).end();
  try {
    sendMedia(res, u.photo_path || await googlePhoto(src), 'public, max-age=86400');
  } catch {
    res.status(404).end();
  }
});
