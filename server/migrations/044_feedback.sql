-- แจ้งปัญหาการใช้งานระบบ (contact.html → กล่องแจ้งปัญหาใน pr.html). Anyone may send one, signed in or not.
create table feedback (
  id bigint generated always as identity primary key,
  message text not null check (length(message) between 1 and 2000),
  page text check (length(page) <= 200),          -- the page the problem is on, as the sender wrote it
  contact text check (length(contact) <= 200),    -- how to reach the sender back (optional)
  user_agent text check (length(user_agent) <= 300),
  sender_id uuid references users (id) on delete set null,
  status text not null default 'new' check (status in ('new', 'done')),
  done_by uuid references users (id) on delete set null,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index feedback_status_idx on feedback (status, created_at desc);
