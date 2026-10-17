// System settings, users and roles, usage history (admin.html). Admin only.
// - GET  /api/admin/settings                 { settings, defaults, labels }
// - PUT  /api/admin/settings/:key  { value } validate + save (org: null = back to org-data.js)
// - GET  /api/admin/users?q=&role=&limit=&offset=
// - PUT  /api/admin/roles  { email, role: default|coordinator|pr|admin, unit }
// - GET  /api/admin/audit?action=&q=&from=&to=&limit=&offset=
// - GET  /api/admin/backups                  the last backup and restore test (backup.mjs / restore-test.mjs status.json)
import { Router } from 'express';
import { readStatus } from './backup.mjs';
import { domainRole, requireAdmin } from './auth.mjs';
import { ACTIONS, audit } from './audit.mjs';
import { query, tx } from './db.mjs';
import { HttpError, str } from './http.mjs';
import { FACULTIES, FILE_ORG, STAFF_UNITS } from './org.mjs';
import { ALL_PLATFORMS, DEFAULTS, KEYS, LABELS, SOFT_BG, all, remember, save } from './settings.mjs';

export const router = Router();
router.use('/admin', requireAdmin);

const ROLE_TH = { default: 'ตามโดเมนอีเมล', coordinator: 'ผู้ประสานงานหน่วยงาน', pr: 'ทีม PR', admin: 'ผู้ดูแลระบบ' };

// ---- Settings ----
router.get('/admin/settings', (req, res) => {
  // fileOrg: the chart in org-data.js, the starting point when settings.org is null
  res.json({ settings: all(), defaults: DEFAULTS, fileOrg: FILE_ORG, labels: LABELS, platforms: ALL_PLATFORMS, softBg: SOFT_BG });
});

router.put('/admin/settings/:key', async (req, res) => {
  const key = req.params.key;
  if (!KEYS.includes(key)) throw new HttpError(404, 'ไม่พบการตั้งค่านี้');
  if (!req.body || !('value' in req.body)) throw new HttpError(400, 'ไม่พบค่าที่จะบันทึก');
  const before = all()[key];
  const clean = await tx(async (c) => {
    const v = await save(c, key, req.body.value, req.user);
    // The org chart can be long: keep only a summary in the history
    const details = key === 'org' ? { reset: v === null } : { before, after: v };
    await audit(c, req.user, 'settings.update', key, `${v === null ? 'คืนค่าเริ่มต้น' : 'แก้ไข'}${LABELS[key]}`, details);
    return v;
  });
  remember(key, clean);
  res.json({ key, value: clean });
});

// ---- Users and roles ----
router.get('/admin/users', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = str(req.query.q, 100, 'คำค้น');
  const role = ['staff', 'student', 'external', 'coordinator', 'pr', 'admin'].includes(req.query.role) ? req.query.role : null;
  // Everyone who signed in, plus roles given to addresses that have not signed in yet
  const rows = (await query(
    `with people as (
       select coalesce(u.email, t.email) email, u.id, u.name, coalesce(t.role, u.role) role, t.unit coord_unit,
         coalesce(u.sub_unit, u.unit, u.org) affiliation, u.last_login_at, u.created_at, t.added_at, (t.email is not null) assigned
       from users u full join pr_team t on t.email = u.email)
     select *, count(*) over ()::int total from people
     where ($1::text is null or email ilike $1 or name ilike $1 or affiliation ilike $1) and ($2::text is null or role::text = $2)
     order by (role in ('admin', 'pr', 'coordinator')) desc, role, last_login_at desc nulls last, email
     limit ${limit} offset ${offset}`,
    [q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null, role])).rows;
  const counts = (await query(`select coalesce(t.role, u.role)::text role, count(*)::int n from users u full join pr_team t on t.email = u.email group by 1`)).rows;
  res.json({
    total: rows[0]?.total ?? 0, counts: Object.fromEntries(counts.map((c) => [c.role, c.n])),
    items: rows.map((r) => ({
      email: r.email, name: r.name, role: r.role, coordUnit: r.coord_unit, affiliation: r.affiliation, signedIn: !!r.id,
      lastLoginAt: r.last_login_at, assigned: r.assigned, domainRole: domainRole(r.email),
    })),
  });
});

router.put('/admin/roles', async (req, res) => {
  const email = str(req.body?.email, 200, 'อีเมล')?.toLowerCase();
  const role = req.body?.role;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
  if (!ROLE_TH[role]) throw new HttpError(400, 'บทบาทไม่ถูกต้อง');
  const unit = role === 'coordinator' ? str(req.body?.unit, 200, 'หน่วยงาน') : null;
  if (role === 'coordinator' && !(STAFF_UNITS.has(unit) || FACULTIES.has(unit))) throw new HttpError(400, 'เลือกหน่วยงานที่ผู้ประสานงานดูแล');
  if (email === req.user.email && role !== 'admin') throw new HttpError(409, 'เปลี่ยนบทบาทของตัวเองไม่ได้ ให้ผู้ดูแลระบบคนอื่นเปลี่ยนให้');
  await tx(async (c) => {
    if (role === 'default') {
      const was = (await c.query('delete from pr_team where email = $1 returning role', [email])).rows[0];
      if (was?.role === 'admin' && !(await c.query("select 1 from pr_team where role = 'admin'")).rowCount) {
        throw new HttpError(409, 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
      }
      await c.query('update users set role = $2 where email = $1', [email, domainRole(email)]);
      await audit(c, req.user, 'role.remove', email, `ยกเลิกบทบาทพิเศษของ ${email} (กลับเป็น${ROLE_TH.default})`, { was: was?.role });
    } else {
      await c.query(`insert into pr_team (email, role, unit) values ($1, $2, $3)
        on conflict (email) do update set role = $2, unit = $3`, [email, role, unit]);
      await c.query('update users set role = $2 where email = $1', [email, role]);
      await audit(c, req.user, 'role.set', email, `กำหนดให้ ${email} เป็น${ROLE_TH[role]}${unit ? ` (${unit})` : ''}`, { role, unit });
    }
  });
  res.json({ ok: true });
});

// ---- Usage history ----
// ---- Backups: what the nightly backup and the monthly restore test last did ----
// Late: no good backup in 26 hours, no passed restore test in 35 days, or nothing copied off this machine
router.get('/admin/backups', async (req, res) => {
  const s = await readStatus();
  const hours = (at) => (at ? (Date.now() - new Date(at).getTime()) / 3600000 : Infinity);
  const b = s.backup || null, t = s.restoreTest || null;
  res.json({
    backup: b, restoreTest: t,
    warnings: [
      !b ? 'ยังไม่เคยสำรองข้อมูล' : !b.ok ? 'การสำรองข้อมูลครั้งล่าสุดไม่สำเร็จ' : hours(b.at) > 26 ? 'ไม่ได้สำรองข้อมูลเกิน 1 วัน' : null,
      b && b.ok && !b.offsite?.ok ? 'ยังไม่มีสำเนานอกเครื่อง (ตั้ง BACKUP_OFFSITE_CMD)' : null,
      !t ? 'ยังไม่เคยทดลองกู้คืน' : !t.ok ? 'การทดลองกู้คืนครั้งล่าสุดไม่ผ่าน' : hours(t.at) > 35 * 24 ? 'ไม่ได้ทดลองกู้คืนเกิน 1 เดือน' : null,
    ].filter(Boolean),
  });
});

router.get('/admin/audit', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = [];
  if (ACTIONS[req.query.action]) where.push(`a.action = ${p(req.query.action)}`);
  const q = str(req.query.q, 100, 'คำค้น');
  if (q) where.push(`(a.summary ilike ${p(`%${q.replace(/[\\%_]/g, '\\$&')}%`)} or a.actor_email ilike $${params.length} or a.target ilike $${params.length})`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) where.push(`(a.at at time zone 'Asia/Bangkok')::date >= ${p(req.query.from)}::date`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) where.push(`(a.at at time zone 'Asia/Bangkok')::date <= ${p(req.query.to)}::date`);
  const rows = (await query(
    `select a.*, u.name actor_name, count(*) over ()::int total from audit_log a left join users u on u.id = a.actor_id
     ${where.length ? `where ${where.join(' and ')}` : ''} order by a.at desc, a.id desc limit ${limit} offset ${offset}`, params)).rows;
  res.json({
    actions: ACTIONS, total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor_name || r.actor_email || 'ระบบ', actorEmail: r.actor_email,
      action: r.action, actionLabel: ACTIONS[r.action] || r.action, target: r.target, summary: r.summary, details: r.details })),
  });
});
