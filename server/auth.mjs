// Sign-in, sessions and the signed-in user's profile
// - POST /api/auth/google   { credential }  Google Identity Services ID token → session cookie
// - POST /api/auth/dev      { as }          development only (ALLOW_DEV_LOGIN=1)
// - POST /api/auth/logout
// - GET  /api/me                            { user, unread } or { user: null }
// - PUT  /api/me/profile                    sign-up steps 2–3 of login.html
// - POST /api/me/role       { role }        developer accounts only: work as 'pr' (ทีม PR งานสื่อสารองค์กร) or 'admin' (ผู้พัฒนาระบบ)
// - PUT  /api/me/photo                      multipart "photo" JPG/PNG/WebP ≤ 5 MB → square 512px WebP · DELETE removes it
// - GET  /api/avatars/:file                 profile photos (signed-in users only)
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { OAuth2Client } from 'google-auth-library';
import { one, query } from './db.mjs';
import { UPLOAD_DIR, abs, removeTemp, sendMedia } from './files.mjs';
import { HttpError, parseCookies, str } from './http.mjs';
import { FACULTIES, ORG, STAFF_UNITS, majorsOf, tracksOf } from './org.mjs';
import { audit } from './audit.mjs';
import { DEV_ACCOUNTS, limit, matchesName } from './security.mjs';
import { askableOf, modulesOf } from './access.mjs';
import { baseRole, domainRole } from './rules.mjs';

export { baseRole, domainRole };

const COOKIE = 'sid';
const TTL_MS = 8 * 60 * 60 * 1000; // 8 hours after the last use (SPEC.md §7)
const TOUCH_MS = 5 * 60 * 1000; // moved at most this often, so most requests write nothing
const COOKIE_MS = 30 * 24 * 60 * 60 * 1000; // outlives the session: the server decides when it ends, and pictures need no Set-Cookie
const PROD = process.env.NODE_ENV === 'production';
const DEV_LOGIN = !PROD && process.env.ALLOW_DEV_LOGIN === '1';
const google = new OAuth2Client();
const hash = (token) => createHash('sha256').update(token).digest('hex');

// ผู้พัฒนาระบบ: the highest rights (admin), not given or taken away on chanon.html (pr_team), and may switch to
// working as the PR team to see the site as they do. DEVELOPER_EMAILS in .env adds more (comma separated).
export const DEVELOPERS = new Set(['satearnpong.nis@sru.ac.th', ...(process.env.DEVELOPER_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)]);
export const SWITCH_ROLES = { pr: 'ทีม PR งานสื่อสารองค์กร', admin: 'ผู้พัฒนาระบบ' };

export const isPr = (u) => u?.role === 'pr' || u?.role === 'admin';
export const isAdmin = (u) => u?.role === 'admin';
// ประชาสัมพันธ์หน่วยงาน: reads the reports of one unit (u.coord_unit, from pr_team)
export const isCoordinator = (u) => u?.role === 'coordinator';
// นักศึกษาฝึกงาน สสอ.: imports past stories (pr-import.html) only; elsewhere their baseRole (rules.mjs)
export const isIntern = (u) => u?.role === 'intern';
export const isUniversity = (u) => !!u && baseRole(u) !== 'external';

// Staff (and PR / admin / coordinators, all on @sru.ac.th) give their internal extension; others a phone number
export const usesExtension = (role) => role !== 'student' && role !== 'external';
// Profile complete: name, phone and consent (accounts from before the name and phone fields are asked again)
export const onboarded = (u) => !!(u.consent_at && u.first_name && u.last_name && u.phone);

// The photo the user uploaded, else the Google one
export const photoUrl = (u) => (u.photo_path ? `/api/${u.photo_path}` : u.avatar_url || null);

// What the browser sees; same field names as the profile object the pages already use
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, firstName: u.first_name, lastName: u.last_name, phone: u.phone, avatarUrl: photoUrl(u), ownPhoto: !!u.photo_path, googlePhoto: u.avatar_url || null, role: u.role,
    unit: u.unit, subUnit: u.sub_unit, position: u.position, major: u.major, track: u.track,
    year: u.year, org: u.org, consentAt: u.consent_at, onboarded: onboarded(u),
    ...(u.coord_unit ? { coordUnit: u.coord_unit } : {}),
    ...(baseRole(u) !== u.role ? { baseRole: baseRole(u) } : {}),
    ...(u.developer ? { developer: true } : {}),
  };
}


async function roleFor(email) {
  if (DEVELOPERS.has(email)) return 'admin';
  const pr = await one('select role from pr_team where email = $1', [email]);
  return pr?.role ?? domainRole(email);
}

/** @param {import('express').Request} req @param {import('express').Response} res @param {{ email: string, name: string, avatarUrl?: string, sub?: string }} profile */
async function startSession(req, res, { email, name, avatarUrl, sub }) {
  email = email.toLowerCase();
  const role = await roleFor(email);
  const user = await one(
    `insert into users (email, name, avatar_url, google_sub, role, last_login_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (email) do update set
       -- The name typed on the profile wins over the Google one
       name = case when users.first_name is not null then users.name else coalesce(nullif(excluded.name, ''), users.name) end,
       avatar_url = coalesce(excluded.avatar_url, users.avatar_url),
       google_sub = coalesce(users.google_sub, excluded.google_sub),
       role = excluded.role,
       last_login_at = now()
     returning *`,
    [email, name || '', avatarUrl || null, sub || null, role],
  );
  const token = randomBytes(32).toString('base64url');
  await query('insert into sessions (id, user_id, expires_at, user_agent) values ($1, $2, $3, $4)', [
    hash(token), user.id, new Date(Date.now() + TTL_MS), (req.get('user-agent') || '').slice(0, 300),
  ]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: COOKIE_MS, path: '/' });
  return user;
}

// Sets req.user (or null) on every request
export async function loadUser(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    req.sessionId = hash(token);
    req.user = await one(
      `select u.*, t.unit coord_unit, s.acting_role, s.expires_at session_ends,
         exists (select 1 from request_access a where a.email = u.email and a.status = 'approved') requester,
         exists (select 1 from phonebook_viewers v where v.email = u.email)
           or exists (select 1 from phonebook_editors e where e.email = u.email and e.expires_at > now()) phonebook_viewer
       from sessions s join users u on u.id = s.user_id
       left join pr_team t on t.email = u.email and t.role = 'coordinator'
       where s.id = $1 and s.expires_at > now()`,
      [req.sessionId],
    );
    // A developer works as the role chosen for this session (admin unless switched); nobody else can have one
    if (req.user) {
      if (new Date(req.user.session_ends).getTime() - Date.now() < TTL_MS - TOUCH_MS) {
        await query('update sessions set expires_at = $2 where id = $1', [req.sessionId, new Date(Date.now() + TTL_MS)]);
      }
      req.user.developer = DEVELOPERS.has(req.user.email);
      if (req.user.developer) req.user.role = req.user.acting_role === 'pr' ? 'pr' : 'admin';
    }
  }
  next();
}

export const requireUser = (req, res, next) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  next();
};
export const requireAdmin = (req, res, next) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  if (!isAdmin(req.user)) throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ');
  next();
};
// Reports: PR and admin only while the page is in development (coordinators get 403 for now; reports.mjs still scopes them to their unit)
export const requireReports = (req, res, next) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  if (!isPr(req.user)) throw new HttpError(403, 'หน้ารายงานอยู่ระหว่างการพัฒนา เปิดให้เฉพาะทีมงานประชาสัมพันธ์');
  next();
};
export const requirePr = (req, res, next) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  if (!isPr(req.user)) throw new HttpError(403, 'เฉพาะทีมงานประชาสัมพันธ์');
  next();
};
// นำเข้าข่าวย้อนหลัง: the PR team and the interns
export const requireImport = (req, res, next) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  if (!isPr(req.user) && !isIntern(req.user)) throw new HttpError(403, 'เฉพาะทีมงานประชาสัมพันธ์และนักศึกษาฝึกงาน สสอ.');
  next();
};

export const router = Router();

// Sign-in attempts per IP (a whole computer lab shares one address, so not too tight)
router.post('/auth/google', limit('signin', { by: 'ip', max: 30, windowMs: 10 * 60 * 1000, message: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' }), async (req, res) => {
  const credential = req.body?.credential;
  if (!process.env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'ยังไม่ได้ตั้งค่า Google Sign-In');
  if (typeof credential !== 'string') throw new HttpError(400, 'ไม่พบข้อมูลบัญชี Google');
  let p;
  try {
    p = (await google.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID })).getPayload();
  } catch {
    throw new HttpError(401, 'ยืนยันบัญชี Google ไม่สำเร็จ กรุณาลองใหม่');
  }
  if (!p?.email || !p.email_verified) throw new HttpError(401, 'บัญชี Google นี้ยังไม่ได้ยืนยันอีเมล');
  const user = await startSession(req, res, { email: p.email, name: p.name, avatarUrl: p.picture, sub: p.sub });
  res.json({ user: publicUser(user) });
});

if (DEV_LOGIN) {
  const DEV = DEV_ACCOUNTS;
  const DEV_COORD_UNIT = 'คณะครุศาสตร์';
  // Only on this computer: a request to any other host name (a server on the network or the internet) is refused
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  router.post('/auth/dev', async (req, res) => {
    if (!LOCAL_HOSTS.has(req.hostname)) throw new HttpError(403, 'ล็อกอินจำลองใช้ได้เฉพาะบน localhost');
    const as = req.body?.as;
    if (!DEV[as]) throw new HttpError(400, `as ต้องเป็น ${Object.keys(DEV).join(', ')}`);
    if (['pr', 'admin', 'coordinator', 'intern', 'secretary', 'executive'].includes(as)) {
      const unit = as === 'coordinator' ? DEV_COORD_UNIT : null;
      await query('insert into pr_team (email, role, unit) values ($1, $2, $3) on conflict (email) do update set role = $2, unit = $3', [DEV[as], as, unit]);
    }
    const user = await startSession(req, res, { email: DEV[as], name: 'ผู้ใช้ตัวอย่าง' });
    res.json({ user: publicUser(user) });
  });
}

router.post('/me/role', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  if (!req.user.developer) throw new HttpError(403, 'สลับบทบาทได้เฉพาะบัญชีผู้พัฒนาระบบ');
  const role = req.body?.role;
  if (!SWITCH_ROLES[role]) throw new HttpError(400, 'บทบาทไม่ถูกต้อง');
  const from = req.user.role;
  await query('update sessions set acting_role = $2 where id = $1', [req.sessionId, role]);
  if (from !== role) await audit({ query }, { ...req.user, role }, 'role.switch', req.user.email, `สลับบทบาทจาก ${SWITCH_ROLES[from]} เป็น ${SWITCH_ROLES[role]}`, { from, to: role });
  res.json({ user: publicUser({ ...req.user, role }) });
});

router.post('/auth/logout', async (req, res) => {
  if (req.sessionId) await query('delete from sessions where id = $1', [req.sessionId]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// devLogin tells pages they may offer the development sign-in buttons
// unread: items in the user's inbox with something new (header badge)
// modules: the back-office modules for the menus (access.mjs; the routes check again); askable: modules the user may ask for
router.get('/me', async (req, res) => {
  const unread = req.user ? (await one("select count(*)::int n from submissions where sender_id = $1 and sender_unread and status <> 'rejected'", [req.user.id])).n : 0;
  res.json({ user: publicUser(req.user), unread, ...(req.user ? { modules: modulesOf(req.user), askable: askableOf(req.user) } : {}), ...(isPr(req.user) ? { shortcuts: shortcutsOf(req.user) } : {}), ...(DEV_LOGIN ? { devLogin: true } : {}) });
});

// ---- ทางลัดของฉัน (index.html): the desk pages a PR team member keeps on the home page, in their order ----
// The pages themselves (names, links, icons) are in index.html; here only which ones exist and who may have them.
export const SHORTCUTS = ['review', 'inbox', 'add', 'import', 'news', 'scheduled', 'collections', 'report', 'admin'];
const SHORTCUT_DEFAULT = ['review', 'add', 'news', 'collections'];
const shortcutOk = (u) => (id) => SHORTCUTS.includes(id) && (id !== 'admin' || u.role === 'admin');
const shortcutsOf = (u) => (u.shortcuts || SHORTCUT_DEFAULT).filter(shortcutOk(u));
router.put('/me/shortcuts', requireUser, limit('shortcuts', { max: 60, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  if (!isPr(req.user)) throw new HttpError(403, 'ทางลัดมีเฉพาะทีม PR');
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > SHORTCUTS.length || !ids.every((x) => typeof x === 'string')) throw new HttpError(400, 'รายการทางลัดไม่ถูกต้อง');
  const clean = [...new Set(ids)].filter(shortcutOk(req.user));
  await query('update users set shortcuts = $2 where id = $1', [req.user.id, clean]);
  res.json({ shortcuts: clean });
});

// Mirrors the checks in login.html step 2 (name, phone, affiliation) and step 3 (consent)
router.put('/me/profile', requireUser, limit('profile', { max: 30, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  const b = req.body || {};
  const role = baseRole(req.user);
  const errors = {};
  const p = { unit: null, sub_unit: null, position: null, major: null, track: null, year: null, org: null };

  // Name and phone, for every role
  const first = str(b.firstName, 80, 'ชื่อ');
  const last = str(b.lastName, 80, 'นามสกุล');
  if (!first) errors.firstName = 'กรุณากรอกชื่อ';
  if (!last) errors.lastName = 'กรุณากรอกนามสกุล';
  const ext = usesExtension(role);
  const phone = (str(b.phone, 30, 'เบอร์โทรศัพท์') || '').replace(/[\s-]/g, '');
  if (!phone) errors.phone = ext ? 'กรุณากรอกเบอร์โทรศัพท์ภายใน' : 'กรุณากรอกเบอร์โทรศัพท์';
  else if (ext && !/^\d{4}$/.test(phone)) errors.phone = 'เบอร์โทรศัพท์ภายในเป็นตัวเลข 4 หลัก';
  else if (ext && phone[0] === '0') errors.phone = 'เบอร์โทรศัพท์ภายในขึ้นต้นด้วย 0 ไม่ได้';
  else if (!ext && !/^0\d{9}$/.test(phone)) errors.phone = 'เบอร์โทรศัพท์ต้องมี 10 หลัก ขึ้นต้นด้วย 0 เช่น 0812345678';

  if (role === 'external') {
    p.org = str(b.org, 200, 'หน่วยงาน / องค์กร');
    p.position = str(b.position, 120, 'ตำแหน่ง');
    if (!p.org) errors.org = 'กรุณาระบุหน่วยงานหรือองค์กร';
  } else if (role === 'student') {
    p.unit = str(b.unit, 200, 'คณะ');
    p.major = str(b.major, 200, 'สาขาวิชา');
    p.track = str(b.track, 200, 'วิชาเอก');
    p.year = Number(b.year);
    if (!FACULTIES.has(p.unit)) errors.unit = 'กรุณาเลือกคณะ';
    else if (!majorsOf(p.unit).includes(p.major)) errors.major = 'กรุณาเลือกสาขาวิชา';
    else {
      const tracks = tracksOf(p.unit, p.major);
      if (tracks.length && !tracks.includes(p.track)) errors.track = 'กรุณาเลือกวิชาเอก';
      if (!tracks.length) p.track = null;
    }
    if (!Number.isInteger(p.year) || p.year < 1 || p.year > 5) errors.year = 'กรุณาเลือกชั้นปี';
  } else {
    // staff, and PR / admin who sign in with a university account
    p.unit = str(b.unit, 200, 'หน่วยงาน');
    p.sub_unit = str(b.subUnit, 200, 'หน่วยงานย่อย');
    p.position = str(b.position, 120, 'ตำแหน่ง');
    const sub = ORG.subUnits[p.unit];
    if (!STAFF_UNITS.has(p.unit)) errors.unit = 'กรุณาเลือกหน่วยงาน';
    else if (sub?.required && !p.sub_unit) errors.subUnit = 'กรุณาเลือกหน่วยงานย่อย';
    else if (p.sub_unit && !sub?.units.includes(p.sub_unit)) errors.subUnit = 'หน่วยงานย่อยไม่ถูกต้อง';
    if (!p.position) errors.position = 'กรุณาระบุตำแหน่ง';
  }
  if (b.consent !== true && !req.user.consent_at) errors.consent = 'กรุณายอมรับนโยบายความเป็นส่วนตัว';
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);

  const user = await one(
    `update users set unit = $2, sub_unit = $3, position = $4, major = $5, track = $6, year = $7, org = $8,
       first_name = $9, last_name = $10, name = $9 || ' ' || $10, phone = $11, consent_at = coalesce(consent_at, now())
     where id = $1 returning *`,
    [req.user.id, p.unit, p.sub_unit, p.position, p.major, p.track, p.year, p.org, first, last, phone],
  );
  res.json({ user: publicUser(user) });
});

// ---- Profile photo ----
const MB = 1024 * 1024;
const photoUpload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: 5 * MB, files: 1, fields: 0 }, defParamCharset: 'utf8' }).single('photo');
const photoLimit = limit('photo', { max: 20, windowMs: 10 * 60 * 1000 });
const removePhoto = (rel) => (rel ? rm(abs(rel), { force: true }) : null);

router.put('/me/photo', requireUser, photoLimit, (req, res, next) => photoUpload(req, res, async (err) => {
  const f = req.file;
  try {
    if (err) throw new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'รูปใหญ่เกิน 5 MB' : 'อัปโหลดรูปไม่สำเร็จ');
    if (!f) throw new HttpError(400, 'เลือกรูปโปรไฟล์');
    if (!/\.(jpe?g|png|webp)$/i.test(f.originalname) || !(await matchesName(f.path, f.originalname))) throw new HttpError(400, 'ใช้ไฟล์ JPG, PNG หรือ WebP');
    await mkdir(abs('avatars'), { recursive: true });
    const rel = `avatars/${randomUUID()}.webp`;
    // Square crop from the centre, re-encoded: no EXIF / GPS kept
    try {
      await sharp(f.path).rotate().resize(512, 512, { fit: 'cover', position: 'attention' }).webp({ quality: 84 }).toFile(abs(rel));
    } catch {
      throw new HttpError(400, 'เปิดรูปนี้ไม่ได้ ลองบันทึกเป็น JPG หรือ PNG ใหม่');
    }
    const old = req.user.photo_path;
    const user = await one('update users set photo_path = $2 where id = $1 returning *', [req.user.id, rel]);
    await removePhoto(old);
    res.json({ user: publicUser(user) });
  } catch (e) {
    next(e);
  } finally {
    if (f) await removeTemp([f]);
  }
}));

router.delete('/me/photo', requireUser, async (req, res) => {
  const user = await one('update users set photo_path = null where id = $1 returning *', [req.user.id]);
  await removePhoto(req.user.photo_path);
  res.json({ user: publicUser(user) });
});

// File names are random and change with every upload, so they cache for good
router.get('/avatars/:file', requireUser, (req, res) => {
  if (!/^[0-9a-f-]{36}\.webp$/.test(req.params.file)) throw new HttpError(404, 'ไม่พบรูป');
  sendMedia(res, `avatars/${req.params.file}`, 'private, max-age=31536000, immutable');
});
