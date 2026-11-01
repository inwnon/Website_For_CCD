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
const info = (over = {}) => ({ title: 'เอกสารทดสอบคลัง', category: 'report', tags: ['ทดสอบ'], ...over });
/** @param {string} [name] @param {Buffer} [buf] @param {string} [type] */
const file = (name = 'รายงาน.pdf', buf = PDF, type = 'application/pdf') => ({ file: [[name, buf, type]] });

let snap, pr, admin, student, secretary, executive, staff, external;
const add = async (over, f = file(), who = pr) => {
  const r = await who.call('POST', '/api/documents', form(info(over), f));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.document;
};
const ids = async (who, q = '') => (await who.call('GET', `/api/documents${q}`)).body.items.map((d) => d.id);

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
    assert.ok((await pr.call('GET', `/api/documents?q=${encodeURIComponent('ฉบับใหม่')}`)).body.items.some((x) => x.id === d.id), 'the new name can be found');
  });
  test('versions added at the same time get their own numbers', async () => {
    const d = await add();
    const all = await Promise.all([1, 2, 3].map(() => pr.call('POST', `/api/documents/${d.id}/versions`, form({}, file()))));
    assert.deepEqual(all.map((r) => r.status), [201, 201, 201]);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}`)).body.document.version, 4);
  });
  test('editing changes the details, not the file', async () => {
    const d = await add();
    const r = await pr.call('PUT', `/api/documents/${d.id}`, info({ title: 'ชื่อใหม่ทดสอบ', category: 'form', tags: ['ใหม่', 'ใหม่', ' แบบฟอร์ม '] }));
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
    const d = await add({ title: 'รายงานประจำปีงบประมาณ', category: 'official', tags: ['ค่ายอาสา'] }, file('สรุปผลโครงการ.pdf'));
    for (const q of ['งบประมาณ', 'ประมา', 'งบประมาณรายงาน', 'ค่ายอา', 'หนังสือราชการ', 'สรุปผล']) {
      assert.ok((await ids(pr, `?q=${encodeURIComponent(q)}`)).includes(d.id), q);
    }
    assert.equal((await ids(pr, `?q=${encodeURIComponent('ไม่มีคำนี้เลยในคลัง')}`)).length, 0);
  });
  test('the list filters by category; unknown filters are refused', async () => {
    const d = await add({ category: 'media' });
    assert.ok((await ids(pr, '?category=media')).includes(d.id));
    assert.ok(!(await ids(pr, '?category=form')).includes(d.id));
    assert.equal((await pr.call('GET', '/api/documents?category=x')).status, 400);
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
  test('nothing can delete a document', async () => {
    const d = await add();
    assert.equal((await admin.call('DELETE', `/api/documents/${d.id}`)).status, 404);
  });
});

describe('access levels', () => {
  test('a document for admins only: PR cannot reach it by list, search or id', async () => {
    const d = await add({ title: 'ลับเฉพาะผู้ดูแลทดสอบ', accessLevel: 'admin' }, file(), admin);
    assert.ok((await ids(admin)).includes(d.id));
    assert.ok(!(await ids(pr)).includes(d.id));
    assert.ok(!(await ids(pr, `?q=${encodeURIComponent('ลับเฉพาะผู้ดูแล')}`)).includes(d.id));
    assert.equal((await pr.call('GET', `/api/documents/${d.id}`)).status, 403);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}/file`)).status, 403);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}/file?version=1`)).status, 403);
    assert.equal((await pr.call('PUT', `/api/documents/${d.id}`, info())).status, 403);
    assert.equal((await pr.call('POST', `/api/documents/${d.id}/versions`, form({}, file()))).status, 403);
    assert.equal((await pr.call('POST', `/api/documents/${d.id}/archive`, {})).status, 403);
    assert.equal((await pr.call('POST', `/api/documents/${d.id}/restore`, {})).status, 403);
    assert.equal((await admin.call('GET', `/api/documents/${d.id}/file`)).status, 200);
  });
  test('only an admin sets the level', async () => {
    assert.equal((await pr.call('POST', '/api/documents', form(info({ accessLevel: 'admin' }), file()))).status, 403);
    const d = await add();
    assert.equal((await pr.call('PUT', `/api/documents/${d.id}`, info({ accessLevel: 'admin' }))).status, 403);
    assert.equal((await pr.call('PUT', `/api/documents/${d.id}`, info({ accessLevel: 'team' }))).status, 200);
    assert.equal((await admin.call('PUT', `/api/documents/${d.id}`, info({ accessLevel: 'admin' }))).body.document.accessLevel, 'admin');
    assert.equal((await admin.call('PUT', `/api/documents/${d.id}`, info())).body.document.accessLevel, 'admin', 'left out: stays as it was');
  });
});

describe('who may do what', () => {
  test('only PR and admin: every other role gets 403 on every route, the signed-out 401', async () => {
    const d = await add();
    const routes = [['GET', '/api/documents'], ['GET', `/api/documents/${d.id}`], ['GET', `/api/documents/${d.id}/file`], ['PUT', `/api/documents/${d.id}`, info()],
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
      assert.equal((await pr.call('GET', `/api/documents/${id}`)).status, 404);
      assert.equal((await pr.call('GET', `/api/documents/${id}/file`)).status, 404);
      assert.equal((await pr.call('PUT', `/api/documents/${id}`, info())).status, 404);
      assert.equal((await pr.call('POST', `/api/documents/${id}/archive`, {})).status, 404);
      assert.equal((await pr.call('POST', `/api/documents/${id}/versions`, form({}, file()))).status, 404);
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
    await tx((c) => erase(c, u.id));
    assert.equal((await one('select uploaded_by from documents where id = $1', [d.id])).uploaded_by, null);
    assert.equal((await one('select uploaded_by from document_versions where document_id = $1', [d.id])).uploaded_by, null);
    assert.equal((await pr.call('GET', `/api/documents/${d.id}`)).body.document.uploader, null);
  });
});
