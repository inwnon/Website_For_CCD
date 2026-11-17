-- รูปภาพที่แนบมากับการแจ้งปัญหา (contact.html), up to 3 per report. Re-encoded to WebP; read only by the PR team and admin.
create table feedback_files (
  id uuid primary key default gen_random_uuid(),
  feedback_id bigint not null references feedback (id) on delete cascade,
  file_path text not null,                                          -- feedback/{feedback id}/{random id}.webp under uploads/
  file_name text not null check (length(file_name) between 1 and 255), -- as the sender named it, shown to the PR team
  size bigint not null check (size > 0),
  position smallint not null default 0,
  created_at timestamptz not null default now()
);
create index feedback_files_feedback_idx on feedback_files (feedback_id, position);
