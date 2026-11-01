// คลังเอกสาร (SPEC.md §2, §4, §7, §8): what may be uploaded, versions, Thai search, access levels, who may do what, PDPA.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { one, query, tx } from '../db.mjs';
import { abs } from '../files.mjs';
import { erase } from '../privacy.mjs';
import { restore, snapshot } from './cleanup.mjs';
import { anon, form, gpsEntries, gpsPhoto, login } from './helpers.mjs';

const MB = 1024 * 1024;
const TEMP_EMAIL = 'documents-test@sru.ac.th';
const UUID = '00000000-0000-4000-8000-000000000000';
const PDF = Buffer.from('%PDF-1.7\nเอกสารทดสอบ\n');
const ZIP = Buffer.from('PK\x03\x04ทดสอบ');
const info = (over = {}) => ({ title: 'เอกสารทดสอบคลัง', category: 'other', tags: ['ทดสอบ'], ...over });
/** @param {string} [name] @param {Buffer} [buf] @param {string} [type] */
const file = (name = 'รายงาน.pdf', buf = PDF, type = 'application/pdf') => ({ file: [[name, buf, type]] });

let snap, pr, admin, student, secretary, executive, staff, external;
const add = async (over, f = file(), who = pr) => {
  const r = await who.call('POST', '/api/documents', form(info(over), f));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.document;
};
const works = async (who, q = '') => (await who.call('GET', `/api/document-works${q}`)).body.items;
const ids = async (who, q = '') => (await works(who, q)).flatMap((w) => w.documents.map((d) => d.id));

before(async () => {
  snap = await snapshot();
  [pr, admin, student, secretary, executive, staff, external] = await Promise.all(['pr', 'admin', 'student', 'secretary', 'executive', 'staff', 'external'].map(login));
});
after(async () => {
  await query('delete from users where email = $1', [TEMP_EMAIL]);
  await restore(snap);
});

describe('uploading', () => {
  test('a document is stored under a random name and audit_log has it', async () => {
    const d = await add();
    assert.equal(d.version, 1);
    assert.equal(d.fileName, 'รายงาน.pdf');
    assert.equal(d.accessLevel, 'team');
    assert.equal(JSON.stringify(d).includes('documents/'), false, 'the stored path stays on the server');
    const row = await one('select file_path from document_versions where document_id = $1', [d.id]);
    assert.match(row.file_path, new RegExp(`^documents/${d.id}/[0-9a-f-]{36}\\.pdf$`));
    assert.deepEqual(await readFile(abs(row.file_path)), PDF);
    assert.ok(await one(`select 1 from audit_log where action = 'document.create' and target = $1`, [d.id]));
  });
  test('PDF, DOCX, XLSX, PPTX, JPG and PNG are accepted', async () => {
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    /** @type {[string, Buffer][]} */
    const good = [['a.pdf', PDF], ['a.docx', ZIP], ['a.xlsx', ZIP], ['a.pptx', ZIP], ['a.jpg', jpg], ['a.jpeg', jpg], ['a.png', png]];
    for (const [name, buf] of good) assert.equal((await add({}, file(name, buf))).fileName, name);
  });
  test('a renamed file, another type, or video is refused, and nothing is left behind', async () => {
    const before = (await readdir(abs('tmp'))).length;
    const count = (await one('select count(*)::int n from documents')).n;
    /** @type {[string, Buffer][]} */
    const bad = [['virus.pdf', Buffer.from('MZ\x90\0not a pdf')], ['แฝง.docx', PDF], ['a.exe', Buffer.from('MZ')], ['a.zip', ZIP], ['a.doc', PDF], ['a.mp4', Buffer.from('....ftypisom')], ['a.webp', PDF]];
    for (const [name, buf] of bad) {
      const r = await pr.call('POST', '/api/documents', form(info(), file(name, buf)));
      assert.equal(r.status, 400, name);
      assert.ok(r.body.details?.file, name);
    }
    assert.equal((await one('select count(*)::int n from documents')).n, count);
    assert.equal((await readdir(abs('tmp'))).length, before);
  });
  test('at most 20 MB for a document and 10 MB for a picture', async () => {
    const big = (n, start) => Buffer.concat([start, Buffer.alloc(n - start.length)]);
    const png = big(10 * MB + 1, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));
    assert.equal((await pr.call('POST', '/api/documents', form(info(), file('ใหญ่.png', png)))).status, 413);
    assert.equal((await pr.call('POST', '/api/documents', form(info(), file('ใหญ่.pdf', big(20 * MB + 1, PDF))))).status, 413);
    assert.equal((await add({}, file('พอดี.pdf', big(20 * MB, PDF)))).size, 20 * MB);
  });
  test('bad input is refused field by field; the file is not kept', async () => {
    const before = (await readdir(abs('tmp'))).length;
    const r = await pr.call('POST', '/api/documents', form({ title: ' ', category: 'x', tags: 'ไม่ใช่รายการ', accessLevel: 'x' }, file()));
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body.details).sort(), ['accessLevel', 'category', 'tags', 'title']);
    assert.equal((await readdir(abs('tmp'))).length, before);
    assert.ok((await pr.call('POST', '/api/documents', form(info({ tags: Array(11).fill(0).map((_, i) => `ป้าย${i}`) }), file()))).body.details.tags);
    assert.ok((await pr.call('POST', '/api/documents', form(info(), {}))).body.details.file);
  });
  test('pictures lose where they were taken', async () => {
    const photo = await gpsPhoto();
    assert.ok(gpsEntries((await sharp(photo).metadata()).exif) > 0, 'test photo has GPS');
    const d = await add({}, file('ภาพ.jpg', photo, 'image/jpeg'));
    const stored = await readFile(abs((await one('select file_path from document_versions where document_id = $1', [d.id])).file_path));
    assert.equal(gpsEntries((await sharp(stored).metadata()).exif), 0);
  });
});

describe('downloading and versions', () => {
  test('a download is always an attachment, never cached, with the Thai name', async () => {
    const d = await add();
    const r = await pr.call('GET', `/api/documents/${d.id}/file`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, PDF);
    assert.match(r.headers.get('content-disposition'), /^attachment/);
    assert.ok(r.headers.get('content-disposition').includes(encodeURIComponent('รายงาน.pdf')));
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
  test('a new version becomes the current file; the old one stays and can be downloaded', async () => {
    const d = await add();
    const next = Buffer.from('%PDF-1.7\nฉบับที่สอง\n');
    const r = await pr.call('POST', `/api/documents/${d.id}/versions`, form({}, file('ฉบับใหม่.pdf', next)));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.document.version, 2);
    assert.equal(r.body.document.fileName, 'ฉบับใหม่.pdf');
    assert.deepEqual(r.body.document.versions.map((v) => [v.version, v.fileName]), [[2, 'ฉบับใหม่.pdf'], [1, 'รายงาน.pdf']]);
    assert.deepEqual((await pr.call('GET', `/api/documents/${d.id}/file`)).body, next);
    assert.deepEqual((await pr.call('GET', `/api/documents/${d.id}/file?version=1`)).body, PDF);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}/file?version=9`)).status, 404);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}/file?version=x`)).status, 404);
    assert.ok(await one(`select 1 from audit_log where action = 'document.version' and target = $1`, [d.id]));
    assert.ok((await ids(pr, `?q=${encodeURIComponent('ฉบับใหม่')}`)).includes(d.id), 'the new name can be found');
  });
  test('versions added at the same time get their own numbers', async () => {
    const d = await add();
    const all = await Promise.all([1, 2, 3].map(() => pr.call('POST', `/api/documents/${d.id}/versions`, form({}, file()))));
    assert.deepEqual(all.map((r) => r.status), [201, 201, 201]);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}`)).body.document.version, 4);
  });
  test('editing changes the details, not the file', async () => {
    const d = await add();
    const r = await pr.call('PUT', `/api/documents/${d.id}`, info({ title: 'ชื่อใหม่ทดสอบ', category: 'request_memo', tags: ['ใหม่', 'ใหม่', ' แบบฟอร์ม '] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.document.title, 'ชื่อใหม่ทดสอบ');
    assert.deepEqual(r.body.document.tags, ['ใหม่', 'แบบฟอร์ม']);
    assert.equal(r.body.document.version, 1);
    assert.ok((await ids(pr, `?q=${encodeURIComponent('ชื่อใหม่ทดสอบ')}`)).includes(d.id));
    assert.ok(await one(`select 1 from audit_log where action = 'document.update' and target = $1`, [d.id]));
  });
});

describe('finding', () => {
  test('Thai search: part of a word, words in any order, tags, category, file name', async () => {
    const d = await add({ title: 'รายงานประจำปีงบประมาณ', category: 'unit_order', unitName: 'กองกลางทดสอบ', workTitle: 'โครงการพัฒนาบุคลากร', tags: ['ค่ายอาสา'] }, file('สรุปผลโครงการ.pdf'));
    for (const q of ['งบประมาณ', 'ประมา', 'งบประมาณรายงาน', 'ค่ายอา', 'คำสั่งจากหน่วยงาน', 'กองกลางทดสอบ', 'สรุปผล', 'พัฒนาบุคลากร']) {
      assert.ok((await ids(pr, `?q=${encodeURIComponent(q)}`)).includes(d.id), q);
    }
    assert.equal((await ids(pr, `?q=${encodeURIComponent('ไม่มีคำนี้เลยในคลัง')}`)).length, 0);
  });
  test('the list filters by category; unknown filters are refused', async () => {
    const d = await add({ category: 'university_order' });
    assert.ok((await ids(pr, '?category=university_order')).includes(d.id));
    assert.ok(!(await ids(pr, '?category=request_memo')).includes(d.id));
    assert.equal((await pr.call('GET', '/api/document-works?category=x')).status, 400);
  });
  test('filters: file type, team or personal, year of upload, ผู้เกี่ยวข้อง; unknown values are refused', async () => {
    const prId = (await pr.call('GET', '/api/me')).body.user.id;
    const adminId = (await admin.call('GET', '/api/me')).body.user.id;
    const d = await add({ title: 'ไฟล์ตัวกรอง', workTitle: 'งานตัวกรองทดสอบ', peopleIds: [adminId] }, file('แผน.xlsx', ZIP));
    const mine = await add({ accessLevel: 'private', peopleIds: [prId] });
    const has = async (q) => (await ids(pr, q)).includes(d.id);
    assert.ok(await has('?type=excel'));
    assert.ok(!(await has('?type=pdf')));
    assert.ok(await has('?level=team'));
    assert.ok(!(await has('?level=private')));
    assert.ok((await ids(pr, '?level=private')).includes(mine.id));
    assert.ok(await has(`?person=${adminId}`));
    assert.ok(!(await has(`?person=${prId}`)));
    const r = await pr.call('GET', '/api/document-works');
    const year = new Date().getFullYear() + 543;
    assert.ok(r.body.years.includes(year));
    assert.ok(await has(`?year=${year}`) || await has(`?year=${year - 1}&round=2`));
    assert.ok(!(await has(`?year=${year - 5}`)));
    assert.ok(await has(`?type=excel&level=team&person=${adminId}&q=${encodeURIComponent('ตัวกรอง')}`));
    for (const q of ['type=x', 'level=admin', 'year=69', `person=nope`]) assert.equal((await pr.call('GET', `/api/document-works?${q}`)).status, 400, q);
  });
  test('archived documents leave the list, keep their files, and come back', async () => {
    const d = await add();
    const off = await pr.call('POST', `/api/documents/${d.id}/archive`, {});
    assert.equal(off.status, 200);
    assert.ok(off.body.document.archivedAt);
    assert.ok(!(await ids(pr)).includes(d.id));
    assert.ok((await ids(pr, '?archived=1')).includes(d.id));
    assert.equal((await pr.call('GET', `/api/documents/${d.id}/file`)).status, 200);
    assert.equal((await pr.call('PUT', `/api/documents/${d.id}`, info())).status, 409);
    assert.equal((await pr.call('POST', `/api/documents/${d.id}/versions`, form({}, file()))).status, 409);
    assert.equal((await pr.call('POST', `/api/documents/${d.id}/archive`, {})).status, 409);
    assert.equal((await pr.call('POST', `/api/documents/${d.id}/restore`, {})).status, 200);
    assert.ok((await ids(pr)).includes(d.id));
    assert.equal((await pr.call('POST', `/api/documents/${d.id}/restore`, {})).status, 409);
    for (const action of ['document.archive', 'document.restore']) assert.ok(await one('select 1 from audit_log where action = $1 and target = $2', [action, d.id]), action);
  });
  test('pages: each งาน once, the total counts every match, filters still apply', async () => {
    const q = `?q=${encodeURIComponent('งานแบ่งหน้าทดสอบ')}`;
    const made = [];
    for (let i = 1; i <= 5; i++) made.push((await add({ workTitle: `งานแบ่งหน้าทดสอบ ${i}` })).workId);
    const one = (await pr.call('GET', `/api/document-works${q}&perPage=2&page=1`)).body;
    const two = (await pr.call('GET', `/api/document-works${q}&perPage=2&page=2`)).body;
    const three = (await pr.call('GET', `/api/document-works${q}&perPage=2&page=3`)).body;
    assert.deepEqual([one.total, one.page, one.perPage], [5, 1, 2]);
    assert.deepEqual([one.items.length, two.items.length, three.items.length], [2, 2, 1]);
    assert.deepEqual([...one.items, ...two.items, ...three.items].map((w) => w.id).sort(), [...made].sort());
    const past = (await pr.call('GET', `/api/document-works${q}&perPage=2&page=9`)).body;
    assert.deepEqual([past.items.length, past.total], [0, 5]);
    assert.equal((await pr.call('GET', `/api/document-works${q}&type=excel`)).body.total, 0);
    for (const bad of ['page=0', 'page=x', 'perPage=0', 'perPage=101', 'perPage=1.5']) assert.equal((await pr.call('GET', `/api/document-works?${bad}`)).status, 400, bad);
  });
  test('รอบประเมิน counts from the date of the document; round 2 crosses into the next year', async () => {
    const round1 = await add({ title: 'เอกสารรอบหนึ่ง', docDate: '2026-09-30' });
    const round2 = await add({ title: 'เอกสารรอบสองปลายปี', docDate: '2026-10-01' });
    const crossing = await add({ title: 'เอกสารรอบสองข้ามปี', docDate: '2027-03-31' });
    const next = await add({ title: 'เอกสารรอบถัดไป', docDate: '2027-04-01' });
    assert.equal(round1.docDate, '2026-09-30');
    const found = async (q) => { const all = await ids(pr, q); return [round1, round2, crossing, next].map((d) => all.includes(d.id)); };
    assert.deepEqual(await found('?round=1'), [true, false, false, true]);
    assert.deepEqual(await found('?round=2'), [false, true, true, false]);
    assert.deepEqual(await found('?round=1&year=2569'), [true, false, false, false]);
    assert.deepEqual(await found('?round=2&year=2569'), [false, true, true, false], 'October 2569 to March 2570');
    assert.deepEqual(await found('?round=1&year=2570'), [false, false, false, true]);
    assert.deepEqual(await found('?year=2570'), [false, false, true, true], 'a year alone is the calendar year');
    const { years } = (await pr.call('GET', '/api/document-works')).body;
    assert.ok(years.includes(2569) && years.includes(2570));
    assert.equal((await pr.call('GET', '/api/document-works?round=3')).status, 400);
  });
  test('the date defaults to today, can be changed, and stays when left out', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const d = await add();
    assert.equal(d.docDate, today);
    const url = `/api/documents/${d.id}`;
    assert.equal((await pr.call('PUT', url, info({ docDate: '2026-01-15' }))).body.document.docDate, '2026-01-15');
    assert.equal((await pr.call('PUT', url, info())).body.document.docDate, '2026-01-15');
    for (const docDate of ['2026-02-31', '15/01/2569', '2569-01-15', 5]) assert.ok((await pr.call('PUT', url, info({ docDate }))).body.details?.docDate, String(docDate));
  });
  test('ลบ: only the uploader and admin; it leaves the งาน and the list, the file stays', async () => {
    const shared = await add({ workTitle: 'งานลบเอกสารทดสอบ' }, file(), admin);
    const mine = await add({ title: 'เอกสารที่จะลบ', workId: shared.workId });
    assert.equal((await pr.call('POST', `/api/documents/${shared.id}/archive`, {})).status, 403);
    assert.equal((await pr.call('POST', `/api/documents/${mine.id}/archive`, {})).status, 200);
    const left = (await pr.call('GET', `/api/document-works/${shared.workId}`)).body.work.documents;
    assert.deepEqual(left.map((d) => d.id), [shared.id]);
    assert.ok(!(await ids(pr)).includes(mine.id));
    const stored = await one('select file_path from document_versions where document_id = $1', [mine.id]);
    assert.deepEqual(await readFile(abs(stored.file_path)), PDF);
    assert.equal((await admin.call('POST', `/api/documents/${shared.id}/archive`, {})).status, 200);
    assert.deepEqual((await pr.call('GET', `/api/document-works/${shared.workId}`)).body.work.documents, []);
    assert.ok(!(await works(pr)).some((w) => w.id === shared.workId), 'a งาน with nothing left leaves the list');
  });
  test('nothing can delete a document for good', async () => {
    const d = await add();
    assert.equal((await admin.call('DELETE', `/api/documents/${d.id}`)).status, 404);
  });
});

describe('งาน', () => {
  test('one งาน holds many documents; a new one is made with its first document', async () => {
    const first = await add({ title: 'คำสั่งแต่งตั้ง', workTitle: 'งานรับปริญญาทดสอบ', category: 'university_order' });
    const second = await add({ title: 'บันทึกขอความอนุเคราะห์', workId: first.workId, category: 'request_memo' });
    assert.equal(second.workId, first.workId);
    const w = (await pr.call('GET', `/api/document-works/${first.workId}`)).body.work;
    assert.equal(w.title, 'งานรับปริญญาทดสอบ');
    assert.deepEqual(w.documents.map((d) => d.id), [first.id, second.id]);
    const card = (await works(pr, `?q=${encodeURIComponent('รับปริญญาทดสอบ')}`))[0];
    assert.equal(card.id, first.workId);
    assert.equal(card.documents.length, 2);
  });
  test('a งาน without its own name takes the document name', async () => {
    const d = await add({ title: 'ชื่อเดียวทดสอบ' });
    assert.equal((await pr.call('GET', `/api/document-works/${d.workId}`)).body.work.title, 'ชื่อเดียวทดสอบ');
  });
  test('adding to a งาน that does not exist is refused and keeps no file', async () => {
    const before = (await readdir(abs('tmp'))).length;
    assert.equal((await pr.call('POST', '/api/documents', form(info({ workId: UUID }), file()))).status, 404);
    assert.equal((await readdir(abs('tmp'))).length, before);
  });
  test('คำสั่งจากหน่วยงาน needs the unit; other categories drop it', async () => {
    const r = await pr.call('POST', '/api/documents', form(info({ category: 'unit_order', unitName: ' ' }), file()));
    assert.equal(r.status, 400);
    assert.ok(r.body.details.unitName);
    const d = await add({ category: 'unit_order', unitName: 'สำนักงานอธิการบดี' });
    assert.equal(d.unitName, 'สำนักงานอธิการบดี');
    assert.equal((await pr.call('PUT', `/api/documents/${d.id}`, info({ category: 'other', unitName: 'ทิ้งไป' }))).body.document.unitName, null);
  });
  test('at most 5 ผู้เกี่ยวข้อง, PR and admin only; they can be changed and searched', async () => {
    const prId = (await pr.call('GET', '/api/me')).body.user.id;
    const adminId = (await admin.call('GET', '/api/me')).body.user.id;
    const studentId = (await student.call('GET', '/api/me')).body.user.id;
    const people = (await pr.call('GET', '/api/document-works/people')).body.items;
    assert.ok(people.some((p) => p.id === prId) && people.some((p) => p.id === adminId));
    assert.ok(!people.some((p) => p.id === studentId));
    const d = await add({ workTitle: 'งานมีผู้เกี่ยวข้อง', peopleIds: [prId, adminId] });
    const w = `/api/document-works/${d.workId}`;
    assert.equal((await pr.call('GET', w)).body.work.people.length, 2);
    const { name } = (await pr.call('GET', w)).body.work.people[0];
    assert.ok((await ids(pr, `?q=${encodeURIComponent(name)}`)).includes(d.id), 'found by name');
    assert.equal((await pr.call('PUT', w, { workTitle: 'ชื่อใหม่', peopleIds: [studentId] })).status, 400);
    assert.equal((await pr.call('PUT', w, { workTitle: 'ชื่อใหม่', peopleIds: [prId, prId] })).status, 400);
    assert.equal((await pr.call('PUT', w, { workTitle: 'ชื่อใหม่', peopleIds: Array(6).fill(UUID) })).status, 400);
    assert.equal((await pr.call('PUT', w, { workTitle: ' ' })).status, 400);
    const r = await pr.call('PUT', w, { workTitle: 'ชื่อใหม่', peopleIds: [adminId] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.work.people.map((p) => p.id), [adminId]);
    assert.ok(await one('select 1 from audit_log where action = $1 and target = $2', ['document.work', d.workId]));
  });
  test('one save changes the document and its งาน together; a bad งาน changes neither', async () => {
    const adminId = (await admin.call('GET', '/api/me')).body.user.id;
    const d = await add({ title: 'ชื่อเอกสารเดิม', workTitle: 'ชื่องานเดิม' });
    const url = `/api/documents/${d.id}`, work = `/api/document-works/${d.workId}`;
    const bad = await pr.call('PUT', url, info({ title: 'ชื่อที่ไม่ควรเข้า', workTitle: ' ' }));
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.workTitle);
    assert.equal((await pr.call('GET', url)).body.document.title, 'ชื่อเอกสารเดิม');
    const r = await pr.call('PUT', url, info({ title: 'ชื่อเอกสารใหม่', workTitle: 'ชื่องานใหม่', peopleIds: [adminId] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.document.title, 'ชื่อเอกสารใหม่');
    const w = (await pr.call('GET', work)).body.work;
    assert.equal(w.title, 'ชื่องานใหม่');
    assert.deepEqual(w.people.map((p) => p.id), [adminId]);
    assert.equal((await pr.call('PUT', url, info({ title: 'แก้เฉพาะเอกสาร' }))).status, 200);
    assert.equal((await pr.call('GET', work)).body.work.title, 'ชื่องานใหม่', 'left out: the งาน stays');
  });
  test('ผู้เกี่ยวข้อง get no rights: a named person still cannot open a private document of someone else', async () => {
    const prId = (await pr.call('GET', '/api/me')).body.user.id;
    const d = await add({ accessLevel: 'private', peopleIds: [prId] }, file(), admin);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}/file`)).status, 403);
  });
});

describe('team or personal', () => {
  test('a personal document opens for the uploader and admin, nobody else', async () => {
    const d = await add({ title: 'ส่วนตัวของคนหนึ่งทดสอบ', accessLevel: 'private' }, file(), admin);
    const mine = await add({ title: 'ส่วนตัวของ PR ทดสอบ', accessLevel: 'private' });
    const doc = `/api/documents/${d.id}`, work = `/api/document-works/${d.workId}`;
    assert.ok((await ids(admin)).includes(d.id));
    assert.ok(!(await ids(pr)).includes(d.id));
    assert.ok(!(await ids(pr, `?q=${encodeURIComponent('ส่วนตัวของคนหนึ่ง')}`)).includes(d.id));
    assert.equal((await pr.call('GET', work)).status, 403);
    assert.equal((await pr.call('PUT', work, { workTitle: 'ยึด' })).status, 403);
    assert.equal((await pr.call('POST', '/api/documents', form(info({ workId: d.workId }), file()))).status, 403);
    assert.equal((await pr.call('GET', doc)).status, 403);
    assert.equal((await pr.call('GET', `${doc}/file`)).status, 403);
    assert.equal((await pr.call('GET', `${doc}/file?version=1`)).status, 403);
    assert.equal((await pr.call('PUT', doc, info())).status, 403);
    assert.equal((await pr.call('POST', `${doc}/versions`, form({}, file()))).status, 403);
    assert.equal((await pr.call('POST', `${doc}/archive`, {})).status, 403);
    assert.equal((await pr.call('POST', `${doc}/restore`, {})).status, 403);
    assert.equal((await pr.call('GET', `/api/documents/${mine.id}/file`)).status, 200);
    assert.equal((await admin.call('GET', `/api/documents/${mine.id}/file`)).status, 200);
  });
  test('in one งาน, a teammate sees the documents of the team only', async () => {
    const shared = await add({ workTitle: 'งานปนกันทดสอบ' });
    const hidden = await add({ title: 'ลับในงานเดียวกัน', workId: shared.workId, accessLevel: 'private' }, file(), admin);
    const work = `/api/document-works/${shared.workId}`;
    assert.deepEqual((await pr.call('GET', work)).body.work.documents.map((d) => d.id), [shared.id]);
    assert.deepEqual((await admin.call('GET', work)).body.work.documents.map((d) => d.id), [shared.id, hidden.id]);
    assert.equal((await works(pr)).find((w) => w.id === shared.workId).documents.length, 1);
  });
  test('only the uploader and admin switch between team and personal', async () => {
    const d = await add({}, file(), admin);
    const url = `/api/documents/${d.id}`;
    assert.equal((await pr.call('PUT', url, info({ accessLevel: 'private' }))).status, 403);
    assert.equal((await pr.call('PUT', url, info({ accessLevel: 'team' }))).status, 200);
    assert.equal((await admin.call('PUT', url, info({ accessLevel: 'private' }))).body.document.accessLevel, 'private');
    const mine = await add();
    const own = `/api/documents/${mine.id}`;
    assert.equal((await pr.call('PUT', own, info({ accessLevel: 'private' }))).body.document.accessLevel, 'private');
    assert.equal((await admin.call('PUT', own, info({ accessLevel: 'team' }))).body.document.accessLevel, 'team');
    assert.equal((await pr.call('PUT', own, info())).body.document.accessLevel, 'team', 'left out: stays as it was');
  });
});

describe('who may do what', () => {
  test('only PR and admin: every other role gets 403 on every route, the signed-out 401', async () => {
    const d = await add();
    const routes = [['GET', '/api/document-works'], ['GET', '/api/document-works/people'], ['GET', `/api/document-works/${d.workId}`], ['PUT', `/api/document-works/${d.workId}`, { workTitle: 'ทดสอบ' }], ['GET', `/api/documents/${d.id}`], ['GET', `/api/documents/${d.id}/file`], ['PUT', `/api/documents/${d.id}`, info()],
      ['POST', `/api/documents/${d.id}/archive`, {}], ['POST', `/api/documents/${d.id}/restore`, {}]];
    const uploads = [['POST', '/api/documents'], ['POST', `/api/documents/${d.id}/versions`]];
    for (const [who, status] of [[student, 403], [secretary, 403], [executive, 403], [staff, 403], [external, 403], [anon, 401]]) {
      for (const [method, path, body] of routes) assert.equal((await who.call(method, path, body)).status, status, `${method} ${path}`);
      for (const [method, path] of uploads) assert.equal((await who.call(method, path, form(info(), file()))).status, status, path);
    }
    assert.equal((await one('select version from documents where id = $1', [d.id])).version, 1);
  });
  test('unknown ids answer 404', async () => {
    for (const id of [UUID, 'not-an-id']) {
      assert.equal((await pr.call('GET', `/api/document-works/${id}`)).status, 404);
      assert.equal((await pr.call('GET', `/api/documents/${id}`)).status, 404);
      assert.equal((await pr.call('GET', `/api/documents/${id}/file`)).status, 404);
      assert.equal((await pr.call('PUT', `/api/documents/${id}`, info())).status, 404);
      assert.equal((await pr.call('POST', `/api/documents/${id}/archive`, {})).status, 404);
      assert.equal((await pr.call('POST', `/api/documents/${id}/versions`, form({}, file()))).status, 404);
    }
  });
});

describe('documents.html', () => {
  test('the page opens but stays out of search results', async () => {
    const r = await anon.call('GET', '/documents.html');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
  });
  test('PDF.js for the previews is served from this site, as a script', async () => {
    const page = (await anon.call('GET', '/documents.html')).body.toString();
    const [dir] = /\/assets\/pdfjs-[0-9.]+\//.exec(page);
    for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
      const r = await anon.call('GET', `${dir}${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.headers.get('content-type'), /javascript/, f);
    }
  });
});

describe('PDPA', () => {
  test('the export lists what the person uploaded; erasing keeps the document without the person', async () => {
    const d = await add({ title: 'เอกสารของผู้ส่งออก' });
    assert.ok((await pr.call('GET', '/api/me/data')).body.documentsUploaded.some((x) => x.title === d.title));

    const u = await one(`insert into users (email, name, role) values ($1, 'ผู้อัปโหลดทดสอบ', 'staff') returning id`, [TEMP_EMAIL]);
    await query('update documents set uploaded_by = $1 where id = $2', [u.id, d.id]);
    await query('update document_versions set uploaded_by = $1 where document_id = $2', [u.id, d.id]);
    await query('insert into document_work_people (work_id, user_id) values ($1, $2)', [d.workId, u.id]);
    await tx((c) => erase(c, u.id));
    assert.equal((await one('select uploaded_by from documents where id = $1', [d.id])).uploaded_by, null);
    assert.equal((await one('select uploaded_by from document_versions where document_id = $1', [d.id])).uploaded_by, null);
    assert.equal(await one('select 1 from document_work_people where user_id = $1', [u.id]), null);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}`)).body.document.uploader, null);
  });
});
