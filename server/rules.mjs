// Submission rules — the server-side copy of the checks in submit.html (CHECKS, PLATFORMS, uploaders)
import { HttpError, str } from './http.mjs';
import { FACULTIES, STAFF_SEND_UNITS } from './org.mjs';
import { get, VIDEO_CATEGORIES } from './settings.mjs';

export const TYPES = ['news', 'video', 'banner'];
export const AUDIENCES = ['public', 'student', 'staff'];
export const MAX_CATS = 5;
export const MAX_GUESTS = 5;
export const MIN_BODY = 150;
export const MAX_TITLE = 180;
export const MAX_LEAD = 250;
// ประเภทข่าว, photo limits and video platforms come from the settings (admin.html); submit.html reads the same values.
// categories(): every valid one, the video-only ones too (a story or an import may be a video)
export const categories = () => [...new Set([...get('categories'), ...VIDEO_CATEGORIES])];
export const videoOnly = (c) => VIDEO_CATEGORIES.includes(c) && !get('categories').includes(c);
const platformOk = (p, url) => get('platforms').includes(p) && PLATFORMS[p]?.test(url);
export const PLATFORMS = {
  youtube: /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i,
  facebook: /^https?:\/\/((www|m|web)\.)?(facebook\.com|fb\.watch)\/\S+/i,
  tiktok: /^https?:\/\/((www|vm|vt|m)\.)?tiktok\.com\/\S+/i,
  drive: /^https?:\/\/drive\.google\.com\/\S+/i,
};

// "ดูรูปภาพเพิ่มเติม" album link: any https page; known photo hosts get their name on the button
export const ALBUM_HOSTS = {
  facebook: /^(www\.|m\.|web\.)?(facebook\.com|fb\.com|fb\.me)$/i,
  drive: /^drive\.google\.com$/i,
  photos: /^(photos\.google\.com|photos\.app\.goo\.gl)$/i,
};
export const albumHost = (url) => {
  try { const h = new URL(url).host; return Object.keys(ALBUM_HOSTS).find((k) => ALBUM_HOSTS[k].test(h)) || 'other'; } catch { return null; }
};
// Returns the cleaned link, null for empty, or throws a field error
export function albumUrl(v) {
  const s = str(v, 500, 'ลิงก์ภาพเพิ่มเติม');
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || u.protocol !== 'https:') throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', { albumUrl: 'ใส่ลิงก์ที่ขึ้นต้นด้วย https:// เช่น อัลบั้ม Facebook หรือโฟลเดอร์ Google Drive' });
  return u.href;
}

const MB = 1024 * 1024;
const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i;
// Upload slots per kind: count, size per file, accepted files (submit.html uploaders).
// Videos are links only (PLATFORMS), never uploaded files.
export const UPLOADS = {
  photo: { types: ['news'], max: 100, maxBytes: 15 * MB, accepts: (f) => IMAGE_EXT.test(f.originalname) },
  attach: { types: ['news'], max: 10, maxBytes: 20 * MB, accepts: (f) => DOC_EXT.test(f.originalname) },
  art: { types: ['banner'], max: 10, maxBytes: 100 * MB, accepts: (f) => /\.(jpe?g|png|webp|pdf)$/i.test(f.originalname) },
};

// Label shown in the inbox (audLabel in submit.html)
export function audienceLabel(a) {
  if (a.includes('public')) return 'บุคคลทั่วไป';
  if (a.includes('student') && a.includes('staff')) return 'ภายในมหาวิทยาลัย';
  if (a.includes('staff')) return 'เฉพาะบุคลากร';
  return 'เฉพาะนักศึกษา';
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
// { prefix, name, pos }: prefix is a title such as ผศ.ดร. (a list in name-prefixes.js, or typed under "อื่น ๆ")
const person = (p, label) => {
  if (p == null) return null;
  if (typeof p !== 'object') throw new HttpError(400, `${label} ไม่ถูกต้อง`);
  const prefix = str(p.prefix, 60, `คำนำหน้านาม${label}`);
  const name = str(p.name, 100, `ชื่อ${label}`);
  const pos = str(p.pos, 120, `ตำแหน่ง${label}`);
  return name || pos ? { ...(prefix ? { prefix } : {}), name, pos } : null;
};

/**
 * Checks the form data and the files (counted per kind, after removals) for one submission.
 * Returns the columns to store. Throws HttpError(400) with a field → message map.
 */
export function checkSubmission(user, d, fileCounts) {
  if (!d || typeof d !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลงาน');
  const type = d.type;
  if (!TYPES.includes(type)) throw new HttpError(400, 'กรุณาเลือกประเภทงาน');
  const errors = {};
  const need = (key, ok, msg) => { if (!ok && !errors[key]) errors[key] = msg; };
  const isNews = type === 'news';
  const hasDate = type !== 'banner';

  const row = {
    type,
    title: str(d.title, MAX_TITLE, 'หัวข้อ'),
    lead: isNews ? str(d.lead, MAX_LEAD, 'คำโปรย') : null,
    description: str(d.desc, 5000, 'คำอธิบาย'),
    body: isNews && d.contentMode === 'own' ? str(d.body, 20000, 'เนื้อหาข่าว') : null,
    event_date: hasDate ? d.eventDate || null : null,
    place: isNews ? str(d.place, 120, 'สถานที่') : null,
    unit: str(d.unit, 200, 'หน่วยงาน'),
    categories: type === 'banner' ? [] : d.categories,
    content_mode: isNews ? d.contentMode || null : null,
    people: {},
    credit: isNews ? str(d.credit, 80, 'เครดิตภาพ') : null,
    news_video_url: isNews ? str(d.newsVideo, 500, 'ลิงก์วิดีโอ') : null,
    news_video_platform: null,
    video_mode: type === 'video' ? 'link' : null,
    video_url: null,
    video_platform: null,
    title_en: isNews && d.en ? str(d.titleEn, 160, 'หัวข้อภาษาอังกฤษ') : null,
    body_en: isNews && d.en ? str(d.bodyEn, 20000, 'เนื้อหาภาษาอังกฤษ') : null,
    audience: d.audience,
    note: str(d.note, 300, 'หมายเหตุ'),
    album_url: null,
    designer: type === 'banner' ? str(d.designer, 120, 'ผู้ออกแบบ') : null,
    producer: type === 'video' ? str(d.producer, 120, 'ผู้ผลิต') : null,
  };

  need('title', row.title, 'กรอกหัวข้อ');
  need('unit', row.unit, 'เลือกหน่วยงาน');
  if (row.unit) {
    const ok = user.role === 'student' ? FACULTIES.has(row.unit) && (!user.unit || row.unit === user.unit) : STAFF_SEND_UNITS.has(row.unit);
    need('unit', ok, 'หน่วยงานไม่ถูกต้อง');
  }
  if (hasDate) need('eventDate', isDate(row.event_date), 'เลือกวันที่จัดกิจกรรม');
  if (type === 'banner') need('desc', row.description, 'กรอกข้อความประกอบโพสต์');

  if (type !== 'banner') {
    const cats = Array.isArray(row.categories) ? [...new Set(row.categories)] : [];
    need('categories', cats.length > 0, 'เลือกประเภทข่าวอย่างน้อย 1 ประเภท');
    need('categories', cats.length <= MAX_CATS, `เลือกประเภทข่าวได้ไม่เกิน ${MAX_CATS} ประเภท`);
    need('categories', cats.every((c) => categories().includes(c)), 'ประเภทข่าวไม่ถูกต้อง');
    need('categories', type === 'video' || !cats.some(videoOnly), `ประเภท ${VIDEO_CATEGORIES.join(', ')} ใช้กับวิดีโอเท่านั้น`);
    row.categories = cats;
  }

  if (isNews) {
    need('contentMode', ['own', 'pr'].includes(row.content_mode), 'เลือกวิธีส่งเนื้อหาข่าว');
    if (row.content_mode === 'own') need('body', (row.body || '').length >= MIN_BODY, `เนื้อหาข่าวอย่างน้อย ${MIN_BODY} ตัวอักษร`);
    if (row.content_mode === 'pr') need('attach', fileCounts.attach > 0, 'แนบเอกสารให้ PR เขียนข่าวอย่างน้อย 1 ไฟล์');
    const photos = get('photos');
    need('photo', fileCounts.photo >= photos.min, `แนบภาพข่าวอย่างน้อย ${photos.min} ภาพ`);
    need('photo', fileCounts.photo <= photos.max, `แนบภาพข่าวได้ไม่เกิน ${photos.max} ภาพ`);
    if (row.news_video_url) {
      row.news_video_platform = d.newsPlatform;
      need('newsVideo', platformOk(d.newsPlatform, row.news_video_url), 'ลิงก์วิดีโอไม่ตรงกับแพลตฟอร์มที่เลือก');
    }
    const guests = Array.isArray(d.guests) ? d.guests : [];
    need('guests', guests.length <= MAX_GUESTS, `บุคคลสำคัญจากภายนอกได้ไม่เกิน ${MAX_GUESTS} คน`);
    row.people = {
      chair: person({ prefix: d.chairPrefix, name: d.chairName, pos: d.chairPos }, 'ประธาน'),
      reporter: person({ prefix: d.reporterPrefix, name: d.reporterName, pos: d.reporterPos }, 'ผู้กล่าวรายงาน'),
      assignee: person({ prefix: d.assigneePrefix, name: d.assigneeName, pos: d.assigneePos }, 'ผู้ที่ได้รับมอบหมาย'),
      guests: guests.slice(0, MAX_GUESTS).map((g, i) => person(g, `บุคคลภายนอกคนที่ ${i + 1}`)).filter(Boolean),
    };
  }

  if (type === 'video') {
    row.video_url = str(d.videoLink, 500, 'ลิงก์วิดีโอ');
    row.video_platform = d.videoPlatform;
    need('videoLink', row.video_url && platformOk(d.videoPlatform, row.video_url), 'ลิงก์วิดีโอไม่ตรงกับแพลตฟอร์มที่เลือก');
  }
  if (type === 'banner') need('art', fileCounts.art > 0, 'แนบไฟล์งานอย่างน้อย 1 ไฟล์');
  if (isNews) {
    try { row.album_url = albumUrl(d.albumUrl); } catch (err) { need('albumUrl', false, err.details?.albumUrl || err.message); }
  }

  const aud = Array.isArray(row.audience) ? [...new Set(row.audience)] : [];
  need('audience', aud.length > 0 && aud.every((a) => AUDIENCES.includes(a)), 'เลือกว่าใครเห็นงานนี้ได้');
  // "บุคคลทั่วไป" includes everyone (syncAudience in submit.html)
  row.audience = aud.includes('public') ? [...AUDIENCES] : aud;

  need('consent', d.consent === true, 'ยืนยันข้อมูลและสิทธิ์ก่อนส่ง');

  for (const [kind, n] of Object.entries(fileCounts)) {
    if (n && !UPLOADS[kind]?.types.includes(type)) errors[kind] = 'งานประเภทนี้ไม่รับไฟล์ชนิดนี้';
    else if (n > UPLOADS[kind].max) errors[kind] = `แนบได้ไม่เกิน ${UPLOADS[kind].max} ไฟล์`;
  }

  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  return row;
}

// ---- Drafts (drafts.mjs) ----
// What a draft keeps: the form fields as submit.html sends them, cut to the same lengths as a submission.
// Nothing is required; the full checks (checkSubmission) run when the draft is sent.
const DRAFT_TEXT = { title: MAX_TITLE, lead: MAX_LEAD, desc: 5000, body: 20000, eventDate: 10, place: 120, unit: 200, contentMode: 10, credit: 80,
  newsVideo: 500, newsPlatform: 20, videoLink: 500, videoPlatform: 20, albumUrl: 500, chairPrefix: 60, chairName: 100, chairPos: 120,
  reporterPrefix: 60, reporterName: 100, reporterPos: 120, assigneePrefix: 60, assigneeName: 100, assigneePos: 120, titleEn: 160, bodyEn: 20000, note: 300, designer: 120, producer: 120 };
export function draftData(d) {
  if (!d || typeof d !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลร่าง');
  if (!TYPES.includes(d.type)) throw new HttpError(400, 'กรุณาเลือกประเภทงาน');
  const out = { type: d.type };
  for (const [k, max] of Object.entries(DRAFT_TEXT)) { const v = typeof d[k] === 'string' ? d[k].slice(0, max) : ''; if (v) out[k] = v; }
  const list = (v, n, len) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => x.slice(0, len)) : []);
  out.categories = list(d.categories, MAX_CATS, 100);
  out.audience = list(d.audience, 3, 10).filter((a) => AUDIENCES.includes(a));
  out.guests = (Array.isArray(d.guests) ? d.guests : []).slice(0, MAX_GUESTS).filter((g) => g && typeof g === 'object')
    .map((g) => ({ prefix: String(g.prefix || '').slice(0, 60), name: String(g.name || '').slice(0, 100), pos: String(g.pos || '').slice(0, 160) }));
  out.en = d.en === true;
  return out;
}

// Order of photos / art files chosen on the page (dragged; the first is the cover).
// order: ['f:<file id>' | 'u:<n>'] for one kind, where u:n is the n-th new upload of that kind.
// Returns a position for every kept file (by id) and every upload (by index); anything not listed keeps its turn after the listed ones.
export function arrange(order, keptIds, uploadCount) {
  const tokens = Array.isArray(order) ? order.filter((t) => typeof t === 'string') : [];
  const all = [...keptIds.map((id) => `f:${id}`), ...Array.from({ length: uploadCount }, (_, i) => `u:${i}`)];
  const seen = new Set();
  const listed = tokens.filter((t) => all.includes(t) && !seen.has(t) && seen.add(t));
  const ordered = [...listed, ...all.filter((t) => !seen.has(t))];
  return Object.fromEntries(ordered.map((t, i) => [t, i]));
}
