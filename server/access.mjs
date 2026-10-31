// Who may use the back-office modules (SPEC.md §2). Newsroom permissions are not here: they stay in auth.mjs and news.mjs.
// Every route of a new module goes through requireModule; rights of one record (own, team) are checked in the module itself.
import { HttpError } from './http.mjs';
import { domainRole } from './rules.mjs';

// module → role → right. A role not listed has no right to the module.
const MATRIX = {
  calendar: { admin: 'all', pr: 'edit', student: 'own', secretary: 'request', executive: 'view' },
  requests: { admin: 'all', pr: 'approve', secretary: 'own', executive: 'view' },
  documents: { admin: 'all', pr: 'all' },
  equipment: { admin: 'all', pr: 'all', student: 'request' },
  phonebook: { admin: 'all', pr: 'edit', student: 'view', secretary: 'view', executive: 'view', staff: 'view' },
  students: { admin: 'all', pr: 'manage', student: 'own', executive: 'summary' },
  dashboard: { admin: 'all', pr: 'view', executive: 'view' },
};

// The role that counts here: coordinators and interns are what their email makes them.
// A secretary or executive outside the university's domains stays external: external is always denied.
function moduleRole(u) {
  if (u.role === 'admin' || u.role === 'pr') return u.role;
  const domain = domainRole(u.email);
  return domain !== 'external' && (u.role === 'secretary' || u.role === 'executive') ? u.role : domain;
}

export const rightOf = (u, module) => (u ? MATRIX[module]?.[moduleRole(u)] ?? null : null);
// The modules this user may open (GET /api/me, for the menus)
export const modulesOf = (u) => Object.keys(MATRIX).filter((m) => rightOf(u, m));

// Anyone with at least one module (notifications): external accounts have none
export const requireBackOffice = (req, res, next) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  if (!modulesOf(req.user).length) throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้');
  next();
};

// requireModule('calendar') for any right; requireModule('calendar', 'all', 'edit') for those rights only
export const requireModule = (module, ...rights) => (req, res, next) => {
  if (!req.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  const right = rightOf(req.user, module);
  if (!right || (rights.length && !rights.includes(right))) throw new HttpError(403, 'บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้');
  next();
};
