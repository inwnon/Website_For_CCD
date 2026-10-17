// Small HTTP helpers shared by the routes

// Throw `new HttpError(400, 'ข้อความ')` from a route; the error handler turns it into JSON
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Express 5 forwards rejected promises to the error handler, so routes can be plain async functions
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'ข้อมูลมีขนาดใหญ่เกินไป' });
  // Postgres check / foreign key violations mean the client sent something invalid
  if (err.code === '23514' || err.code === '23503' || err.code === '22P02') {
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  }
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' });
}

// CSRF guard: requests that change data must come from our own pages
export function sameOrigin(allowed) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== allowed) return res.status(403).json({ error: 'คำขอนี้ไม่ได้มาจากเว็บไซต์ของเรา' });
    next();
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Trimmed string or null; throws if longer than max
export function str(v, max, label) {
  if (v == null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${label} ไม่ถูกต้อง`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${label} ยาวเกิน ${max} ตัวอักษร`);
  return s || null;
}
