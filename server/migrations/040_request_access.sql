-- คำขอสิทธิ์ใช้บริการ: a university staff account asks to use คำขอใช้บริการ like a secretary; PR or admin decides.
-- Approved lasts until an admin revokes it (the row is deleted). Rights follow the email, like pr_team.
create table request_access (
  id bigint generated always as identity primary key,
  email text not null unique check (email = lower(email)),
  reason text check (length(reason) <= 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_note text check (length(review_note) <= 1000), -- shown to the asker; a rejection always has one
  reviewed_by uuid references users (id) on delete set null,
  reviewed_at timestamptz,
  asked_at timestamptz not null default now(),
  check (status <> 'rejected' or review_note is not null)
);
