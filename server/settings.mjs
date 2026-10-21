// System settings edited on admin.html. Stored in the settings table; anything not stored uses DEFAULTS.
// The values are cached in memory: load() at startup, save() updates the cache.
// Pages read the public part from /site-config.js (window.SITE) and the org chart from /org-data.js.
import { query } from './db.mjs';
import { HttpError } from './http.mjs';
import { applyOrg, FILE_ORG } from './org.mjs';

export const ALL_PLATFORMS = ['youtube', 'facebook', 'tiktok', 'drive'];
const PHOTO_HARD_MAX = 100; // the upload parser's limit; the setting stays within it

export const DEFAULTS = {
  // ประเภทข่าว (submit.html, publish dialog, search filters)
  categories: ['ข่าวผู้บริหาร', 'ข่าวกิจกรรมนักศึกษา', 'รางวัล/ความสำเร็จ', 'ข่าวการศึกษา', 'ข่าวความร่วมมือ/MOU',
    'ข่าวประชุม/สัมมนา', 'ข่าววิจัย/นวัตกรรม', 'ข่าวบริการวิชาการ', 'ข่าวกิจกรรมเพื่อชุมชน/ท้องถิ่น', 'ข่าววิศวกรสังคม'],
  // ภาพประกอบข่าว: fewest and most photos per news submission
  photos: { min: 1, max: 60 },
  // แหล่งวิดีโอที่รับ
  platforms: [...ALL_PLATFORMS],
  // เวลาตรวจข่าว: promised to senders, and when a queue item counts as late on reports
  review: { days: 2 },
  // ผังหน่วยงาน: same shape as window.ORG in org-data.js (null = use the file)
  org: null,
  // การเก็บข้อมูล (PDPA): files of work never published are removed after this many days without activity
  retention: { days: 180 },
  // ข้อความแจ้งเตือนถึงผู้ส่ง (PR can edit each one before sending)
  messages: {
    published: 'เผยแพร่บนเว็บไซต์แล้ว ขอบคุณที่ส่งข่าวมา',
    revise: 'ขอให้แก้ไขก่อนเผยแพร่: ',
    writing: 'ได้รับเอกสารแล้ว ทีม PR กำลังเขียนข่าว และจะส่งร่างให้ตรวจทานก่อนเผยแพร่',
  },
};

// Names shown in the history list
export const LABELS = {
  categories: 'ประเภทข่าว', photos: 'จำนวนภาพ', platforms: 'แหล่งวิดีโอ', review: 'เวลาตรวจข่าว',
  org: 'ผังหน่วยงาน', messages: 'ข้อความแจ้งเตือน', retention: 'ระยะเวลาเก็บข้อมูล',
};

const bad = (msg) => { throw new HttpError(400, msg); };
const text = (v, max, label) => {
  if (typeof v !== 'string' || !v.trim()) bad(`กรอก${label}`);
  if (v.trim().length > max) bad(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return v.trim();
};
const list = (v, label, { min = 1, max = 200, itemMax = 120 } = {}) => {
  if (!Array.isArray(v)) bad(`${label}ไม่ถูกต้อง`);
  const out = [...new Set(v.map((x) => text(x, itemMax, label)))];
  if (out.length < min) bad(`${label}ต้องมีอย่างน้อย ${min} รายการ`);
  if (out.length > max) bad(`${label}ได้ไม่เกิน ${max} รายการ`);
  return out;
};
const int = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) bad(`${label}ต้องเป็นจำนวนเต็ม ${lo}–${hi}`);
  return n;
};

// Each validator returns the clean value or throws 400
const VALIDATE = {
  categories: (v) => list(v, 'ประเภทข่าว', { max: 30, itemMax: 40 }),
  photos: (v) => {
    const min = int(v?.min, 1, 20, 'จำนวนภาพขั้นต่ำ');
    const max = int(v?.max, 1, PHOTO_HARD_MAX, 'จำนวนภาพสูงสุด');
    if (max < min) bad('จำนวนภาพสูงสุดต้องไม่น้อยกว่าขั้นต่ำ');
    return { min, max };
  },
  platforms: (v) => {
    const out = list(v, 'แหล่งวิดีโอ', { max: ALL_PLATFORMS.length });
    if (!out.every((p) => ALL_PLATFORMS.includes(p))) bad('แหล่งวิดีโอไม่ถูกต้อง');
    return ALL_PLATFORMS.filter((p) => out.includes(p));
  },
  review: (v) => ({ days: int(v?.days, 1, 30, 'เวลาตรวจข่าว') }),
  retention: (v) => ({ days: int(v?.days, 30, 3650, 'ระยะเวลาเก็บไฟล์') }),
  org: (v) => {
    if (v === null) return null; // back to org-data.js
    if (!v || typeof v !== 'object') bad('ผังหน่วยงานไม่ถูกต้อง');
    const staffGroups = (Array.isArray(v.staffGroups) ? v.staffGroups : bad('ต้องมีกลุ่มหน่วยงาน'))
      .map((g) => ({ label: text(g?.label, 60, 'ชื่อกลุ่มหน่วยงาน'), units: list(g?.units, `หน่วยงานในกลุ่ม ${g?.label || ''}`) }));
    if (!staffGroups.length) bad('ต้องมีกลุ่มหน่วยงานอย่างน้อย 1 กลุ่ม');
    const units = staffGroups.flatMap((g) => g.units);
    if (new Set(units).size !== units.length) bad('มีชื่อหน่วยงานซ้ำกัน');
    const subUnits = {};
    for (const [unit, s] of Object.entries(v.subUnits || {})) {
      if (!units.includes(unit)) bad(`หน่วยงานย่อยของ "${unit}" ไม่มีหน่วยงานหลักนี้ในผัง`);
      subUnits[unit] = { label: text(s?.label || 'หน่วยงานย่อย', 40, 'ชื่อเรียกหน่วยงานย่อย'), required: s?.required !== false, units: list(s?.units, `หน่วยงานย่อยของ ${unit}`) };
    }
    const faculties = {};
    for (const [name, f] of Object.entries(v.faculties || {})) {
      text(name, 120, 'ชื่อคณะ');
      const majors = (Array.isArray(f?.majors) ? f.majors : []).map((m) => (typeof m === 'string'
        ? text(m, 120, 'ชื่อสาขา')
        : { name: text(m?.name, 120, 'ชื่อสาขา'), tracks: list(m?.tracks, `แขนงของ ${m?.name || ''}`) }));
      if (!majors.length) bad(`${name} ต้องมีสาขาอย่างน้อย 1 สาขา`);
      faculties[name] = { ...(f.majorLabel ? { majorLabel: text(f.majorLabel, 30, 'ชื่อเรียกสาขา') } : {}), majors };
    }
    if (!Object.keys(faculties).length) bad('ต้องมีคณะอย่างน้อย 1 คณะ');
    return { staffGroups, subUnits, faculties };
  },
  messages: (v) => Object.fromEntries(Object.keys(DEFAULTS.messages).map((k) => [k, text(v?.[k], 500, 'ข้อความแจ้งเตือน')])),
};
export const KEYS = Object.keys(VALIDATE);

const cache = new Map();
export const get = (key) => (cache.has(key) ? cache.get(key) : DEFAULTS[key]);
export const all = () => Object.fromEntries(KEYS.map((k) => [k, get(k)]));

export async function load() {
  cache.clear();
  for (const r of (await query('select key, value from settings')).rows) if (KEYS.includes(r.key)) cache.set(r.key, r.value);
  applyOrg(get('org') || FILE_ORG);
}

// Validates and stores one setting (client = a transaction client). Returns the clean value.
export async function save(client, key, value, user) {
  if (!KEYS.includes(key)) throw new HttpError(404, 'ไม่พบการตั้งค่านี้');
  const clean = VALIDATE[key](value);
  await client.query(`insert into settings (key, value, updated_by) values ($1, $2, $3)
    on conflict (key) do update set value = $2, updated_at = now(), updated_by = $3`, [key, JSON.stringify(clean), user.id]);
  return clean;
}
// After the transaction commits
export function remember(key, value) {
  cache.set(key, value);
  if (key === 'org') applyOrg(value || FILE_ORG);
}

// ประเภทข่าวที่ใช้กับวิดีโอเท่านั้น: fixed, shown after the categories above (not edited on admin.html)
export const VIDEO_CATEGORIES = ['วิดีโอเสียงตามสาย'];

// window.SITE for the pages
export const publicSite = () => ({
  categories: get('categories'), videoCategories: VIDEO_CATEGORIES, photos: get('photos'), platforms: get('platforms'), reviewDays: get('review').days,
  // Google Identity Services on login.html; null until GOOGLE_CLIENT_ID is set
  googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  retentionDays: get('retention').days,
});
