-- คำขอใช้บริการ: PR asks the requester for more (status info, รอข้อมูลเพิ่ม), the requester answers; files sent with the
-- request or with an answer (uploads/requests/{request id}/, downloaded only through /api/requests/:id/files/:fileId)
alter table service_requests drop constraint service_requests_status_check;
alter table service_requests add constraint service_requests_status_check check (status in ('pending', 'info', 'approved', 'rejected', 'cancelled'));

create table service_request_messages (
  id bigserial primary key,
  request_id uuid not null references service_requests (id) on delete cascade,
  author_id uuid references users (id) on delete set null,
  kind text not null check (kind in ('ask', 'reply')), -- ask: PR wants more; reply: the requester's answer
  body text not null default '' check (length(body) <= 2000),
  created_at timestamptz not null default now(),
  check (kind = 'reply' or length(body) > 0) -- an answer may be files only
);
create index service_request_messages_request_idx on service_request_messages (request_id, created_at);
create index service_request_messages_reply_idx on service_request_messages (created_at) where kind = 'reply';

create table service_request_files (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references service_requests (id) on delete cascade,
  message_id bigint references service_request_messages (id) on delete cascade, -- null: sent with the request
  file_path text not null,
  file_name text not null check (length(file_name) between 1 and 255),
  mime text not null,
  size bigint not null check (size > 0),
  uploaded_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index service_request_files_request_idx on service_request_files (request_id, created_at);
