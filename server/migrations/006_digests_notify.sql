-- =========================================================================
-- Phase 8: digests made on digest-studio.html
-- groups: [{ cat, ids }] saved once PR edits the book (edited = true); until then the server lays out
-- the stories itself. Stories that are not in groups are "ไม่ได้ลงเล่ม" (worked out, not stored).
-- =========================================================================
alter table digests add column if not exists edited boolean not null default false;
alter table digests add column if not exists cover_meta jsonb;   -- { name, size, w, h }
alter table digests add column if not exists pdf_meta jsonb;     -- { name, size, pages, notA4 }
alter table digests add column if not exists shelf_path text;    -- first page of the PDF, for shelves

-- =========================================================================
-- Phase 9: email notifications
-- Every email goes through the outbox in the same transaction as the change it reports;
-- a worker sends what is queued (SMTP from .env). Without SMTP the rows stay 'skipped' so
-- they can still be read on admin.html.
-- =========================================================================
create table if not exists email_outbox (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  kind text not null,               -- submission.status, submission.message, pr.new, pr.resent, pr.message, pr.daily, digest.reminder, test
  ref text,                         -- submission ref or digest id
  to_email text not null,
  subject text not null,
  body text not null,               -- plain text
  html text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  tries int not null default 0,
  error text,
  sent_at timestamptz
);
create index if not exists email_outbox_queued on email_outbox (id) where status = 'queued';
create index if not exists email_outbox_ref on email_outbox (kind, ref);

-- What each user wants by email (missing key = on): status, message, prNew, prDaily
alter table users add column if not exists notify jsonb not null default '{}';

-- Once-a-day jobs (morning summary): the last Bangkok day each one ran
create table if not exists job_runs (
  name text primary key,
  last_day date not null
);
