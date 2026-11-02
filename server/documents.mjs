// คลังเอกสาร (SPEC.md Phase 2, rights in access.mjs): files of the PR team, gathered into งาน and kept with every version they have had.
// - GET  /api/document-works?q=&category=&type=&level=&year=&round=&person=&archived=1&page=&perPage=
//                                                     งาน with the documents the user may see, latest change first; q as in thai.mjs
//                                                     year is Buddhist-era, of the document's date; years lists those that can be chosen
//                                                     total counts all that match; perPage is 1 to 100 (100 when left out)
//                                                     round: รอบประเมิน 1 (Apr-Sep) or 2 (Oct-Mar). With a year, round 2 runs from October of that year to March of the next
// - GET  /api/document-works/people?q=                who can be named on a งาน: PR and admin
// - GET  /api/document-works/:id                      with its documents the user may see, without those taken out
// - GET  /api/document-works/photo/:id.webp           the profile photo of someone who can be named (pages load nothing from outside)
// - PUT  /api/document-works/:id                      { workTitle, peopleIds }
// - GET  /api/documents/:id                           with its versions
// - POST /api/documents                               multipart: file + data (JSON { title, category, unitName, docDate, tags, accessLevel,
//                                                     and workId, or workTitle and peopleIds for a new งาน })
// - PUT  /api/documents/:id                           { title, category, unitName, docDate, tags, accessLevel }: the details, not the file
//                                                     with workTitle and peopleIds its งาน changes too, in the same save
// - POST /api/documents/:id/versions                  multipart: file. It becomes the current one.
// - POST /api/documents/:id/archive · restore         ลบ on the page, for the uploader and admin: it leaves every list, the file stays, because the office keeps its records.
// - GET  /api/documents/:id/file?version=             always a download, never shown in the browser
// accessLevel team: PR and admin; private: the uploader and admin, who alone may change it. ผู้เกี่ยวข้อง give no rights.
// The search does not look inside files.
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireModule } from './access.mjs';
import { audit } from './audit.mjs';
import { isAdmin } from './auth.mjs';
import { UUID } from './calendar.mjs';
import { googlePhoto, photoSource, version as photoVersion } from './contact.mjs';
import { one, query, tx } from './db.mjs';
import { UPLOAD_DIR, mimeOf, removeStored, removeTemp, sendMedia, storeDocument } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { limit, matchesName } from './security.mjs';
import { termConditions } from './thai.mjs';

const CATEGORIES = { university_order: 'คำสั่งมหาวิทยาลัย', unit_order: 'คำสั่งจากหน่วยงาน', request_memo: 'บันทึกขออนุเคราะห์จากหน่วยงาน', other: 'เอกสารอื่นๆ' };
const LEVELS = ['team', 'private'];
const FILE_TYPES = {
  pdf: ['application/pdf'], word: [mimeOf('a.docx')], excel: [mimeOf('a.xlsx')], powerpoint: [mimeOf('a.pptx')], image: ['image/jpeg', 'image/png'],
};
const MAX_PEOPLE = 5;
const MAX_PER_PAGE = 100;
const MB = 1024 * 1024;
const MAX_FILE = 20 * MB;
const MAX_IMAGE = 10 * MB;
const MAX_TAGS = 10;
const IMAGES = ['.jpg', '.jpeg', '.png'];
const ALLOWED = ['.pdf', '.docx', '.xlsx', '.pptx', ...IMAGES];
const SELECT = `select d.*, to_char(d.doc_date, 'YYYY-MM-DD') doc_day, v.file_name, v.mime, v.size, u.name uploader_name from documents d
  join document_versions v on v.document_id = d.id and v.version = d.version
  left join users u on u.id = v.uploaded_by`;

const allowed = requireModule('documents');
const upload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_FILE, files: 1, fields: 1, fieldSize: 16 * 1024 }, defParamCharset: 'utf8' }).single('file');
const uploads = limit('documents', { max: 60, windowMs: 10 * 60 * 1000 });

export const router = Router();

const documentOut = (d) => ({
  id: d.id, workId: d.work_id, title: d.title, category: d.category, unitName: d.unit_name, docDate: d.doc_day, tags: d.tags, accessLevel: d.access_level, version: d.version,
  fileName: d.file_name, mime: d.mime, size: Number(d.size), ownerId: d.uploaded_by, uploader: d.uploader_name || null, archivedAt: d.archived_at, createdAt: d.created_at, updatedAt: d.updated_at,
});
const versionOut = (v) => ({ version: v.version, fileName: v.file_name, mime: v.mime, size: Number(v.size), uploader: v.uploader_name || null, createdAt: v.created_at });
const searchText = (d, fileName) => [d.title, CATEGORIES[d.category], d.unit, ...d.tags, fileName].filter(Boolean).join('\n');

async function respond(res, id, status = 200) {
  const versions = (await query(`select v.*, u.name uploader_name from document_versions v left join users u on u.id = v.uploaded_by
    where v.document_id = $1 order by v.version desc`, [id])).rows;
  res.status(status).json({ document: { ...documentOut(await one(`${SELECT} where d.id = $1`, [id])), versions: versions.map(versionOut) } });
}

// Parses the upload and checks the file. Field errors under `file`, like the other fields.
function receive(req, res, next) {
  upload(req, res, async (err) => {
    const f = req.file;
    const fail = async (status, text) => {
      if (f) await removeTemp([f]);
      next(new HttpError(status, text, { file: text }));
    };
    try {
      if (err) return await fail(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `ไฟล์ใหญ่เกิน ${MAX_FILE / MB} MB` : 'อัปโหลดไฟล์ไม่สำเร็จ');
      if (f) {
        const ext = extname(f.originalname).toLowerCase();
        if (!ALLOWED.includes(ext)) return await fail(400, 'รับเฉพาะไฟล์ PDF, DOCX, XLSX, PPTX, JPG และ PNG');
        if (IMAGES.includes(ext) && f.size > MAX_IMAGE) return await fail(413, `ภาพใหญ่เกิน ${MAX_IMAGE / MB} MB`);
        // The content must be what the name says (a renamed .exe is not a .pdf)
        if (!(await matchesName(f.path, f.originalname))) return await fail(400, `ไฟล์นี้ไม่ใช่ ${ext.slice(1).toUpperCase()} จริง ตรวจไฟล์แล้วแนบใหม่`);
      }
      req.data = JSON.parse(req.body?.data || '{}');
      next();
    } catch (e) {
      if (e instanceof SyntaxError) return fail(400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
      if (f) await removeTemp([f]);
      next(e);
    }
  });
}
const needFile = (req) => { if (!req.file) throw new HttpError(400, 'เลือกไฟล์เอกสาร', { file: 'เลือกไฟล์เอกสาร' }); };

// Stores the file, then runs fn(client, row) in a transaction; if that fails the file goes too
async function withFile(id, f, fn) {
  const path = await storeDocument(id, f);
  // Control characters would stop Postgres; the name is only used for the download
  const row = { path, name: f.originalname.replace(/\p{Cc}/gu, '').slice(0, 255), mime: mimeOf(f.originalname), size: f.size };
  try {
    return await tx((c) => fn(c, row));
  } catch (err) {
    await removeStored(path);
    throw err;
  }
}
const addVersion = (c, id, version, f, user) => c.query(`insert into document_versions (document_id, version, file_path, file_name, mime, size, uploaded_by)
  values ($1, $2, $3, $4, $5, $6, $7)`, [id, version, f.path, f.name, f.mime, f.size, user.id]);

const validDate = (v) => typeof v === 'string' && /^(20\d\d)-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v);

// was: the document being edited, or null for a new one. Throws 400 with a field → message map.
function checkDocument(b, user, was = null) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลเอกสาร');
  const errors = {};
  const row = { title: str(b.title, 200, 'ชื่อเอกสาร'), category: b.category, unit: str(b.unitName, 200, 'ชื่อหน่วยงาน'), tags: [], level: b.accessLevel ?? was?.access_level ?? 'team' };
  if (!row.title) errors.title = 'กรอกชื่อเอกสาร';
  if (!Object.hasOwn(CATEGORIES, row.category)) errors.category = 'เลือกหมวดเอกสาร';
  if (b.docDate != null && !validDate(b.docDate)) errors.docDate = 'เลือกวันที่เอกสารลงนาม';
  row.date = b.docDate ?? null;
  if (row.category !== 'unit_order') row.unit = null;
  else if (!row.unit) errors.unitName = 'กรอกชื่อหน่วยงาน';
  if (!LEVELS.includes(row.level)) errors.accessLevel = 'เลือกว่าเป็นเอกสารของทีมหรือส่วนตัว';
  // documents.html no longer asks for tags: left out, they stay as they were
  if (b.tags === undefined) row.tags = was?.tags ?? [];
  else if (Array.isArray(b.tags)) {
    row.tags = [...new Set(b.tags.map((t) => str(t, 50, 'แท็ก')).filter(Boolean))];
    if (row.tags.length > MAX_TAGS) errors.tags = `ใส่แท็กได้ไม่เกิน ${MAX_TAGS} คำ`;
  } else errors.tags = 'แท็กไม่ถูกต้อง';
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  if (was && row.level !== was.access_level && !isAdmin(user) && was.uploaded_by !== user.id) throw new HttpError(403, 'เปลี่ยนเป็นเอกสารของทีมหรือส่วนตัวได้เฉพาะผู้อัปโหลดและผู้ดูแลระบบ');
  return row;
}

// Throws 400 with a field → message map. People must be PR or admin accounts.
async function checkWork(b) {
  const errors = {};
  const title = str(b.workTitle, 200, 'ชื่องาน');
  const people = Array.isArray(b.peopleIds ?? []) ? b.peopleIds ?? [] : null;
  if (!title) errors.workTitle = 'กรอกชื่องาน';
  if (!people || people.length > MAX_PEOPLE) errors.people = `ระบุผู้เกี่ยวข้องได้ไม่เกิน ${MAX_PEOPLE} คน`;
  else if (people.some((p) => typeof p !== 'string' || !UUID.test(p))) errors.people = 'ไม่พบบางคนที่เลือก';
  else if (new Set(people).size < people.length) errors.people = 'เลือกคนเดียวกันซ้ำ';
  else if (people.length && (await one(`select count(*)::int n from users where id = any($1::uuid[]) and role in ('pr', 'admin') and erased_at is null`, [people])).n < people.length) {
    errors.people = 'ผู้เกี่ยวข้องต้องเป็นทีม PR หรือผู้ดูแลระบบ';
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  return { title, people };
}
async function setPeople(c, workId, people) {
  await c.query('delete from document_work_people where work_id = $1', [workId]);
  for (const id of people) await c.query('insert into document_work_people (work_id, user_id) values ($1, $2)', [workId, id]);
}
const peopleOf = async (ids) => (await query(`select p.work_id, u.id, u.name, u.email, u.photo_path, u.avatar_url from document_work_people p join users u on u.id = p.user_id
  where p.work_id = any($1::uuid[]) order by u.name`, [ids])).rows;
const personOut = (p) => {
  const src = photoSource(p);
  return { id: p.id, name: p.name || p.email, photo: src ? `/api/document-works/photo/${p.id}.webp?v=${photoVersion(src)}` : null };
};

// A งาน can be used through a document the user may see. Only someone else's private documents: refused.
async function workFor(id, user) {
  const w = UUID.test(id) ? await one('select * from document_works where id = $1', [id]) : null;
  if (!w) throw new HttpError(404, 'ไม่พบงานนี้');
  if (!(await one(`select 1 from documents where work_id = $1 and ($2 or access_level = 'team' or uploaded_by = $3) limit 1`, [id, isAdmin(user), user.id]))) throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ใช้งานนี้');
  return w;
}

const denied = (d, user) => d.access_level === 'private' && !isAdmin(user) && d.uploaded_by !== user.id;
function mayUse(d, user) {
  if (!d) throw new HttpError(404, 'ไม่พบเอกสารนี้');
  if (denied(d, user)) throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ใช้เอกสารนี้');
}
const openOnly = (d) => { if (d.archived_at) throw new HttpError(409, 'เอกสารนี้อยู่ในคลังเก็บแล้ว นำออกจากคลังก่อน'); };
// The document, held until the transaction ends
async function held(c, id, user) {
  const d = UUID.test(id) ? (await c.query('select * from documents where id = $1 for update', [id])).rows[0] : null;
  mayUse(d, user);
  return d;
}
const found = async (id, user) => {
  const d = UUID.test(id) ? await one('select * from documents where id = $1', [id]) : null;
  mayUse(d, user);
  return d;
};

router.get('/document-works', allowed, async (req, res) => {
  const { category, type, level, year, round, person } = /** @type {Record<string, string>} */ (req.query);
  if (category !== undefined && !Object.hasOwn(CATEGORIES, category)) throw new HttpError(400, 'เลือกหมวดเอกสารให้ถูกต้อง');
  if (type !== undefined && !Object.hasOwn(FILE_TYPES, type)) throw new HttpError(400, 'เลือกชนิดไฟล์ให้ถูกต้อง');
  if (level !== undefined && !LEVELS.includes(level)) throw new HttpError(400, 'เลือกทีมหรือส่วนตัวให้ถูกต้อง');
  if (year !== undefined && !/^\d{4}$/.test(year)) throw new HttpError(400, 'เลือกปีให้ถูกต้อง');
  const page = Number(req.query.page ?? 1), perPage = Number(req.query.perPage ?? MAX_PER_PAGE);
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw new HttpError(400, 'เลือกหน้าให้ถูกต้อง');
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) throw new HttpError(400, 'เลือกจำนวนต่อหน้าให้ถูกต้อง');
  if (round !== undefined && !['1', '2'].includes(round)) throw new HttpError(400, 'เลือกรอบประเมินให้ถูกต้อง');
  if (person !== undefined && !UUID.test(person)) throw new HttpError(400, 'เลือกผู้เกี่ยวข้องให้ถูกต้อง');
  const params = [isAdmin(req.user), req.user.id, req.query.archived === '1', category ?? null, type ? FILE_TYPES[type] : null, level ?? null, year ? Number(year) - 543 : null, person ?? null, round ? Number(round) : null];
  const anywhere = (s) => {
    params.push(`%${s.replace(/[\\%_]/g, '\\$&')}%`);
    return `(s.search_text || ' ' || w.title || ' ' || coalesce(n.names, '')) ilike $${params.length}`;
  };
  const terms = termConditions(str(req.query.q, 100, 'คำค้น') ?? '', anywhere);
  const matching = `with seen as (
      ${SELECT} where ($1 or d.access_level = 'team' or d.uploaded_by = $2) and (d.archived_at is not null) = $3 and ($4::text is null or d.category = $4)
        and ($5::text[] is null or v.mime = any($5)) and ($6::text is null or d.access_level = $6)
        and ($7::int is null or extract(year from d.doc_date - ($9::int is not null)::int * interval '3 months') = $7)
        and ($9::int is null or (extract(month from d.doc_date) between 4 and 9) = ($9 = 1))
        and ($8::uuid is null or exists (select 1 from document_work_people p where p.work_id = d.work_id and p.user_id = $8))
    ), found as (
      select s.work_id, max(s.doc_date) signed, max(s.updated_at) latest from seen s join document_works w on w.id = s.work_id
      left join lateral (select string_agg(u.name, ' ') names from document_work_people p join users u on u.id = p.user_id where p.work_id = w.id) n on true
      where true ${terms.map((t) => `and ${t}`).join(' ')} group by s.work_id
    )`;
  const { total } = await one(`${matching} select count(*)::int total from found`, params);
  const rows = (await query(`${matching}, hits as (select * from found order by signed desc, latest desc, work_id limit $${params.length + 1} offset $${params.length + 2})
    select s.*, w.title work_title, h.latest from seen s join hits h on h.work_id = s.work_id join document_works w on w.id = s.work_id
    order by h.signed desc, h.latest desc, h.work_id, s.created_at`, [...params, perPage, (page - 1) * perPage])).rows;
  const works = new Map();
  for (const d of rows) {
    if (!works.has(d.work_id)) works.set(d.work_id, { id: d.work_id, title: d.work_title, updatedAt: d.latest, people: [], documents: [] });
    works.get(d.work_id).documents.push(documentOut(d));
  }
  for (const p of await peopleOf([...works.keys()])) works.get(p.work_id).people.push(personOut(p));
  // January to March also belong to round 2 of the year before
  const years = (await query(`select distinct extract(year from t.day)::int + 543 y from documents, lateral (values (doc_date::timestamp), (doc_date - interval '3 months')) t(day)
    where $1 or access_level = 'team' or uploaded_by = $2 order by y desc`, [isAdmin(req.user), req.user.id])).rows.map((r) => r.y);
  res.json({ items: [...works.values()], years, total, page, perPage });
});

router.get('/document-works/people', allowed, async (req, res) => {
  const q = str(req.query.q, 100, 'คำค้น');
  const rows = (await query(`select id, name, email, photo_path, avatar_url from users where role in ('pr', 'admin') and erased_at is null
    and ($1::text is null or name ilike $1 or email ilike $1) order by name, email limit 20`, [q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null])).rows;
  res.json({ items: rows.map(personOut) });
});

router.get('/document-works/photo/:file', allowed, async (req, res) => {
  const id = req.params.file.match(/^(.+)\.webp$/)?.[1];
  // Only someone who can be named on a งาน (not anyone's photo)
  const u = id && UUID.test(id) ? await one(`select photo_path, avatar_url from users where id = $1 and role in ('pr', 'admin') and erased_at is null`, [id]) : null;
  const src = u && photoSource(u);
  if (!src) return res.status(404).end();
  try {
    sendMedia(res, u.photo_path || await googlePhoto(src), 'private, max-age=86400');
  } catch {
    res.status(404).end();
  }
});

router.get('/document-works/:id', allowed, async (req, res) => {
  const w = await workFor(req.params.id, req.user);
  const rows = (await query(`${SELECT} where d.work_id = $1 and d.archived_at is null and ($2 or d.access_level = 'team' or d.uploaded_by = $3) order by d.created_at`, [w.id, isAdmin(req.user), req.user.id])).rows;
  res.json({ work: { id: w.id, title: w.title, updatedAt: w.updated_at, people: (await peopleOf([w.id])).map(personOut), documents: rows.map(documentOut) } });
});

router.put('/document-works/:id', allowed, async (req, res) => {
  const was = await workFor(req.params.id, req.user);
  const d = await checkWork(req.body ?? {});
  await tx(async (c) => {
    await c.query('update document_works set title = $2, updated_at = now() where id = $1', [was.id, d.title]);
    await setPeople(c, was.id, d.people);
    await audit(c, req.user, 'document.work', was.id, `แก้ไขงานเอกสาร ${d.title}`, { people: d.people.length });
  });
  res.json({ work: { id: was.id, title: d.title, people: (await peopleOf([was.id])).map(personOut) } });
});

router.get('/documents/:id', allowed, async (req, res) => {
  await found(req.params.id, req.user);
  await respond(res, req.params.id);
});

router.get('/documents/:id/file', allowed, async (req, res) => {
  const d = await found(req.params.id, req.user);
  const version = String(req.query.version ?? d.version);
  const v = /^\d{1,6}$/.test(version) ? await one('select file_path, file_name from document_versions where document_id = $1 and version = $2', [d.id, version]) : null;
  if (!v) throw new HttpError(404, 'ไม่พบเวอร์ชันนี้');
  sendMedia(res, v.file_path, 'private, no-store', v.file_name);
});

router.post('/documents', allowed, uploads, receive, async (req, res) => {
  const id = randomUUID();
  try {
    const d = checkDocument(req.data, req.user);
    needFile(req);
    const known = req.data.workId === undefined ? null : await workFor(req.data.workId, req.user);
    const fresh = known ? null : await checkWork({ ...req.data, workTitle: req.data.workTitle ?? d.title });
    await withFile(id, req.file, async (c, f) => {
      const workId = known?.id ?? randomUUID();
      if (known) await c.query('update document_works set updated_at = now() where id = $1', [workId]);
      else {
        await c.query('insert into document_works (id, title, created_by) values ($1, $2, $3)', [workId, fresh.title, req.user.id]);
        await setPeople(c, workId, fresh.people);
      }
      await c.query(`insert into documents (id, work_id, title, category, unit_name, tags, access_level, search_text, uploaded_by, doc_date)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::date, (now() at time zone 'Asia/Bangkok')::date))`,
        [id, workId, d.title, d.category, d.unit, d.tags, d.level, searchText(d, f.name), req.user.id, d.date]);
      await addVersion(c, id, 1, f, req.user);
      await audit(c, req.user, 'document.create', id, `เพิ่มเอกสาร ${d.title}`, { category: d.category, level: d.level });
    });
  } finally {
    if (req.file) await removeTemp([req.file]);
  }
  await respond(res, id, 201);
});

router.post('/documents/:id/versions', allowed, uploads, receive, async (req, res) => {
  const { id } = req.params;
  try {
    needFile(req);
    await found(id, req.user);
    await withFile(id, req.file, async (c, f) => {
      const d = await held(c, id, req.user);
      openOnly(d);
      const version = d.version + 1;
      await addVersion(c, id, version, f, req.user);
      await c.query('update documents set version = $2, search_text = $3, updated_at = now() where id = $1', [id, version, searchText({ ...d, unit: d.unit_name }, f.name)]);
      await audit(c, req.user, 'document.version', id, `เพิ่มเวอร์ชัน ${version} ของ ${d.title}`, { version });
    });
  } finally {
    if (req.file) await removeTemp([req.file]);
  }
  await respond(res, id, 201);
});

router.put('/documents/:id', allowed, async (req, res) => {
  const { id } = req.params;
  const work = req.body?.workTitle === undefined ? null : await checkWork(req.body);
  await tx(async (c) => {
    const was = await held(c, id, req.user);
    openOnly(was);
    const d = checkDocument(req.body, req.user, was);
    const { file_name: name } = (await c.query('select file_name from document_versions where document_id = $1 and version = $2', [id, was.version])).rows[0];
    await c.query('update documents set title = $2, category = $3, unit_name = $4, tags = $5, access_level = $6, search_text = $7, doc_date = coalesce($8::date, doc_date), updated_at = now() where id = $1',
      [id, d.title, d.category, d.unit, d.tags, d.level, searchText(d, name), d.date]);
    await audit(c, req.user, 'document.update', id, `แก้ไขเอกสาร ${d.title}`, { category: d.category, level: d.level });
    if (work) {
      await c.query('update document_works set title = $2, updated_at = now() where id = $1', [was.work_id, work.title]);
      await setPeople(c, was.work_id, work.people);
      await audit(c, req.user, 'document.work', was.work_id, `แก้ไขงานเอกสาร ${work.title}`, { people: work.people.length });
    }
  });
  await respond(res, id);
});

router.post('/documents/:id/archive', allowed, async (req, res) => {
  const { id } = req.params;
  await tx(async (c) => {
    const d = await held(c, id, req.user);
    if (!isAdmin(req.user) && d.uploaded_by !== req.user.id) throw new HttpError(403, 'ลบได้เฉพาะผู้อัปโหลดและผู้ดูแลระบบ');
    openOnly(d);
    await c.query('update documents set archived_at = now(), updated_at = now() where id = $1', [id]);
    await audit(c, req.user, 'document.archive', id, `ลบเอกสาร ${d.title} ออกจากคลัง`);
  });
  await respond(res, id);
});

router.post('/documents/:id/restore', allowed, async (req, res) => {
  const { id } = req.params;
  await tx(async (c) => {
    const d = await held(c, id, req.user);
    if (!d.archived_at) throw new HttpError(409, 'เอกสารนี้ไม่ได้อยู่ในคลังเก็บ');
    await c.query('update documents set archived_at = null, updated_at = now() where id = $1', [id]);
    await audit(c, req.user, 'document.restore', id, `กู้คืนเอกสาร ${d.title}`);
  });
  await respond(res, id);
});
