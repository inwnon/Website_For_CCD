// PR desk — everything here needs role pr or admin (pr.html)
// - GET    /api/pr/submissions?status=&type=&q=&unread=1&limit=&offset=   list + counts per status
// - GET    /api/pr/submissions/:ref                    full item, sender profile, published story
// - POST   /api/pr/submissions/:ref/unpublish          ยกเลิกการเผยแพร่: the story leaves the site, the work goes back to รอตรวจ;
//          publishing it again updates the same story (same link, reads and history kept)
// - POST   /api/pr/submissions/:ref/status             { status: review|writing|revise|rejected, message }
//   rejected = "ลบข่าว": hidden, not deleted. The sender no longer sees it and is not told; PR can move it back to review
//   (also without telling the sender). It still counts in reports, and its files go with the retention rule.
// - POST   /api/pr/submissions/:ref/messages           { text }
// - POST   /api/pr/submissions/:ref/read
// - PUT    /api/pr/submissions/:ref/edit               แก้ไขข่าว: PR's own version of work not yet published (pr_edit);
//          the sender does not see it, publishing starts from it
// - POST   /api/pr/submissions/:ref/publish            story fields → news row, status published
// - GET    /api/pr/config                              message templates and categories (settings)
// - GET    /api/pr/team · POST /api/pr/team { email, role } · DELETE /api/pr/team/:email   (changes: admin only)
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { domainRole, prUnreadCount, publicUser, requirePr } from './auth.mjs';
import { one, query, tx } from './db.mjs';
import { abs, publishImage, removeMedia } from './files.mjs';
import { HttpError, str } from './http.mjs';
import { AUDIENCES, MAX_CATS, SOLO_MSG, albumSet, albumUrl, audienceLabel, bodyLeading, bodySize, categories, soloOk, videoLinks } from './rules.mjs';
import { audit } from './audit.mjs';
import { prMessaged, statusChanged } from './notify.mjs';
import { limit } from './security.mjs';
import { get, VIDEO_CATEGORIES } from './settings.mjs';
import { addMessage, findSubmission, loadThread, submissionOut } from './submissions.mjs';

const STATUSES = ['review', 'writing', 'revise', 'published', 'rejected'];
const STATUS_TH = { review: 'รอ PR ตรวจ', writing: 'PR กำลังเขียนข่าว', revise: 'ขอให้แก้ไข', published: 'เผยแพร่แล้ว', rejected: 'ลบแล้ว' };
const PR_MOVES = ['review', 'writing', 'revise', 'rejected']; // "published" goes through /publish

export const router = Router();
// Everything under /pr is the PR team's, but /pr/import (newsdesk.mjs) and /pr/collections, which นักศึกษาฝึกงาน สสอ. may use too
router.use('/pr', (req, res, next) => (/^\/(import|collections)(\/|$)/.test(req.path) ? next() : requirePr(req, res, next)));

// แจ้งเตือนงานใหม่ (arrivals.js): work sent or sent again since `since` (at most a day back), newest first, and the
// server's time to ask from next, and unread: all work with something new for the PR team (the red badges).
// The back-office pages ask every 30 seconds (a tab in the background every 90).
router.get('/pr/arrivals', async (req, res) => {
  const now = new Date();
  const asked = new Date(String(req.query.since || ''));
  const since = Number.isNaN(asked.getTime()) ? now : new Date(Math.max(asked.getTime(), now.getTime() - 864e5));
  const rows = (await query(
    `select distinct on (s.id) s.ref, s.type, s.title, s.unit, e.status kind, e.at, coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.name, u.email) sender
     from submission_events e join submissions s on s.id = e.submission_id join users u on u.id = s.sender_id
     where e.status in ('sent', 'resent') and e.at > $1 and e.at <= $2 and s.status <> 'rejected'
     order by s.id, e.at desc limit 50`, [since, now])).rows.sort((a, b) => b.at - a.at);
  // คำขอใช้บริการ that came in over the same span: the most urgent, shown in the middle of the screen
  const asks = (await query(
    `select r.id, r.title, r.type, r.start_at, r.location, coalesce(nullif(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.name, u.email) requester
     from service_requests r left join users u on u.id = r.requester_id
     where r.status = 'pending' and r.created_at > $1 and r.created_at <= $2 order by r.created_at desc limit 20`, [since, now])).rows;
  res.json({
    now, unread: await prUnreadCount(),
    items: rows.map((r) => ({ ref: r.ref, type: r.type, title: r.title, unit: r.unit, again: r.kind === 'resent', at: r.at, sender: r.sender })),
    requests: asks.map((r) => ({ id: r.id, title: r.title, type: r.type, startAt: r.start_at, location: r.location, requester: r.requester })),
  });
});

router.get('/pr/submissions', async (req, res) => {
  const { status, type, q, unread } = /** @type {Record<string, any>} */ (req.query);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (type) add('s.type = ?', type);
  if (q) add(`(s.title ilike ? or s.ref ilike $${params.length + 1} or s.unit ilike $${params.length + 1} or u.name ilike $${params.length + 1})`, `%${String(q).slice(0, 100)}%`);
  const base = where.length ? `where ${where.join(' and ')}` : '';
  // Counts ignore the status / unread filters so the tabs always show their totals
  const counts = (await query(`select s.status, count(*)::int n, count(*) filter (where s.pr_unread)::int unread
    from submissions s join users u on u.id = s.sender_id ${base} group by s.status`, params)).rows;

  if (status && STATUSES.includes(status)) add('s.status = ?', status);
  else where.push("s.status <> 'rejected'"); // "ทั้งหมด": not what PR deleted (that has its own menu item)
  if (unread === '1') where.push('s.pr_unread');
  const filtered = where.length ? `where ${where.join(' and ')}` : '';
  const rows = (await query(
    `select s.*, u.name sender_name, u.email sender_email, u.role sender_role, u.position sender_position,
       (select count(*)::int from submission_files f where f.submission_id = s.id) file_count,
       (select f.id from submission_files f where f.submission_id = s.id and f.kind in ('photo', 'art', 'cover') and f.mime ~ '^image/(jpeg|png|webp)$'
          order by f.kind = 'photo' desc, f.position limit 1) cover_id,
       (select json_build_object('side', m.side, 'text', left(m.body, 160), 'at', m.created_at) from messages m
          where m.submission_id = s.id order by m.created_at desc, m.id desc limit 1) last_message,
       count(*) over ()::int total
     from submissions s join users u on u.id = s.sender_id ${filtered}
     order by s.pr_unread desc, s.updated_at desc limit ${limit} offset ${offset}`, params)).rows;

  res.json({
    total: rows[0]?.total ?? 0,
    counts: Object.fromEntries(STATUSES.map((st) => {
      const c = counts.find((x) => x.status === st);
      return [st, { total: c?.n ?? 0, unread: c?.unread ?? 0 }];
    })),
    items: rows.map((s) => ({
      ref: s.ref, type: s.type, status: s.status, title: s.title, unit: s.unit, audience: audienceLabel(s.audience),
      prWrites: s.content_mode === 'pr', eventDate: s.event_date, sentAt: s.sent_at, updatedAt: s.updated_at, unread: s.pr_unread,
      sender: { name: s.sender_name, email: s.sender_email, role: s.sender_role, position: s.sender_position },
      fileCount: s.file_count, thumb: s.cover_id ? `/api/files/${s.cover_id}?v=web` : null, lastMessage: s.last_message,
    })),
  });
});

async function detail(s) {
  const [t, sender, news] = await Promise.all([
    loadThread([s.id]),
    one('select * from users where id = $1', [s.sender_id]),
    s.news_id ? one(`select id, title, title_en, lead, body, body_en, categories, audience, video_url, album_url, album_links, featured, published_at,
      cover_path, withdrawn_at, body_size, body_leading from news where id = $1`, [s.news_id]) : null,
  ]);
  return { submission: submissionOut(s, t, 'pr'), sender: publicUser(sender), news, prEdit: s.pr_edit || null };
}

router.get('/pr/submissions/:ref', async (req, res) => {
  res.json(await detail(await findSubmission(req.params.ref, req.user)));
});

router.post('/pr/submissions/:ref/status', async (req, res) => {
  const s = await findSubmission(req.params.ref, req.user);
  const status = req.body?.status;
  const message = req.body?.message;
  if (!PR_MOVES.includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
  if (s.status === 'published') throw new HttpError(409, 'งานนี้เผยแพร่แล้ว แก้ไขที่ตัวข่าวแทน');
  if (status === s.status) throw new HttpError(409, 'งานอยู่ในสถานะนี้แล้ว');
  if (status === 'revise' && !str(message, 2000, 'ข้อความ')) throw new HttpError(400, 'บอกผู้ส่งว่าต้องแก้ไขอะไร');
  // Deleting (and bringing back) is between PR only: no message, no email, nothing new in the sender's inbox
  const quiet = status === 'rejected' || s.status === 'rejected';
  await tx(async (c) => {
    await c.query(`update submissions set status = $2, ${quiet ? '' : 'sender_unread = true, '}pr_unread = false where id = $1`, [s.id, status]);
    await c.query('insert into submission_events (submission_id, status, actor_id) values ($1, $2, $3)', [s.id, status, req.user.id]);
    if (!quiet) {
      if (str(message, 2000, 'ข้อความ')) await addMessage(c, s, req.user, 'pr', message);
      await statusChanged(c, s, status, str(message, 2000, 'ข้อความ'));
    }
    const summary = status === 'rejected' ? `ลบงาน ${s.ref}` : s.status === 'rejected' ? `กู้คืนงาน ${s.ref} ไปที่รอตรวจ` : `เปลี่ยนสถานะ ${s.ref} เป็น${STATUS_TH[status]}`;
    await audit(c, req.user, 'submission.status', s.ref, summary, { from: s.status, to: status });
  });
  res.json(await detail(await one('select * from submissions where id = $1', [s.id])));
});

// ยกเลิกการเผยแพร่: off the site (readers who open the link see that it is being updated), back in the queue for PR.
// The sender sees the work as รอ PR ตรวจ again; no email (PR will publish it again or tell them).
export const UNPUBLISH_REASON = 'ทีมประชาสัมพันธ์กำลังปรับปรุงข่าวนี้ และจะเผยแพร่อีกครั้งเร็ว ๆ นี้';
router.post('/pr/submissions/:ref/unpublish', async (req, res) => {
  const s = await findSubmission(req.params.ref, req.user);
  if (s.status !== 'published' || !s.news_id) throw new HttpError(409, 'งานนี้ยังไม่ได้เผยแพร่');
  await tx(async (c) => {
    await c.query('update news set withdrawn_at = now(), withdrawn_reason = $2, withdrawn_by = $3, featured = false where id = $1', [s.news_id, UNPUBLISH_REASON, req.user.id]);
    await c.query("update submissions set status = 'review', pr_unread = false where id = $1", [s.id]);
    await c.query("insert into submission_events (submission_id, status, actor_id) values ($1, 'unpublished', $2)", [s.id, req.user.id]);
    await audit(c, req.user, 'submission.unpublish', s.ref, `ยกเลิกการเผยแพร่ ${s.ref} กลับไปที่รอตรวจ`, { newsId: s.news_id });
  }, req.user);
  res.json(await detail(await one('select * from submissions where id = $1', [s.id])));
});

// แก้ไขข่าว: the PR team's own version of the work, kept until it is published (publishing starts from it).
// Nothing is required here; the checks run when it is published. A new version from the sender replaces it.
router.put('/pr/submissions/:ref/edit', async (req, res) => {
  const s = await findSubmission(req.params.ref, req.user);
  if (s.status === 'published') throw new HttpError(409, 'งานนี้เผยแพร่แล้ว แก้ไขที่ตัวข่าวแทน');
  if (s.status === 'rejected') throw new HttpError(409, 'งานนี้ถูกลบแล้ว กู้คืนไปที่รอตรวจก่อน');
  const b = req.body || {};
  const ids = new Set((await query("select id from submission_files where submission_id = $1 and kind in ('photo', 'art', 'cover')", [s.id])).rows.map((r) => r.id));
  const cats = Array.isArray(b.categories) ? [...new Set(b.categories)] : [];
  const errors = {};
  if (cats.length > MAX_CATS || !cats.every((c) => categories().includes(c))) errors.categories = 'ประเภทข่าวไม่ถูกต้อง';
  else if (!soloOk(cats)) errors.categories = SOLO_MSG;
  let album = null;
  try { album = albumUrl(b.albumUrl); } catch (err) { errors.albumUrl = err.details?.albumUrl || err.message; }
  // ลิงก์ภาพเพิ่มเติม after the first, as PR left them
  const albums = albumSet([album || '', ...(Array.isArray(b.albumLinks) ? b.albumLinks : [])].filter(Boolean));
  if (albums.error && !errors.albumUrl) errors.albumUrl = albums.error;
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);
  const edit = {
    title: str(b.title, 200, 'หัวข้อข่าว'), lead: str(b.lead, 300, 'สรุปข่าว'), body: str(b.body, 50000, 'เนื้อหาข่าว') || '',
    bodySize: bodySize(b.bodySize), bodyLeading: bodyLeading(b.bodyLeading),
    titleEn: str(b.titleEn, 200, 'หัวข้อภาษาอังกฤษ'), bodyEn: str(b.bodyEn, 50000, 'เนื้อหาภาษาอังกฤษ'),
    videoUrl: str(b.videoUrl, 500, 'ลิงก์วิดีโอ'), albumUrl: albums.url, albumLinks: albums.links, categories: cats,
    audience: Array.isArray(b.audience) ? [...new Set(b.audience)].filter((a) => AUDIENCES.includes(a)) : [],
    cover: ids.has(b.cover) ? b.cover : null,
    gallery: (Array.isArray(b.gallery) ? b.gallery : []).filter((id) => ids.has(id)).slice(0, 30),
    by: req.user.name || req.user.email, at: new Date().toISOString(),
  };
  await tx(async (c) => {
    await c.query('update submissions set pr_edit = $2 where id = $1', [s.id, edit]);
    await audit(c, req.user, 'submission.edit', s.ref, `แก้ไขข่าว ${s.ref} (ยังไม่เผยแพร่)`);
  });
  res.json(await detail(await one('select * from submissions where id = $1', [s.id])));
});

router.post('/pr/submissions/:ref/messages', limit('prMessage', { max: 120, windowMs: 10 * 60 * 1000 }), async (req, res) => {
  const s = await findSubmission(req.params.ref, req.user);
  await tx(async (c) => {
    await addMessage(c, s, req.user, 'pr', req.body?.text);
    await prMessaged(c, s, str(req.body?.text, 2000, 'ข้อความ'));
    await c.query('update submissions set pr_unread = false where id = $1', [s.id]);
    await audit(c, req.user, 'submission.message', s.ref, `ตอบข้อความผู้ส่ง ${s.ref}`);
  });
  res.status(201).json(await detail(await one('select * from submissions where id = $1', [s.id])));
});

router.post('/pr/submissions/:ref/read', async (req, res) => {
  await query('update submissions set pr_unread = false where ref = $1', [req.params.ref]);
  res.json({ ok: true });
});

// Publishes the work as a story. Images are copied (web size) into the public media folder.
router.post('/pr/submissions/:ref/publish', async (req, res) => {
  const s = await findSubmission(req.params.ref, req.user);
  if (s.status === 'published') throw new HttpError(409, 'งานนี้เผยแพร่แล้ว');
  if (s.status === 'rejected') throw new HttpError(409, 'งานนี้ถูกลบแล้ว กู้คืนไปที่รอตรวจก่อน');
  const b = req.body || {};
  const errors = {};
  const story = {
    title: str(b.title, 200, 'หัวข้อข่าว') || s.title,
    title_en: str(b.titleEn, 200, 'หัวข้อภาษาอังกฤษ'),
    lead: str(b.lead, 300, 'สรุปข่าว'),
    body: str(b.body, 50000, 'เนื้อหาข่าว') || '',
    body_en: str(b.bodyEn, 50000, 'เนื้อหาภาษาอังกฤษ'),
    categories: Array.isArray(b.categories) ? [...new Set(b.categories)] : s.categories,
    audience: Array.isArray(b.audience) ? [...new Set(b.audience)] : s.audience,
    video_url: str(b.videoUrl, 500, 'ลิงก์วิดีโอ') || s.video_url || s.news_video_url,
    // The sender's album link unless PR changed or cleared it
    album_url: b.albumUrl === undefined ? s.album_url : albumUrl(b.albumUrl),
    featured: b.featured === true,
    published_at: b.publishAt ? new Date(b.publishAt) : new Date(),
    body_size: b.bodySize === undefined ? s.body_size : bodySize(b.bodySize),
    body_leading: b.bodyLeading === undefined ? s.body_leading : bodyLeading(b.bodyLeading),
  };
  // ลิงก์ภาพเพิ่มเติม: the first is the one in the form (PR may change it), the sender's others come after it
  const albums = albumSet([story.album_url || '', ...(Array.isArray(b.albumLinks) ? b.albumLinks : s.album_links || [])].filter(Boolean));
  if (albums.error) errors.albumUrl = albums.error;
  story.album_url = albums.url;
  story.album_links = albums.links;
  // ลิงก์วิดีโอเพิ่มเติม: the sender's unless PR sent their own list
  const more = videoLinks(Array.isArray(b.videoLinks) ? b.videoLinks : s.video_links || [], story.video_url);
  story.video_links = more.links;
  if (more.error) errors.videoLinks = more.error;
  if (s.type === 'news' && story.body.length < 50) errors.body = 'ใส่เนื้อหาข่าวก่อนเผยแพร่';
  if (s.type === 'video' && !story.video_url) errors.videoUrl = 'ใส่ลิงก์วิดีโอที่เผยแพร่แล้ว (เช่น YouTube ของมหาวิทยาลัย)';
  if (!story.categories.length) errors.categories = 'เลือกประเภทข่าวอย่างน้อย 1 ประเภท';
  else if (!story.categories.every((c) => categories().includes(c)) || story.categories.length > MAX_CATS) errors.categories = 'ประเภทข่าวไม่ถูกต้อง';
  else if (!soloOk(story.categories)) errors.categories = SOLO_MSG;
  if (!story.audience.length || !story.audience.every((a) => AUDIENCES.includes(a))) errors.audience = 'เลือกว่าใครเห็นข่าวนี้ได้';
  if (Number.isNaN(story.published_at.getTime())) errors.publishAt = 'วันเวลาเผยแพร่ไม่ถูกต้อง';
  if (story.audience.includes('public')) story.audience = [...AUDIENCES];

  const files = (await query(`select * from submission_files where submission_id = $1 and kind in ('photo', 'art', 'cover') order by kind, position`, [s.id])).rows;
  const pick = (id) => files.find((f) => f.id === id);
  const coverFile = b.cover ? pick(b.cover) : files[0];
  const galleryFiles = (Array.isArray(b.gallery) ? b.gallery : []).map(pick).filter(Boolean).filter((f) => f !== coverFile).slice(0, 30);
  if (b.cover && !coverFile) errors.cover = 'ภาพปกต้องเป็นภาพจากงานนี้';
  if (coverFile && !/^image\//.test(coverFile.mime)) errors.cover = 'ภาพปกต้องเป็นไฟล์ภาพ';
  if (s.type !== 'video' && !coverFile) errors.cover = 'เลือกภาพปก';
  if (Object.keys(errors).length) throw new HttpError(400, 'กรุณาตรวจข้อมูลอีกครั้ง', errors);

  // Published before and taken back (ยกเลิกการเผยแพร่): the new version goes into the same story, so its link still works
  const prev = s.news_id ? await one('select id, cover_path, gallery from news where id = $1', [s.news_id]) : null;
  const newsId = prev?.id || (await one('select gen_random_uuid() id')).id;
  try {
    const cover = coverFile ? await publishImage(newsId, coverFile) : null;
    const gallery = [];
    for (const f of galleryFiles) gallery.push(await publishImage(newsId, f));
    await tx(async (c) => {
      if (prev) {
        await c.query(
          `update news set title = $2, title_en = $3, lead = $4, body = $5, body_en = $6, categories = $7, audience = $8, cover_path = $9, gallery = $10,
             video_url = $11, featured = $12, published_at = $13, album_url = $14, withdrawn_at = null, withdrawn_reason = null, withdrawn_by = null,
             body_size = $15, body_leading = $16, reviewed_by = $17, video_links = $18, album_links = $19, contact_kind = $20, contact_value = $21
           where id = $1`,
          [newsId, story.title, story.title_en, story.lead, story.body, story.body_en, story.categories, story.audience, cover, gallery,
            story.video_url, story.featured, story.published_at, story.album_url, story.body_size, story.body_leading, req.user.id, story.video_links, story.album_links,
            s.contact_kind, s.contact_value],
        );
      } else await c.query(
        `insert into news (id, kind, submission_id, title, title_en, lead, body, body_en, unit, categories, audience, cover_path, gallery,
           video_url, credit, event_date, place, featured, published_at, created_by, album_url, body_size, body_leading, reviewed_by, video_links,
           album_links, credit_kind, contact_kind, contact_value)
         values ($1, $20, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $21, $22, $23, $19, $24, $25, $26, $27, $28)`,
        // The credit line under the picture: photographer (news), producer (video), designer (banner)
        [newsId, s.id, story.title, story.title_en, story.lead, story.body, story.body_en, s.unit, story.categories, story.audience,
          cover, gallery, story.video_url, s.credit || s.producer || s.designer, s.event_date, s.place, story.featured, story.published_at, req.user.id, s.type, story.album_url,
          story.body_size, story.body_leading, story.video_links, story.album_links, s.type === 'banner' ? s.credit_kind || 'designer' : s.type === 'news' ? s.credit_kind : null,
          s.contact_kind, s.contact_value],
      );
      await c.query(`update submissions set status = 'published', news_id = $2, sender_unread = true, pr_unread = false, pr_edit = null where id = $1`, [s.id, newsId]);
      await c.query(`insert into submission_events (submission_id, status, actor_id) values ($1, 'published', $2)`, [s.id, req.user.id]);
      const note = str(b.message, 2000, 'ข้อความ') || get('messages').published;
      await addMessage(c, s, req.user, 'pr', note);
      await statusChanged(c, { ...s, title: story.title }, 'published', note, newsId);
      await audit(c, req.user, 'submission.publish', s.ref, `${prev ? 'เผยแพร่อีกครั้ง' : 'เผยแพร่'} ${s.ref} เป็นข่าว "${story.title}"`, { newsId });
    }, req.user);
    // Pictures of the earlier version that this one does not use
    if (prev) await Promise.all([prev.cover_path, ...prev.gallery].filter((p) => p && p !== cover && !gallery.includes(p)).map(removeMedia));
  } catch (err) {
    // A new story's folder goes; an earlier story keeps its pictures (the same files are written again with the same names)
    if (!prev) await rm(abs(join('media', newsId)), { recursive: true, force: true });
    throw err;
  }
  res.status(201).json(await detail(await one('select * from submissions where id = $1', [s.id])));
});

router.get('/pr/config', (req, res) => res.json({ messages: get('messages'), categories: get('categories'), videoCategories: VIDEO_CATEGORIES }));

// ---- PR team ----
router.get('/pr/team', async (req, res) => {
  const rows = (await query(`select t.email, t.role, t.added_at, u.name, u.last_login_at
    from pr_team t left join users u on u.email = t.email where t.role in ('pr', 'admin') order by t.role, t.email`)).rows;
  res.json({ team: rows });
});

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ');
  next();
};

router.post('/pr/team', requireAdmin, async (req, res) => {
  const email = str(req.body?.email, 200, 'อีเมล')?.toLowerCase();
  const role = req.body?.role === 'admin' ? 'admin' : 'pr';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
  await tx(async (c) => {
    await c.query('insert into pr_team (email, role) values ($1, $2) on conflict (email) do update set role = $2', [email, role]);
    await c.query('update users set role = $2 where email = $1', [email, role]);
    await audit(c, req.user, 'role.set', email, `กำหนดให้ ${email} เป็น${role === 'admin' ? 'ผู้ดูแลระบบ' : 'ทีม PR'}`, { role });
  });
  res.status(201).json({ ok: true });
});

router.delete('/pr/team/:email', requireAdmin, async (req, res) => {
  const email = req.params.email.toLowerCase();
  if (email === req.user.email) throw new HttpError(409, 'นำตัวเองออกจากทีมไม่ได้');
  await tx(async (c) => {
    await c.query('delete from pr_team where email = $1', [email]);
    await c.query('update users set role = $2 where email = $1', [email, domainRole(email)]);
    await audit(c, req.user, 'role.remove', email, `นำ ${email} ออกจากทีม`);
  });
  res.json({ ok: true });
});

