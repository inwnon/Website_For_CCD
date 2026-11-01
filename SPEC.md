# SPEC.md — Corporate Communication Management System (ระบบบริหารงานสื่อสารองค์กร)

Built as new back-office modules inside the existing newsroom codebase (คลังข่าว มรส., repo `inwnon/Website_For_CCD`, live at ccd2569.cloud). Reuse what exists; do not rebuild it.

## 1. Goal
One web app for the Corporate Communication office: the existing newsroom plus a work calendar with assignments and reminders, document archive, equipment, unit phone book, and student team management.
Success looks like: the team plans people, time, and equipment in one place instead of chats and spreadsheets.

## 2. Users and roles
Base role comes from the Google email domain (existing `rules.mjs`): `sru.ac.th` → `staff`, `student.sru.ac.th` → `student`, anything else → `external`. Elevated roles live in `pr_team` (existing: `pr`, `admin`, `coordinator`, `intern`; add `secretary`, `executive`).

| Role | Who | New modules |
|---|---|---|
| `admin` | developer, full control | all |
| `pr` | PR staff (นักประชาสัมพันธ์) | run calendar, requests, documents, equipment, students |
| `student` (domain) | student team members | own assignments, own hours, equipment requests |
| `secretary` (new) | executive secretaries | view calendar, submit service requests |
| `executive` (new) | executives | view calendar and dashboard |
| `staff` (domain) | other university staff | phone book only |
| `coordinator`, `intern` | existing newsroom roles | as their base (domain) role |
| `external` | non-university Google accounts | **none** — newsroom submit only, 403 on every new module |
| public (no login) | anyone | newsroom + public calendar |

### Permission matrix (new modules)
| Module | admin | pr | student | secretary | executive | staff | external / public |
|---|---|---|---|---|---|---|---|
| Calendar | all | create/edit/assign | own + team | view + create, edit and assign own (no internal notes) | view | — | public events only |
| Service requests | all | approve/reject | — | create + track own | view | — | — |
| Documents | all | all | — | — | — | — | — |
| Equipment | all | all | view + request loan | — | — | — | — |
| Phone book | all | edit | view | view | view | view | — |
| Students | all | manage/approve | own record | — | summary | — | — |
| Dashboard | all | view | — | — | view | — | — |

Newsroom permissions stay exactly as they are today.

## 3. Pages
Existing pages are unchanged. New pages follow the repo pattern (one `.html` per page, shared `auth.js`, `desk.js`, `desk.css`, `thai-date.js`).

| Page | Purpose | Access |
|---|---|---|
| `index.html` | newsroom home + public calendar section | public |
| `calendar.html` | work calendar (main back-office page) | per matrix |
| `requests.html` | service requests (e.g. photographer) | secretary, pr, admin |
| `documents.html` | document archive & search | pr, admin |
| `equipment.html` | equipment register & loans | pr, admin; student (view/request) |
| `phonebook.html` | unit phone numbers | any university role |
| `students.html` | student team | per matrix |
| `report.html` (extend) | dashboard | executive, pr, admin |
| `chanon.html` (renamed from `admin.html`) | system admin, roles, audit, backups | admin |

`admin.html` → permanent redirect (301) to `chanon.html`, so links in old emails and bookmarks keep working. API paths (`/api/admin/...`) stay unchanged.

## 4. Features (priority order)

### Phase 0 — integration (Must, first)
1. Migration: add `secretary`, `executive` to the `pr_team` role check.
2. One shared access helper for new modules (role → module rights per §2); `external` always denied.
3. Back-office navigation entries for the new pages, shown per role.

### Phase 1 — core (Must)
4. Calendar: day/week/month views; create/edit events; assign people with a duty.
5. Event visibility `internal` (default) | `public`; public events on `index.html`.
6. Notifications on assignment and the day before: in-app + email via the existing `email_outbox`.
7. Phone book: CRUD + search + import from Excel/CSV (unit numbers only).
8. All changes written to the existing `audit_log`.

### Phase 2 — daily operations (Must)
9. Service requests: secretary submits → pr approves/rejects → approved request becomes a calendar event.
10. Documents: cards with a preview; one งาน holds many documents and up to 5 ผู้เกี่ยวข้อง (PR or admin accounts, shown and searchable, no rights); categories คำสั่งมหาวิทยาลัย, คำสั่งจากหน่วยงาน (names the unit), บันทึกข้อความขอความอนุเคราะห์, เอกสารอื่นๆ; tags; Thai search; each document is the team's or personal (uploader and admin only); several files at a time; each document has its own date; filters by category, file type, ผู้เกี่ยวข้อง, year, รอบประเมิน (1: April to September, 2: October to March) and team or personal; page numbers with 20, 40 or 60 งาน a page; versions; no delete.
11. Equipment: asset code, status (available / on loan / repair / retired), loan & return linked to an event, overdue list, double-booking blocked.

### Phase 3 — students & integrations (Should)
12. Student profiles (student code, faculty, year, phone, skills) — reuse `users` profile fields where they exist.
13. Assign students to events.
14. Work-hour log per event, approved by pr; summaries per student and period.
15. LINE notifications via Official Account (free plan; see §6).
16. iCal feeds: one public + one private per user, subscribable in Google Calendar.
17. Dashboard additions in `report.html`: events per month, equipment in use/overdue, student hours.

### Phase 4 — extras (Could)
18. Student evaluation form per period.
19. QR codes on equipment for scan-to-loan/return.
20. Excel export for new modules (existing `exceljs`).

Out of scope: compensation and any payment; native mobile app; registrar/finance integration; any paid or per-call API (incl. AI APIs); rewriting the newsroom.

## 5. Data
Reuse: `users`, `pr_team`, `sessions`, `audit_log`, `email_outbox`, `settings`, `job_runs`.
New tables (migrations `023_…` onward):
- `events` (id, title, type, location, start_at, end_at, status, visibility, description, internal_note, created_by)
- `event_assignments` (event_id, user_id, duty)
- `service_requests` (id, requester_id, title, type, start_at, end_at, location, details, status, review_note, reviewed_by, reviewed_at, event_id)
- `document_works` (id, title, created_by), `document_work_people` (work_id, user_id)
- `documents` (id, work_id, title, category, unit_name, doc_date, tags, access_level, version, search_text, uploaded_by, archived_at), `document_versions` (document_id, version, file_path, file_name, mime, size, uploaded_by)
- `equipment` (id, asset_code, name, category, serial, location, status)
- `equipment_loans` (id, equipment_id, borrower_id, event_id, out_at, due_at, returned_at, condition_note)
- `phonebook` (id, unit_name, phone_number, internal_number, note): one row per unit, at least one number
- `student_profiles` (user_id, student_code, faculty, year, phone, skills)
- `work_logs` (id, student_id, event_id, check_in, check_out, approved_by, approved_at)
- `notifications` (id, user_id, kind, ref_id, read_at, created_at)
- `evaluations` (Phase 4)

Personal data: student phone, student code, work hours, evaluations. Phone book = unit numbers only.
Never stored: bank accounts, national ID numbers.
Retention: anonymize student records 3 years after leaving (extend existing `privacy.mjs` jobs); documents follow university records rules.

## 6. Tech decisions (fixed — existing stack)
- Server: Node.js 22 + Express 5, ES modules, one file per module in `server/` (`calendar.mjs`, `requests.mjs`, …).
- DB: PostgreSQL 16 via `pg`; plain SQL migrations in `server/migrations/`, run by `migrate.mjs`. No ORM.
- Frontend: static `.html` pages + Tailwind built locally (`npm run build:css`); no CDN, no external assets.
- Auth: existing Google sign-in (`google-auth-library`) + session cookie; roles per §2.
- Files: existing `uploads/` folder and upload pipeline (`files.mjs`: content-type sniffing, GPS scrub); new folder `uploads/documents/`.
- Thai search: existing `thai.mjs` (`Intl.Segmenter`).
- Notifications: in-app + existing email outbox (SMTP); LINE free plan later; iCal instead of Google Calendar API.
- Runtime: existing `docker-compose.yml` (`db`, `app` profile) behind a host reverse proxy with HTTPS.
- Cost rule: no paid services or per-call APIs. Only the server costs money.

### Portability: Hostinger (dev) → university server (prod)
- Hostinger plan must be a **VPS** (Docker needs root).
- Same compose file on both; only `.env` differs (`APP_ORIGIN`, DB credentials, `GOOGLE_CLIENT_ID`, SMTP, LINE keys).
- Migration = existing `npm run backup` → restore on university server → switch DNS → `npm run db:migrate`.
- Add both origins to the Google OAuth client during cut-over.
- Hostinger holds test data only; real student data lives only on the university server.

### Zero-cost notification rules
- LINE free plan has a monthly cap; sending stops at the cap (verify current terms before launch).
- Push only: new assignment, request decision, one daily digest per user.
- Free reply messages for on-demand queries ("งานวันนี้").
- At 90% of the cap switch to in-app/email only and alert pr.

## 7. Security requirements
Already in the codebase — keep and reuse: CSP/HSTS/security headers and rate limits (`security.mjs`), Origin-based CSRF check (`http.mjs`), audit log, file content-type sniffing and GPS scrub, nightly backup + off-site copy + monthly restore test, PDPA tools.

New for these modules:
- Every new API route and page checks the §2 matrix server-side, including record IDs; `external` → 403.
- Public calendar returns only `title, start_at, end_at, location` of `public` events.
- Documents: allow PDF, DOCX, XLSX, PPTX, JPG, PNG; max 20 MB per document, 10 MB per image; no video; random stored names; download only through an authorized route.
- Optional ClamAV container for document uploads.
- iCal private tokens random, revocable, read-only; verify LINE webhook signatures.
- Session idle timeout 8h (align existing session settings).
- Server: firewall 80/443 + restricted SSH, key-only, no root login, fail2ban, unattended upgrades; DB bound to 127.0.0.1 (already).

## 8. Acceptance checks
- [ ] All existing newsroom tests still pass (`npm test`).
- [ ] `external` account can still submit news but gets 403 on every new page and API.
- [ ] Each role reaches only its modules; edited URLs/IDs get 403.
- [ ] Public visitor sees public events only, without assignees or internal notes.
- [ ] Secretary request → pr approval → event on calendar with assignees.
- [ ] Assignee gets in-app notification within 1 minute and an email via the outbox.
- [ ] Private iCal feed works in Google Calendar; revoked token stops working.
- [ ] LINE push counter stops pushes at 90% of the cap.
- [ ] Thai partial-word document search returns matches.
- [ ] Disallowed or oversized upload is rejected.
- [ ] Equipment on loan cannot be loaned again; overdue items listed.
- [ ] Student sees only own hours; unapproved hours excluded from summaries.
- [ ] Every change in new modules has an `audit_log` entry.
- [ ] Backup from Hostinger restores and runs on a fresh server with only `.env` changed.
- [ ] Repo quality bar holds: WCAG 2.1 AA, Thai line-height ≥ 1.6, Buddhist-era dates, no horizontal scroll at 390px.
