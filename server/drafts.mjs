// Drafts: work the sender saved with "บันทึกร่าง" (submit.html) and has not sent yet. Only the sender sees them.
// - GET    /api/drafts                    my drafts, last edited first (inbox.html "ข่าวของฉัน")
// - GET    /api/drafts/:id                one draft: the form fields and its files
// - POST   /api/drafts                    multipart: data (JSON, the form as submit.html sends it) + photo / attach / art
// - PUT    /api/drafts/:id                the same; data.removeFiles = [file id], data.order = { photo: [...], art: [...] }
// - DELETE /api/drafts/:id
// - GET    /api/drafts/:id/files/:fileId[?v=web]
// Sending a draft is POST /api/submissions with data.draftId (submissions.mjs): its files move to the submission.
import { Router } from 'express';
import { isUniversity, requireUser } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { acceptUpload, removeDraftDir, removeStored, removeTemp, storeUploads } from './files.mjs';
import { HttpError } from './http.mjs';
import { arrange, draftData, UPLOADS } from './rules.mjs';
import { limit } from './security.mjs';
import { sendFile } from './submissions.mjs';

export const MAX_DRAFTS = 20;
const KINDS = ['photo', 'attach', 'art', 'cover'];

const fileOut = (draftId) => (f) => ({
  id: f.id, kind: f.kind, name: f.name, size: Number(f.size), mime: f.mime,
  url: `/api/drafts/${draftId}/files/${f.id}`, ...(/^image\/(jpeg|png|webp)$/.test(f.mime) ? { thumb: `/api/drafts/${draftId}/files/${f.id}?v=web` } : {}),
});
export const draftOut = (d, files) => {
  const own = files.filter((f) => f.draft_id === d.id);
  const cover = own.find((f) => f.kind === ({ banner: 'art', video: 'cover' }[d.type] || 'photo') && /^image\/(jpeg|png|webp)$/.test(f.mime));
  return {
    id: d.id, type: d.type, title: d.title, createdAt: d.created_at, updatedAt: d.updated_at,
    counts: Object.fromEntries(KINDS.map((k) => [k, own.filter((f) => f.kind === k).length])),
    ...(cover ? { thumb: `/api/drafts/${d.id}/files/${cover.id}?v=web` } : {}),
  };
};
const filesOf = async (ids) => (ids.length ? (await query('select * from draft_files where draft_id = any($1) order by kind, position', [ids])).rows : []);

// The sender's own draft, or 404
export async function findDraft(id, user, client = { query }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new HttpError(404, 'ไม่พบร่างนี้');
  const d = (await client.query('select * from submission_drafts where id = $1 and sender_id = $2', [id, user.id])).rows[0];
  if (!d) throw new HttpError(404, 'ไม่พบร่างนี้ อาจส่งไปแล้วหรือถูกลบ');
  return d;
}

// Files per kind after removals and new uploads must stay within the upload slots of the type
function checkFiles(type, kept, uploads) {
  for (const kind of KINDS) {
    const n = kept.filter((f) => f.kind === kind).length + uploads.filter((f) => f.kind === kind).length;
    if (n && !UPLOADS[kind].types.includes(type)) throw new HttpError(400, 'งานประเภทนี้ไม่รับไฟล์ชนิดนี้', { [kind]: 'งานประเภทนี้ไม่รับไฟล์ชนิดนี้' });
    if (n > UPLOADS[kind].max) throw new HttpError(400, `แนบได้ไม่เกิน ${UPLOADS[kind].max} ไฟล์`, { [kind]: `แนบได้ไม่เกิน ${UPLOADS[kind].max} ไฟล์` });
  }
}

// Stores new uploads in the draft folder and gives kept + new files the order chosen on the page
async function placeFiles(c, draftId, kept, uploads, order = {}) {
  const stored = await storeUploads(draftId, uploads, {}, 'drafts');
  for (const kind of KINDS) {
    const k = kept.filter((f) => f.kind === kind);
    const n = stored.filter((f) => f.kind === kind);
    const pos = arrange(order?.[kind], k.map((f) => f.id), n.length);
    for (const f of k) await c.query('update draft_files set position = $2 where id = $1', [f.id, pos[`f:${f.id}`]]);
    for (const [i, f] of n.entries()) {
      await c.query('insert into draft_files (id, draft_id, kind, path, name, size, mime, position) values ($1, $2, $3, $4, $5, $6, $7, $8)',
        [f.id, draftId, f.kind, f.path, f.name, f.size, f.mime, pos[`u:${i}`]]);
    }
  }
  return stored;
}

export const router = Router();
const saves = limit('draft', { max: 60, windowMs: 10 * 60 * 1000, message: 'บันทึกร่างบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });
const universityOnly = (req) => { if (!isUniversity(req.user)) throw new HttpError(403, 'การส่งงานเปิดให้บุคลากรและนักศึกษาของมหาวิทยาลัย'); };

router.get('/drafts', requireUser, async (req, res) => {
  const rows = (await query('select * from submission_drafts where sender_id = $1 order by updated_at desc', [req.user.id])).rows;
  const files = await filesOf(rows.map((d) => d.id));
  res.json({ drafts: rows.map((d) => draftOut(d, files)), max: MAX_DRAFTS });
});

router.get('/drafts/:id', requireUser, async (req, res) => {
  const d = await findDraft(req.params.id, req.user);
  const files = await filesOf([d.id]);
  res.json({ draft: { ...draftOut(d, files), data: d.data, files: files.map(fileOut(d.id)) } });
});

router.post('/drafts', requireUser, saves, acceptUpload, async (req, res) => {
  let stored = [];
  try {
    universityOnly(req);
    const data = draftData(req.data);
    checkFiles(data.type, [], req.uploads);
    const d = await tx(async (c) => {
      // One at a time per sender, so two quick saves cannot both pass the limit
      await c.query('select id from users where id = $1 for update', [req.user.id]);
      const n = (await c.query('select count(*)::int n from submission_drafts where sender_id = $1', [req.user.id])).rows[0].n;
      if (n >= MAX_DRAFTS) throw new HttpError(409, `เก็บร่างได้สูงสุด ${MAX_DRAFTS} ชิ้น ส่งหรือลบร่างเก่าที่หน้า "ข่าวของฉัน" ก่อน`);
      const row = (await c.query('insert into submission_drafts (sender_id, type, title, data) values ($1, $2, $3, $4) returning *',
        [req.user.id, data.type, data.title || '', data])).rows[0];
      stored = await placeFiles(c, row.id, [], req.uploads, req.data.order);
      return row;
    });
    res.status(201).json({ draft: draftOut(d, await filesOf([d.id])) });
  } catch (err) {
    await Promise.all(stored.map((f) => removeStored(f.path)));
    await removeTemp(req.uploads || []);
    throw err;
  }
});

router.put('/drafts/:id', requireUser, saves, acceptUpload, async (req, res) => {
  let stored = [], gone = [];
  try {
    universityOnly(req);
    const draft = await findDraft(req.params.id, req.user);
    // The type of a draft can change while it is a draft; files the new type cannot take must be removed first
    const data = draftData(req.data);
    const remove = new Set(Array.isArray(req.data.removeFiles) ? req.data.removeFiles : []);
    const d = await tx(async (c) => {
      const current = (await c.query('select * from draft_files where draft_id = $1 for update', [draft.id])).rows;
      const kept = current.filter((f) => !remove.has(f.id));
      gone = current.filter((f) => remove.has(f.id));
      checkFiles(data.type, kept, req.uploads);
      if (gone.length) await c.query('delete from draft_files where id = any($1)', [gone.map((f) => f.id)]);
      stored = await placeFiles(c, draft.id, kept, req.uploads, req.data.order);
      return (await c.query('update submission_drafts set type = $2, title = $3, data = $4 where id = $1 returning *', [draft.id, data.type, data.title || '', data])).rows[0];
    });
    await Promise.all(gone.map((f) => removeStored(f.path)));
    res.json({ draft: draftOut(d, await filesOf([d.id])) });
  } catch (err) {
    await Promise.all(stored.map((f) => removeStored(f.path)));
    await removeTemp(req.uploads || []);
    throw err;
  }
});

router.delete('/drafts/:id', requireUser, async (req, res) => {
  const d = await findDraft(req.params.id, req.user);
  await query('delete from submission_drafts where id = $1', [d.id]);
  await removeDraftDir(d.id);
  res.json({ ok: true });
});

router.get('/drafts/:id/files/:fileId', requireUser, async (req, res) => {
  const d = await findDraft(req.params.id, req.user);
  if (!/^[0-9a-f-]{36}$/i.test(req.params.fileId)) throw new HttpError(404, 'ไม่พบไฟล์');
  const f = await one('select * from draft_files where id = $1 and draft_id = $2', [req.params.fileId, d.id]);
  if (!f) throw new HttpError(404, 'ไม่พบไฟล์');
  await sendFile(req, res, f);
});
