// Work sent to the PR team — sender side (submit.html, inbox.html)
// - POST /api/submissions                  multipart: data (JSON) + photo / attach / art (videos are links)
//                                          data.draftId: send a draft (drafts.mjs) — its files (minus data.removeFiles) come along
//                                          data.order = { photo: ['f:<file id>' | 'u:<n>'], art: [...] }: the order chosen on the page, first = cover
// - GET  /api/submissions                  my work, newest first (inbox list)
// - GET  /api/submissions/:ref             one item with its form fields and files
// - PUT  /api/submissions/:ref             resend after "revise": multipart, data.removeFiles = [file id], data.order as above
// - POST /api/submissions/:ref/messages    { text }
// - POST /api/submissions/:ref/read
// - GET  /api/files/:id[?v=web]            a file of a submission (sender or PR)
import { Router } from 'express';
import { isPr, isUniversity, onboarded, requireUser } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { findDraft } from './drafts.mjs';
import { abs, acceptUpload, moveStored, removeDraftDir, removeStored, removeSubmissionDir, removeTemp, storeUploads, webPath } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { toPrTeam } from './notify.mjs';
import { limit } from './security.mjs';
import { arrange, audienceLabel, checkSubmission } from './rules.mjs';

const COLUMNS = ['type', 'title', 'lead', 'description', 'body', 'event_date', 'place', 'unit', 'categories', 'content_mode',
  'people', 'credit', 'news_video_url', 'news_video_platform', 'video_mode', 'video_url', 'video_platform',
  'title_en', 'body_en', 'audience', 'note', 'album_url', 'designer', 'producer'];
const firstStatus = (row) => (row.type === 'news' && row.content_mode === 'pr' ? 'writing' : 'review');
const countKinds = (files) => files.reduce((c, f) => ({ ...c, [f.kind]: (c[f.kind] || 0) + 1 }), { photo: 0, attach: 0, art: 0 });
// Positions for files already there (kept: [{ id, kind }]) and the new ones (stored, in upload order), per kind, from data.order
function positions(order, kept, stored) {
  const out = new Map();
  for (const kind of ['photo', 'attach', 'art']) {
    const k = kept.filter((f) => f.kind === kind), n = stored.filter((f) => f.kind === kind);
    const pos = arrange(order?.[kind], k.map((f) => f.id), n.length);
    k.forEach((f) => out.set(f.id, pos[`f:${f.id}`]));
    n.forEach((f, i) => out.set(f.id, pos[`u:${i}`]));
  }
  return out;
}

// Undoes moveStored (a failed send of a draft)
async function moveBack({ from, to }) {
  const { rename } = await import('node:fs/promises');
  await rename(abs(to), abs(from)).catch(() => {});
  await rename(abs(webPath(to)), abs(webPath(from))).catch(() => {});
}

// ---- Loading and shaping (shared with pr.mjs) ----
export async function loadThread(ids) {
  if (!ids.length) return { events: new Map(), messages: new Map(), files: new Map() };
  const group = (rows) => rows.reduce((m, r) => m.set(r.submission_id, [...(m.get(r.submission_id) || []), r]), new Map());
  const [ev, msg, files] = await Promise.all([
    query('select submission_id, status, at from submission_events where submission_id = any($1) order by at, id', [ids]),
    query('select submission_id, side, display_name, body, created_at from messages where submission_id = any($1) order by created_at, id', [ids]),
    query('select * from submission_files where submission_id = any($1) order by kind, position', [ids]),
  ]);
  return { events: group(ev.rows), messages: group(msg.rows), files: group(files.rows) };
}

// Files come ordered by kind, position; the first photo / art file is the cover
export const fileOut = (f, i, list) => ({
  id: f.id, kind: f.kind, name: f.name, size: Number(f.size), mime: f.mime,
  cover: (f.kind === 'photo' || f.kind === 'art') && list.findIndex((x) => x.kind === f.kind) === i,
  url: `/api/files/${f.id}`, ...(/^image\/(jpeg|png|webp)$/.test(f.mime) ? { thumb: `/api/files/${f.id}?v=web` } : {}),
});

// Same shape as the items in auth.js (window.SUBS), plus the form fields and files.
// `viewer` decides "from": 'me' for the sender's own messages.
export function submissionOut(s, t, viewer) {
  const pr = viewer === 'pr';
  return {
    id: s.id, ref: s.ref, type: s.type, status: s.status, title: s.title, unit: s.unit,
    audience: audienceLabel(s.audience), audienceValues: s.audience, prWrites: s.content_mode === 'pr',
    unread: pr ? s.pr_unread : s.sender_unread, sentAt: s.sent_at, updatedAt: s.updated_at,
    ...(s.news_id ? { newsId: s.news_id, url: `news.html?id=${s.news_id}` } : {}),
    history: (t.events.get(s.id) || []).map((e) => ({ status: e.status, at: e.at })),
    thread: (t.messages.get(s.id) || []).map((m) => ({
      from: pr ? m.side : m.side === 'sender' ? 'me' : 'pr', name: m.display_name, at: m.created_at, text: m.body,
    })),
    files: (t.files.get(s.id) || []).map(fileOut),
    ...(s.files_purged_at ? { filesRemovedAt: s.files_purged_at } : {}),
    fields: {
      lead: s.lead, desc: s.description, body: s.body, eventDate: s.event_date, place: s.place, categories: s.categories,
      contentMode: s.content_mode, people: s.people, credit: s.credit, newsVideo: s.news_video_url, newsPlatform: s.news_video_platform,
      videoMode: s.video_mode, videoLink: s.video_url, videoPlatform: s.video_platform, titleEn: s.title_en, bodyEn: s.body_en, note: s.note, albumUrl: s.album_url, designer: s.designer, producer: s.producer,
    },
  };
}

// A submission the user may see: their own, or any for PR
export async function findSubmission(ref, user) {
  const s = await one('select * from submissions where ref = $1', [ref]);
  if (!s || (s.sender_id !== user.id && !isPr(user))) throw new HttpError(404, 'ไม่พบงานนี้');
  return s;
}

export async function addMessage(client, s, user, side, text) {
  const body = str(text, 2000, 'ข้อความ');
  if (!body) throw new HttpError(400, 'พิมพ์ข้อความก่อนส่ง');
  const name = side === 'pr' ? 'งานประชาสัมพันธ์' : user.name || 'ผู้ส่ง';
  await client.query('insert into messages (submission_id, author_id, side, display_name, body) values ($1, $2, $3, $4, $5)', [s.id, user.id, side, name, body]);
  await client.query(side === 'pr' ? 'update submissions set sender_unread = true where id = $1' : 'update submissions set pr_unread = true where id = $1', [s.id]);
}

export async function sendFile(req, res, f) {
  const web = req.query.v === 'web' && /^image\//.test(f.mime);
  const path = abs(web ? webPath(f.path) : f.path);
  const inline = /^(image\/(jpeg|png|webp)|application\/pdf|video\/)/.test(f.mime);
  res.set('Cache-Control', 'private, max-age=3600');
  if (!web) res.attachment(f.name);
  if (inline && !web) res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.sendFile(path, { headers: { 'Content-Type': web ? 'image/webp' : f.mime } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'ไม่พบไฟล์' });
  });
}

// ---- Routes ----
export const router = Router();

// Uploads and messages per account
const MIN10 = 10 * 60 * 1000;
const uploads = limit('upload', { max: 30, windowMs: MIN10, message: 'ส่งงานบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่ ข้อมูลในฟอร์มยังอยู่ครบ' });
const messages = limit('message', { max: 40, windowMs: MIN10, message: 'ส่งข้อความบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });

router.post('/submissions', requireUser, uploads, acceptUpload, async (req, res) => {
  const user = req.user;
  try {
    if (!isUniversity(user)) throw new HttpError(403, 'การส่งงานเปิดให้บุคลากรและนักศึกษาของมหาวิทยาลัย');
    if (!onboarded(user)) throw new HttpError(403, 'กรุณากรอกโปรไฟล์ (ชื่อ เบอร์โทรศัพท์ และสังกัด) ให้ครบก่อนส่งงาน');
    // Sending a draft: its files count as attached (those the sender removed on the page excepted)
    const draft = req.data?.draftId ? await findDraft(req.data.draftId, user) : null;
    const remove = new Set(Array.isArray(req.data?.removeFiles) ? req.data.removeFiles : []);
    const fromDraft = draft ? (await query('select * from draft_files where draft_id = $1', [draft.id])).rows.filter((f) => !remove.has(f.id)) : [];
    const row = checkSubmission(user, req.data, countKinds([...fromDraft, ...req.uploads]));
    let moved = [];
    const created = await tx(async (c) => {
      // The draft is taken once: a second send of the same draft finds it gone
      if (draft && !(await c.query('delete from submission_drafts where id = $1 returning id', [draft.id])).rows.length) throw new HttpError(409, 'ร่างนี้ถูกส่งไปแล้ว');
      const values = COLUMNS.map((k) => (k === 'people' ? JSON.stringify(row[k]) : row[k]));
      const s = (await c.query(
        `insert into submissions (ref, status, sender_id, ${COLUMNS.join(', ')})
         values (next_ref($1), $2, $3, ${COLUMNS.map((_, i) => `$${i + 4}`).join(', ')}) returning *`,
        [row.type, firstStatus(row), user.id, ...values],
      )).rows[0];
      await c.query(`insert into submission_events (submission_id, status, actor_id, at) values ($1, 'sent', $3, $4), ($1, $2, $3, $4)`, [s.id, s.status, user.id, s.sent_at]);
      if (row.note) await c.query(`insert into messages (submission_id, author_id, side, display_name, body) values ($1, $2, 'sender', $3, $4)`, [s.id, user.id, user.name || 'ผู้ส่ง', row.note]);
      await toPrTeam(c, 'pr.new', s, user, row.note || undefined);
      try {
        const files = await storeUploads(s.id, req.uploads);
        for (const f of fromDraft) { moved.push({ from: f.path, to: await moveStored(f.path, s.id) }); f.path = moved.at(-1).to; }
        const pos = positions(req.data.order, fromDraft, files);
        for (const f of [...fromDraft, ...files]) {
          await c.query('insert into submission_files (id, submission_id, kind, path, name, size, mime, position) values ($1, $2, $3, $4, $5, $6, $7, $8)',
            [f.id, s.id, f.kind, f.path, f.name, f.size, f.mime, pos.get(f.id)]);
        }
      } catch (err) {
        // Draft files go back where they were (the draft row comes back with the rollback), the new ones go
        for (const m of moved) await moveBack(m);
        await removeSubmissionDir(s.id);
        throw err;
      }
      return s;
    });
    if (draft) await removeDraftDir(draft.id); // what is left: web copies of removed files and the like
    res.status(201).json({ submission: submissionOut(created, await loadThread([created.id]), 'sender') });
  } catch (err) {
    await removeTemp(req.uploads || []);
    throw err;
  }
});

router.get('/submissions', requireUser, async (req, res) => {
  const rows = (await query('select * from submissions where sender_id = $1 order by sent_at desc', [req.user.id])).rows;
  const t = await loadThread(rows.map((r) => r.id));
  res.json({ submissions: rows.map((s) => submissionOut(s, t, 'sender')), unread: rows.filter((r) => r.sender_unread).length });
});

router.get('/submissions/:ref', requireUser, async (req, res) => {
  const s = await findSubmission(req.params.ref, req.user);
  res.json({ submission: submissionOut(s, await loadThread([s.id]), s.sender_id === req.user.id ? 'sender' : 'pr') });
});

router.put('/submissions/:ref', requireUser, uploads, acceptUpload, async (req, res) => {
  try {
    const s = await one('select * from submissions where ref = $1 and sender_id = $2', [req.params.ref, req.user.id]);
    if (!s) throw new HttpError(404, 'ไม่พบงานนี้');
    if (s.status !== 'revise') throw new HttpError(409, 'แก้ไขงานได้เมื่อ PR ขอให้แก้ไขเท่านั้น');
    const d = { ...req.data, type: s.type };
    const current = (await query('select * from submission_files where submission_id = $1', [s.id])).rows;
    const remove = new Set(Array.isArray(d.removeFiles) ? d.removeFiles : []);
    const keep = current.filter((f) => !remove.has(f.id));
    const row = checkSubmission(req.user, d, countKinds([...keep, ...req.uploads]));
    const gone = current.filter((f) => remove.has(f.id));
    const files = await storeUploads(s.id, req.uploads);
    const pos = positions(d.order, keep, files);
    let updated;
    try {
      updated = await tx(async (c) => {
        const sets = COLUMNS.filter((k) => k !== 'type').map((k, i) => `${k} = $${i + 3}`).join(', ');
        const values = COLUMNS.filter((k) => k !== 'type').map((k) => (k === 'people' ? JSON.stringify(row[k]) : row[k]));
        const u = (await c.query(`update submissions set status = $2, pr_unread = true, sender_unread = false, ${sets} where id = $1 returning *`, [s.id, firstStatus(row), ...values])).rows[0];
        await c.query(`insert into submission_events (submission_id, status, actor_id) values ($1, 'resent', $3), ($1, $2, $3)`, [s.id, u.status, req.user.id]);
        await toPrTeam(c, 'pr.resent', u, req.user, row.note || undefined);
        if (gone.length) await c.query('delete from submission_files where id = any($1)', [gone.map((f) => f.id)]);
        for (const f of keep) await c.query('update submission_files set position = $2 where id = $1', [f.id, pos.get(f.id)]);
        for (const f of files) {
          await c.query('insert into submission_files (id, submission_id, kind, path, name, size, mime, position) values ($1, $2, $3, $4, $5, $6, $7, $8)',
            [f.id, s.id, f.kind, f.path, f.name, f.size, f.mime, pos.get(f.id)]);
        }
        return u;
      });
    } catch (err) {
      await Promise.all(files.map((f) => removeStored(f.path)));
      throw err;
    }
    await Promise.all(gone.map((f) => removeStored(f.path)));
    res.json({ submission: submissionOut(updated, await loadThread([s.id]), 'sender') });
  } catch (err) {
    await removeTemp(req.uploads || []);
    throw err;
  }
});

router.post('/submissions/:ref/messages', requireUser, messages, async (req, res) => {
  const s = await findSubmission(req.params.ref, req.user);
  if (s.sender_id !== req.user.id) throw new HttpError(403, 'ทีม PR ตอบผ่านหน้าจัดการงาน');
  await tx(async (c) => {
    await addMessage(c, s, req.user, 'sender', req.body?.text);
    await toPrTeam(c, 'pr.message', s, req.user, str(req.body?.text, 2000, 'ข้อความ'));
  });
  const fresh = await one('select * from submissions where id = $1', [s.id]);
  res.status(201).json({ submission: submissionOut(fresh, await loadThread([s.id]), 'sender') });
});

router.post('/submissions/:ref/read', requireUser, async (req, res) => {
  await query('update submissions set sender_unread = false where ref = $1 and sender_id = $2', [req.params.ref, req.user.id]);
  res.json({ ok: true });
});

router.get('/files/:id', requireUser, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'ไม่พบไฟล์');
  const f = await one('select f.*, s.sender_id from submission_files f join submissions s on s.id = f.submission_id where f.id = $1', [req.params.id]);
  if (!f || (f.sender_id !== req.user.id && !isPr(req.user))) throw new HttpError(404, 'ไม่พบไฟล์');
  await sendFile(req, res, f);
});
