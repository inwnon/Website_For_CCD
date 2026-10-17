-- =========================================================================
-- Phase 10: PDPA
-- =========================================================================
-- Requests from users about their own data (privacy.html → ขอลบข้อมูล). Admins handle them on admin.html.
create table if not exists data_requests (
  id bigserial primary key,
  user_id uuid references users (id) on delete set null,
  email text not null,                 -- the address at the time of the request (kept after the account is erased)
  kind text not null default 'delete' check (kind in ('delete')),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'done', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references users (id) on delete set null,
  note text
);
create unique index if not exists data_requests_one_open on data_requests (user_id) where status = 'pending';

-- Accounts erased on request keep their row (published stories still point to the sender) but nothing personal
alter table users add column if not exists erased_at timestamptz;

-- Files of work that was never published are removed after the retention period (settings: retention.days)
alter table submissions add column if not exists files_purged_at timestamptz;
