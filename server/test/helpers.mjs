// Shared by the API tests: dev-login sessions, multipart forms, sample images
import assert from 'node:assert/strict';
import sharp from 'sharp';

export const BASE = process.env.TEST_BASE || 'http://localhost:3000';
export const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
export const img = (color, width = 2400, height = 1600) => sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
// A picture with GPS data, for the tests that it is removed
export const gpsPhoto = () => sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } })
  .withExif({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '9/1 8/1 3000/100', GPSLongitudeRef: 'E', GPSLongitude: '99/1 20/1 1234/100' } })
  .jpeg().toBuffer();
// TIFF inside the EXIF block: the number of entries left in the GPS directory
export function gpsEntries(exif) {
  const t = exif.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0;
  const le = exif[t] === 0x49;
  const u16 = (o) => (le ? exif.readUInt16LE(t + o) : exif.readUInt16BE(t + o)), u32 = (o) => (le ? exif.readUInt32LE(t + o) : exif.readUInt32BE(t + o));
  const ifd0 = u32(4);
  for (let i = 0; i < u16(ifd0); i++) if (u16(ifd0 + 2 + i * 12) === 0x8825) return u16(u32(ifd0 + 2 + i * 12 + 8));
  return null;
}

// as: staff, student, external, pr, admin, coordinator, secretary, executive (see DEV in auth.mjs)
export async function login(as) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = (method, path, body, headers = {}) => request(method, path, body, { cookie, ...headers });
  return { cookie, call };
}

/** @returns {Promise<{ status: number, headers: Headers, body: any }>} */
export async function request(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + path, opts);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
// Name and phone for PUT /api/me/profile: staff give a 4-digit extension, students and external users a phone number
export const ID_STAFF = { firstName: 'สมชาย', lastName: 'ใจดี', phone: '1234' };
export const ID_OTHER = { firstName: 'สมหญิง', lastName: 'รักเรียน', phone: '081-234-5678' };
export const anon = { call: (method, path, body, headers) => request(method, path, body, headers) };

// Work sent in tests gives a contact unless the test sets contactKind / contactValue itself
export function form(data, files = {}) {
  const fd = new FormData();
  fd.append('data', JSON.stringify(data?.type ? { contactKind: 'phone', contactValue: '077-913-333', ...data } : data));
  for (const [kind, list] of Object.entries(files)) for (const [name, buf, type] of list) fd.append(kind, new Blob([buf], { type }), name);
  return fd;
}
