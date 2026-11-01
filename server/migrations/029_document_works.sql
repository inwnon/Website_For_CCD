-- คลังเอกสาร, the team's brief: one งาน holds many documents and up to 5 ผู้เกี่ยวข้อง; new categories; each document is the team's or personal.
create table document_works (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Shown on the งาน and found by search. Gives no rights to anything.
create table document_work_people (
  work_id uuid not null references document_works (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  primary key (work_id, user_id)
);

-- Every document so far becomes a งาน of its own, with the same id
insert into document_works (id, title, created_by, created_at, updated_at) select id, title, uploaded_by, created_at, updated_at from documents;
alter table documents add column work_id uuid references document_works (id) on delete restrict;
update documents set work_id = id;
alter table documents alter column work_id set not null;
create index documents_work_idx on documents (work_id);

alter table documents add column unit_name text check (length(unit_name) <= 200);
alter table documents drop constraint documents_category_check;
update documents set category = 'other';
alter table documents add constraint documents_category_check check (category in ('university_order', 'unit_order', 'request_memo', 'other'));
alter table documents add constraint documents_unit_check check ((category = 'unit_order') = (unit_name is not null));

-- private opens for the uploader and admin. A document an admin had closed to PR stays closed: its uploader may be a PR account.
update documents d set uploaded_by = null where access_level = 'admin'
  and not exists (select 1 from users u join pr_team t on t.email = u.email where u.id = d.uploaded_by and t.role = 'admin');
alter table documents drop constraint documents_access_level_check;
update documents set access_level = 'private' where access_level = 'admin';
alter table documents add constraint documents_access_level_check check (access_level in ('team', 'private'));
