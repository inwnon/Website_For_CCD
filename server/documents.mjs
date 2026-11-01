// คลังเอกสาร (SPEC.md Phase 2, rights in access.mjs): files of the PR team, kept with every version they have had.
// - GET  /api/documents?q=&category=&archived=1   the documents the user may see, latest change first; q as in thai.mjs
// - GET  /api/documents/:id                       with its versions
// - POST /api/documents                           multipart: file + data (JSON { title, category, tags, accessLevel })
// - PUT  /api/documents/:id                       { title, category, tags, accessLevel }: the details, not the file
// - POST /api/documents/:id/versions              multipart: file. It becomes the current one.
// - POST /api/documents/:id/archive · restore     hides it from the list and back. There is no delete: the office keeps its records.
// - GET  /api/documents/:id/file?version=         always a download, never shown in the browser
// accessLevel team: PR and admin; admin: admin only, and only an admin sets it. The search does not look inside files.
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireModule } from './access.mjs';
import { audit } from './audit.mjs';
import { isAdmin } from './auth.mjs';
import { UUID } from './calendar.mjs';
import { one, query, tx } from './db.mjs';
import { UPLOAD_DIR, mimeOf, removeStored, removeTemp, sendMedia, storeDocument } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { limit, matchesName } from './security.mjs';
import { termConditions } from './thai.mjs';

const CATEGORIES = { official: 'หนังสือราชการ', report: 'รายงาน', form: 'แบบฟอร์ม', media: 'สื่อประชาสัมพันธ์', other: 'อื่น ๆ' };
const LEVELS = ['team', 'admin'];
const MB = 1024 * 1024;
const MAX_FILE = 20 * MB;
const MAX_IMAGE = 10 * MB;
const MAX_TAGS = 10;
const IMAGES = ['.jpg', '.jpeg', '.png'];
const ALLOWED = ['.pdf', '.docx', '.xlsx', '.pptx', ...IMAGES];
const SELECT = `select d.*, v.file_name, v.mime, v.size, u.name uploader_name from documents d
  join document_versions v on v.document_id = d.id and v.version = d.version
  left join users u on u.id = v.uploaded_by`;

const allowed = requireModule('documents');
const upload = multer({ dest: join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_FILE, files: 1, fields: 1, fieldSize: 16 * 1024 }, defParamCharset: 'utf8' }).single('file');
const uploads = limit('documents', { max: 60, windowMs: 10 * 60 * 1000 });

export const router = Router();

const documentOut = (d) => ({
  id: d.id, title: d.title, category: d.category, tags: d.tags, accessLevel: d.access_level, version: d.version, fileName: d.file_name, mime: d.mime, size: Number(d.size),
  uploader: d.uploader_name || null, archivedAt: d.archived_at, createdAt: d.created_at, updatedAt: d.updated_at,
});
const versionOut = (v) => ({ version: v.version, fileName: v.file_name, mime: v.mime, size: Number(v.size), uploader: v.uploader_name || null, createdAt: v.created_at });
const searchText = (d, fileName) => [d.title, CATEGORIES[d.category], ...d.tags, fileName].join('\n');

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

// was: the document being edited, or null for a new one. Throws 400 with a field → message map.
function checkDocument(b, user, was = null) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'ไม่พบข้อมูลเอกสาร');
  const errors = {};
  const row = { title: str(b.title, 200, 'ชื่อเอกสาร'), category: b.category, tags: [], level: b.accessLevel ?? was?.access_level ?? 'team' };
  if (!row.title) errors.title = 'กรอกชื่อเอกสาร';
  if (!Object.hasOwn(CATEGORIES, row.category)) errors.category = 'เลือกหมวดเอกสาร';
  if (!LEVELS.includes(row.level)) errors.accessLevel = 'เลือกระดับการเข้าถึง';
  if (Array.isArray(b.tags ?? [])) {
    row.tags = [...new Set((b.tags ?? []).map((t) => str(t, 50, 'แท็ก')).filter(Boolean))];
    if (row.tags.length > MAX_TAGS) errors.tags = `ใส่แท็กได้ไม่เกิน ${MAX_TAGS} คำ`;
  } else errors.tags = 'แท็กไม่ถูกต้อง';
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  if (!isAdmin(user) && row.level !== (was?.access_level ?? 'team')) throw new HttpError(403, 'ระดับการเข้าถึงตั้งได้เฉพาะผู้ดูแลระบบ');
  return row;
}

const denied = (d, user) => d.access_level === 'admin' && !isAdmin(user);
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

router.get('/documents', allowed, async (req, res) => {
  const { category } = req.query;
  if (category !== undefined && !Object.hasOwn(CATEGORIES, /** @type {string} */ (category))) throw new HttpError(400, 'เลือกหมวดเอกสารให้ถูกต้อง');
  const params = [isAdmin(req.user), req.query.archived === '1', category ?? null];
  const anywhere = (s) => {
    params.push(`%${s.replace(/[\\%_]/g, '\\$&')}%`);
    return `d.search_text ilike $${params.length}`;
  };
  const terms = termConditions(str(req.query.q, 100, 'คำค้น') ?? '', anywhere);
  const rows = (await query(`${SELECT} where ($1 or d.access_level = 'team') and (d.archived_at is not null) = $2 and ($3::text is null or d.category = $3)
    ${terms.map((t) => `and ${t}`).join(' ')} order by d.updated_at desc limit 200`, params)).rows;
  res.json({ items: rows.map(documentOut) });
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
    await withFile(id, req.file, async (c, f) => {
      await c.query(`insert into documents (id, title, category, tags, access_level, search_text, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, d.title, d.category, d.tags, d.level, searchText(d, f.name), req.user.id]);
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
      await c.query('update documents set version = $2, search_text = $3, updated_at = now() where id = $1', [id, version, searchText(d, f.name)]);
      await audit(c, req.user, 'document.version', id, `เพิ่มเวอร์ชัน ${version} ของ ${d.title}`, { version });
    });
  } finally {
    if (req.file) await removeTemp([req.file]);
  }
  await respond(res, id, 201);
});

router.put('/documents/:id', allowed, async (req, res) => {
  const { id } = req.params;
  await tx(async (c) => {
    const was = await held(c, id, req.user);
    openOnly(was);
    const d = checkDocument(req.body, req.user, was);
    const { file_name: name } = (await c.query('select file_name from document_versions where document_id = $1 and version = $2', [id, was.version])).rows[0];
    await c.query('update documents set title = $2, category = $3, tags = $4, access_level = $5, search_text = $6, updated_at = now() where id = $1',
      [id, d.title, d.category, d.tags, d.level, searchText(d, name)]);
    await audit(c, req.user, 'document.update', id, `แก้ไขเอกสาร ${d.title}`, { category: d.category, level: d.level });
  });
  await respond(res, id);
});

router.post('/documents/:id/archive', allowed, async (req, res) => {
  const { id } = req.params;
  await tx(async (c) => {
    const d = await held(c, id, req.user);
    openOnly(d);
    await c.query('update documents set archived_at = now(), updated_at = now() where id = $1', [id]);
    await audit(c, req.user, 'document.archive', id, `เก็บเอกสาร ${d.title} เข้าคลัง`);
  });
  await respond(res, id);
});

router.post('/documents/:id/restore', allowed, async (req, res) => {
  const { id } = req.params;
  await tx(async (c) => {
    const d = await held(c, id, req.user);
    if (!d.archived_at) throw new HttpError(409, 'เอกสารนี้ไม่ได้อยู่ในคลังเก็บ');
    await c.query('update documents set archived_at = null, updated_at = now() where id = $1', [id]);
    await audit(c, req.user, 'document.restore', id, `นำเอกสาร ${d.title} ออกจากคลัง`);
  });
  await respond(res, id);
});
