// Uploaded files on disk (UPLOAD_DIR)
//   tmp/                                  multer writes here first
//   submissions/{submission id}/{file id}.{ext}       original as sent, minus GPS location (exif.mjs, no re-encoding)
//   submissions/{submission id}/{file id}.web.webp    1600px copy of photos for previews
//   drafts/{draft id}/...                  the same for a draft (drafts.mjs); moved to submissions/ when it is sent
//   media/{news id}/...                    published story images (/media/..., audience checked in news.mjs)
//   documents/{document id}/{random id}.{ext}         every version of a document (documents.mjs)
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { stripGps } from './exif.mjs';
import { HttpError } from './http.mjs';
import { UPLOADS } from './rules.mjs';
import { matchesName } from './security.mjs';

// libvips keeps files it has read open in its cache; on Windows an open file cannot be renamed or deleted
// (withdrawn stories, erased accounts, the test cleanup). No cache: each file is closed when sharp is done with it.
sharp.cache(false);

export const UPLOAD_DIR = resolve(import.meta.dirname, '..', process.env.UPLOAD_DIR || 'uploads');
const TMP = join(UPLOAD_DIR, 'tmp');
mkdirSync(TMP, { recursive: true });

const MAX_FILES = Object.values(UPLOADS).reduce((n, u) => n + u.max, 0);
const MAX_BYTES = Math.max(...Object.values(UPLOADS).map((u) => u.maxBytes));
const WEB_SIZE = 1600;

// multipart/form-data: field "data" (JSON) + files in fields photo / attach / art
const parser = multer({
  storage: multer.diskStorage({
    destination: TMP,
    filename: (req, file, cb) => cb(null, randomUUID() + extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES, fields: 5, fieldSize: 1024 * 1024 },
  defParamCharset: 'utf8', // Thai file names
}).fields(Object.entries(UPLOADS).map(([name, u]) => ({ name, maxCount: u.max })));

export const removeTemp = (files) => Promise.all(files.map((f) => rm(f.path, { force: true })));

// Express middleware: parses the upload, checks each file against its slot, sets req.data and req.uploads
export function acceptUpload(req, res, next) {
  parser(req, res, async (err) => {
    const files = Object.entries(req.files || {}).flatMap(([kind, list]) => list.map((f) => ({ ...f, kind })));
    const fail = async (status, msg) => { await removeTemp(files); next(new HttpError(status, msg)); };
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return fail(413, 'ไฟล์มีขนาดใหญ่เกินกำหนด');
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return fail(400, 'จำนวนไฟล์เกินกำหนด');
      return fail(400, 'อัปโหลดไฟล์ไม่สำเร็จ');
    }
    for (const f of files) {
      const u = UPLOADS[f.kind];
      if (!u.accepts(f)) return fail(400, `ไม่รับไฟล์ ${f.originalname}`);
      if (f.size > u.maxBytes) return fail(413, `${f.originalname} ใหญ่เกิน ${Math.round(u.maxBytes / 1024 / 1024)} MB`);
      // The content must be what the name says (a renamed .exe is not a .pdf)
      if (!(await matchesName(f.path, f.originalname))) return fail(400, `${f.originalname} ไม่ใช่ไฟล์ ${extname(f.originalname).slice(1).toUpperCase()} จริง ตรวจไฟล์แล้วแนบใหม่`);
    }
    try {
      req.data = JSON.parse(req.body?.data || '{}');
    } catch {
      return fail(400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
    }
    req.uploads = files;
    next();
  });
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
};
export const mimeOf = (name) => MIME[extname(name).toLowerCase()] || 'application/octet-stream';
export const webPath = (path) => path.replace(/\.[^.]+$/, '.web.webp');
export const abs = (rel) => join(UPLOAD_DIR, rel);

// Moves temp uploads into the submission's (or draft's: folder 'drafts') folder. Photos that fail to decode are rejected.
// Returns rows for submission_files; on failure removes whatever it already moved.
export async function storeUploads(submissionId, uploads, startPositions = {}, folder = 'submissions') {
  const dir = join(folder, submissionId);
  await mkdir(abs(dir), { recursive: true });
  const pos = { ...startPositions };
  const rows = [];
  try {
    for (const f of uploads) {
      const id = randomUUID();
      const path = join(dir, id + extname(f.originalname).toLowerCase()).replaceAll('\\', '/');
      // Photos keep their quality and camera data, but not where they were taken. First, before sharp reads the file:
      // libvips keeps files it has read open for a while, and on Windows an open file cannot be written.
      if (/\.(jpe?g|png|webp|heic)$/i.test(f.originalname)) await stripGps(f.path);
      if (f.kind === 'photo' || f.kind === 'cover' || (f.kind === 'art' && /^image\/(jpeg|png|webp)$/.test(mimeOf(f.originalname)))) {
        try {
          await sharp(f.path).rotate().resize(WEB_SIZE, WEB_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(abs(webPath(path)));
        } catch {
          // HEIC is kept as the original only (no web copy); anything else that will not decode is not an image
          if (!/\.heic$/i.test(f.originalname)) throw new HttpError(400, `${f.originalname} ไม่ใช่ไฟล์ภาพที่ถูกต้อง`);
        }
      }
      await rename(f.path, abs(path));
      rows.push({ id, kind: f.kind, path, name: f.originalname.slice(0, 255), size: f.size, mime: mimeOf(f.originalname), position: (pos[f.kind] = (pos[f.kind] ?? -1) + 1) });
    }
  } catch (err) {
    await Promise.all(rows.map((r) => removeStored(r.path)));
    await removeTemp(uploads);
    throw err;
  }
  return rows;
}

// Moves a temp upload into the document's folder under a random name and returns the path. Pictures lose where they were taken.
export async function storeDocument(documentId, f) {
  const dir = join('documents', documentId);
  await mkdir(abs(dir), { recursive: true });
  if (/\.(jpe?g|png)$/i.test(f.originalname)) await stripGps(f.path);
  const path = join(dir, randomUUID() + extname(f.originalname).toLowerCase()).replaceAll('\\', '/');
  await rename(f.path, abs(path));
  return path;
}

export const removeStored = (path) => Promise.all([rm(abs(path), { force: true }), rm(abs(webPath(path)), { force: true })]);
export const removeSubmissionDir = (submissionId) => rm(abs(join('submissions', submissionId)), { recursive: true, force: true });
export const removeDraftDir = (draftId) => rm(abs(join('drafts', draftId)), { recursive: true, force: true });

// Moves a stored file (and its web copy) into another submission's folder; returns the new path
export async function moveStored(path, submissionId) {
  const dir = join('submissions', submissionId);
  await mkdir(abs(dir), { recursive: true });
  const to = join(dir, path.split('/').pop()).replaceAll('\\', '/');
  await rename(abs(path), abs(to));
  await rename(abs(webPath(path)), abs(webPath(to))).catch(() => {}); // documents have no web copy
  return to;
}

// Copies a submission photo into the media folder of a published story (served by news.mjs, which checks the audience):
//   {file id}.webp      1600px copy for the page
//   {file id}.full.jpg  full size for "download original", re-encoded so GPS and other EXIF data are dropped
export async function publishImage(newsId, file) {
  const dir = join('media', newsId);
  await mkdir(abs(dir), { recursive: true });
  const name = `${file.id}.webp`;
  const src = abs(webPath(file.path));
  try {
    await copyFile(src, abs(join(dir, name)));
  } catch {
    // no web copy (e.g. HEIC): convert the original if possible
    await sharp(abs(file.path)).rotate().resize(WEB_SIZE, WEB_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(abs(join(dir, name)))
      .catch(() => { throw new HttpError(400, `แปลงภาพ ${file.name} ไม่สำเร็จ เลือกภาพอื่นแทน`); });
  }
  // Without a full-size copy the page offers the 1600px one instead
  await sharp(abs(file.path)).rotate().jpeg({ quality: 90, mozjpeg: true }).toFile(abs(join(dir, `${file.id}.full.jpg`))).catch(() => {});
  return `${newsId}/${name}`;
}

// Stores an image that is not part of a submission (imported stories: an upload or a photo fetched from Facebook)
// in a story's media folder, the same two sizes as publishImage. Returns the path for news.cover_path / gallery.
export async function publishFile(newsId, srcAbs, name) {
  const dir = join('media', newsId);
  await mkdir(abs(dir), { recursive: true });
  const id = randomUUID();
  try {
    const img = sharp(srcAbs).rotate();
    await img.clone().resize(WEB_SIZE, WEB_SIZE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(abs(join(dir, `${id}.webp`)));
    await img.clone().jpeg({ quality: 90, mozjpeg: true }).toFile(abs(join(dir, `${id}.full.jpg`)));
  } catch {
    throw new HttpError(400, `${name} ไม่ใช่ไฟล์ภาพที่เปิดได้`);
  }
  return `${newsId}/${id}.webp`;
}
export const tempPath = (ext = '') => join(TMP, randomUUID() + ext);
// A published picture ("{newsId}/{id}.webp" as in news.cover_path / gallery) with its full-size and card-size copies
export const removeMedia = (rel) => {
  const base = abs(join('media', rel.replace(/\.webp$/, '')));
  return Promise.all(['.webp', '.full.jpg', '.w480.webp', '.w960.webp'].map((x) => rm(base + x, { force: true })));
};

// Sends a file under UPLOAD_DIR with the given cache policy (and as a download when downloadName is set)
export function sendMedia(res, rel, cacheControl, downloadName) {
  res.set('Cache-Control', cacheControl);
  if (downloadName) res.attachment(downloadName);
  res.sendFile(abs(rel), { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}
