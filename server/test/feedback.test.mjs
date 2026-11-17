// แจ้งปัญหาการใช้งานระบบ: anyone sends, only the PR team and admin read and close, every close in audit_log.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { query } from '../db.mjs';
import { removeFeedbackDir } from '../files.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, gpsPhoto, login } from './helpers.mjs';

const MARK = 'ทดสอบแจ้งปัญหา';
let snap, pr, admin, staff, external, secretary;
const send = (who, over = {}) => who.call('POST', '/api/feedback', { message: `${MARK} กดส่งข่าวแล้วหน้าค้าง ${Date.now()}`, page: 'submit.html', contact: '081-234-5678', ...over });
const latest = async () => (await query('select * from feedback where message like $1 order by id desc limit 1', [`${MARK}%`])).rows[0];

before(async () => {
  snap = await snapshot();
  [pr, admin, staff, external, secretary] = await Promise.all(['pr', 'admin', 'staff', 'external', 'secretary'].map(login));
});
after(async () => {
  const ids = (await query('select id from feedback where message like $1', [`${MARK}%`])).rows.map((r) => r.id);
  await Promise.all(ids.map(removeFeedbackDir));
  await query('delete from feedback where message like $1', [`${MARK}%`]);
  await restore(snap);
});

describe('ส่งแจ้งปัญหา', () => {
  test('ไม่ต้องเข้าสู่ระบบก็ส่งได้ และทีม PR ได้รับแจ้งเตือน', async () => {
    const r = await send(anon);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const f = await latest();
    assert.equal(f.sender_id, null);
    assert.equal(f.status, 'new');
    assert.equal(f.page, 'submit.html');
    const n = (await query("select count(*)::int n from notifications where kind = 'feedback.new' and ref_id = $1", [String(f.id)])).rows[0].n;
    assert.ok(n >= 1);
  });
  test('ผู้ใช้ที่เข้าสู่ระบบ (รวมบัญชีภายนอก) ส่งได้ และระบบจำผู้ส่ง', async () => {
    for (const who of [staff, external]) {
      const r = await send(who);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok((await latest()).sender_id);
    }
  });
  test('ข้อความสั้นหรือยาวเกิน และชนิดข้อมูลผิด ถูกปฏิเสธ', async () => {
    assert.equal((await send(staff, { message: 'สั้น' })).status, 400);
    assert.equal((await send(staff, { message: `${MARK} ${'ก'.repeat(2001)}` })).status, 400);
    assert.equal((await send(staff, { contact: { x: 1 } })).status, 400);
    assert.equal((await send(staff, { page: 'ก'.repeat(201) })).status, 400);
  });
  test('ช่องดักบอทถูกกรอก: ตอบรับแต่ไม่เก็บ', async () => {
    const before = (await latest())?.id;
    const r = await send(staff, { website: 'http://spam.example' });
    assert.equal(r.status, 201);
    assert.equal((await latest())?.id, before);
  });
});

describe('แนบรูปภาพ', () => {
  // multipart: "data" JSON + pictures in "files" ([name, buffer, type])
  const withFiles = (who, files, over = {}) => {
    const fd = new FormData();
    fd.append('data', JSON.stringify({ message: `${MARK} หน้าส่งข่าวแสดงผิด ${Date.now()}`, ...over }));
    for (const [name, buf, type] of files) fd.append('files', new Blob([buf], { type }), name);
    return who.call('POST', '/api/feedback', fd);
  };
  const png = () => sharp({ create: { width: 40, height: 30, channels: 3, background: 'red' } }).png().toBuffer();

  test('ไม่เข้าสู่ระบบก็แนบรูปได้ รูปถูกแปลงเป็น WebP ไม่มีพิกัด และทีม PR เปิดดูได้', async () => {
    const r = await withFiles(anon, [['จอ.png', await png(), 'image/png'], ['มือถือ.jpg', await gpsPhoto(), 'image/jpeg']]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const f = await latest();
    const list = await pr.call('GET', '/api/pr/feedback');
    const item = list.body.items.find((i) => i.id === String(f.id));
    assert.deepEqual(item.files.map((x) => x.name), ['จอ.png', 'มือถือ.jpg']);
    const pic = await fetch(`${process.env.TEST_BASE || 'http://localhost:3000'}/api/pr/feedback/${f.id}/files/${item.files[1].id}`, { headers: { cookie: pr.cookie } });
    assert.equal(pic.status, 200);
    const meta = await sharp(Buffer.from(await pic.arrayBuffer())).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.exif, undefined);
    for (const who of [anon, staff, external, secretary]) {
      assert.ok([401, 403].includes((await who.call('GET', `/api/pr/feedback/${f.id}/files/${item.files[0].id}`)).status));
    }
    // A picture asked for under another report, or a made-up id
    assert.equal((await pr.call('GET', `/api/pr/feedback/1/files/${item.files[0].id}`)).status, 404);
    assert.equal((await pr.call('GET', `/api/pr/feedback/${f.id}/files/abc`)).status, 404);
  });
  test('ไฟล์ที่ไม่ใช่รูป รูปปลอม และเกิน 3 รูป ถูกปฏิเสธ', async () => {
    const before = (await latest())?.id;
    assert.equal((await withFiles(staff, [['เอกสาร.pdf', Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf']])).status, 400);
    assert.equal((await withFiles(staff, [['ปลอม.png', Buffer.from('not really a picture'), 'image/png']])).status, 400);
    const p = await png();
    assert.equal((await withFiles(staff, [1, 2, 3, 4].map((n) => [`${n}.png`, p, 'image/png']))).status, 400);
    assert.equal((await withFiles(staff, [['จอ.png', p, 'image/png']], { message: 'สั้น' })).status, 400);
    assert.equal((await latest())?.id, before);
  });
});

describe('กล่องแจ้งปัญหาหลังบ้าน', () => {
  test('เฉพาะทีม PR และผู้ดูแลระบบอ่านได้', async () => {
    for (const who of [anon, staff, external, secretary]) assert.ok([401, 403].includes((await who.call('GET', '/api/pr/feedback')).status));
    for (const who of [pr, admin]) {
      const r = await who.call('GET', '/api/pr/feedback');
      assert.equal(r.status, 200);
      assert.ok(r.body.unread >= 1);
      assert.ok(r.body.items.some((i) => i.message.startsWith(MARK)));
    }
  });
  test('ปิดเรื่องแล้วบันทึกใน audit_log และย้ายกลับได้', async () => {
    const f = await latest();
    assert.ok([401, 403].includes((await staff.call('POST', `/api/pr/feedback/${f.id}/status`, { status: 'done' })).status));
    assert.equal((await pr.call('POST', `/api/pr/feedback/${f.id}/status`, { status: 'done' })).status, 200);
    const done = await pr.call('GET', '/api/pr/feedback?status=done');
    assert.ok(done.body.items.some((i) => i.id === String(f.id) && i.doneBy));
    const log = (await query("select count(*)::int n from audit_log where action = 'feedback.status' and target = $1", [`feedback:${f.id}`])).rows[0].n;
    assert.equal(log, 1);
    assert.equal((await pr.call('POST', `/api/pr/feedback/${f.id}/status`, { status: 'new' })).status, 200);
    assert.equal((await latest()).done_at, null);
  });
  test('สถานะหรือรหัสผิด', async () => {
    const f = await latest();
    assert.equal((await pr.call('POST', `/api/pr/feedback/${f.id}/status`, { status: 'x' })).status, 400);
    assert.equal((await pr.call('POST', '/api/pr/feedback/abc/status', { status: 'done' })).status, 404);
    assert.equal((await pr.call('POST', '/api/pr/feedback/999999999999/status', { status: 'done' })).status, 404);
  });
});
