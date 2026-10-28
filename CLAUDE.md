# CLAUDE.md

## Project
คลังข่าว มรส. (university PR newsroom), being extended with back-office modules for the Corporate Communication office: calendar, service requests, documents, equipment, phone book, student team.
Stack (fixed): Node.js 22 + Express 5 (ESM `.mjs`) + PostgreSQL 16 via `pg` + plain SQL migrations + static HTML pages with locally built Tailwind. Do not add or swap libraries without asking.
Runs unchanged on Hostinger VPS (dev) and the university server (prod); only `.env` differs. No paid services or per-call APIs.
New-module requirements: @SPEC.md (read only when working on those modules). Server details: `server/README.md`.

## Commands
- DB: `npm run db:up` (PostgreSQL in Docker, port 5433) then `npm run db:migrate`
- Dev: `npm run dev` → http://localhost:3000 (pages + `/api`); restarts on `server/` changes
- Test: `npm test` (needs `npm run dev` running) — run after every change
- CSS: `npm run build:css` after any Tailwind class change; fonts `npm run build:fonts`; brand images `npm run build:images`
- Audit: `npm audit --omit=dev`
- Dev login (`ALLOW_DEV_LOGIN=1`): `POST /api/auth/dev` `{"as":"pr"}` — staff, student, external, pr, admin, coordinator

## Structure
- `server/<module>.mjs` one file per module · `server/migrations/NNN_name.sql` next free number · `server/test/<module>.test.mjs` cleans up its own data
- `<page>.html` page-specific script/style inline; shared: `auth.js`, `desk.js`, `desk.css`, `thai-date.js`
- `uploads/` user files, never served directly

## Reuse before writing
Auth/session `auth.mjs` · roles `rules.mjs` · errors/CSRF/validation `http.mjs` · headers/rate limit/file sniffing `security.mjs` · uploads `files.mjs` · audit `audit.mjs` · email `notify.mjs` · Thai search `thai.mjs` · retention `privacy.mjs` · reports/Excel `reports.mjs`.

## Security (non-negotiable)
- Never read, print, or commit `.env*` or credentials (also blocked in `.claude/settings.json`); use `.env.example` for names.
- Local/test database only; never production data. Never read `uploads/` (personal data).
- SQL only with parameters (`$1`). Validate all input server-side.
- Check authorization on the server for every route and record ID; in new modules follow SPEC §2 and always deny role `external`.
- Escape user content on output; no `innerHTML` with user data. Do not log secrets or personal data.
- Ask before: installing packages, deleting files, changing login/session or existing newsroom behavior.

## Frontend (always)
- No external requests from pages: no CDN, Google Fonts, or remote images; Tailwind is prebuilt (`/assets/app.css`).
- Quality bar: WCAG 2.1 AA (axe clean, keyboard everywhere), Thai line-height ≥ 1.6, Buddhist-era dates (`thai-date.js`), mobile LCP ≤ 2.5 s, CLS < 0.1, no horizontal scroll at 390px.
- Never `transition-all`; animate only `transform`/`opacity`; every clickable element has hover, focus-visible, active.
- Designing a new page or changing a page's look → load skill `ccd-ui` first. Not needed for API work, bug fixes, or copy edits.
- Screenshots only from localhost, never `file:///`.

## Token rules
- One small task per session. Say what you will change before changing it.
- Grep before opening; read only needed files; never dump directories or large logs.
- Targeted edits, no whole-file rewrites. No repeating code back; short replies.
- Reuse helpers; no speculative features. Ask one question only when a wrong guess is costly.

## Workflow
1. Read the relevant files.
2. Plan in 3–5 bullets; wait for OK if it touches auth, data, or newsroom behavior, or 3+ files.
3. Failing API test first for new logic when practical; smallest change that works.
4. `npm test` — all existing tests must pass.
5. Summarize in Thai: what changed, which files, what to verify.

## Done means
Tests pass · no new high/critical `npm audit` findings · no secrets, debug code, or commented-out blocks · changes in new modules logged in `audit_log`.
