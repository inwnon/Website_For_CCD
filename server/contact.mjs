// ติดต่อเรา (contact.html): who to call about news. Anyone may read it.
// - GET /api/contact   { team: [person], faculties: [{ unit, people: [person + sent] }] }
// team: the central PR team (role pr, and ผู้พัฒนาระบบ, who works in it).
// faculties: staff of a faculty whose profile position says they do PR, with how many pieces they have sent.
// Only work details: name, position, internal extension. A profile photo only for signed-in readers (the photo URL
// needs a sign-in), never the Google one (the page loads nothing from outside).
import { Router } from 'express';
import { DEVELOPERS } from './auth.mjs';
import { query } from './db.mjs';
import { ORG } from './org.mjs';

export const router = Router();

// Positions that mean "does PR for the faculty" (the free-text position from login.html step 2)
export const PR_POSITION = '(ประชาสัมพันธ์|สื่อสารองค์กร|\\mPR\\M)';

const person = (signedIn) => (u) => ({
  name: `${u.first_name} ${u.last_name}`, position: u.position || null,
  // Staff phone numbers are the 4-digit internal extension (auth.mjs); anything else is not shown here
  ext: /^\d{4}$/.test(u.phone || '') ? u.phone : null,
  photo: signedIn && u.photo_path ? `/api/${u.photo_path}` : null,
});

router.get('/contact', async (req, res) => {
  const faculties = Object.keys(ORG.faculties);
  const [team, staff] = await Promise.all([
    query(`select first_name, last_name, position, phone, photo_path from users
            where (role = 'pr' or email = any($1)) and consent_at is not null and first_name is not null and last_name is not null
            order by first_name, last_name`, [[...DEVELOPERS]]),
    query(`select u.first_name, u.last_name, u.position, u.phone, u.photo_path, u.unit,
                  (select count(*) from submissions s where s.sender_id = u.id)::int sent
             from users u
            where u.role in ('staff', 'coordinator') and u.unit = any($1) and u.position ~* $2
              and u.consent_at is not null and u.first_name is not null and u.last_name is not null
            order by sent desc, u.first_name, u.last_name`, [faculties, PR_POSITION]),
  ]);
  const out = person(!!req.user);
  res.json({
    team: team.rows.map(out),
    faculties: faculties
      .map((unit) => ({ unit, people: staff.rows.filter((u) => u.unit === unit).map((u) => ({ ...out(u), sent: u.sent })) }))
      .filter((f) => f.people.length),
  });
});
