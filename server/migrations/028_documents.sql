-- คลังเอกสาร (SPEC.md Phase 2): one row per document, one per file it has had. Nothing here is deleted: the office keeps its records.
create table documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  category text not null check (category in ('official', 'report', 'form', 'media', 'other')),
  tags text[] not null default '{}',
  access_level text not null default 'team' check (access_level in ('team', 'admin')), -- team: PR and admin; admin: admin only
  version int not null default 1,         -- the current file in document_versions
  search_text text not null,              -- title, category, tags and the current file's name
  uploaded_by uuid references users (id) on delete set null,
  archived_at timestamptz,                -- hidden from the list; the files stay
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_updated_idx on documents (updated_at desc);

create table document_versions (
  document_id uuid not null references documents (id) on delete cascade,
  version int not null,
  file_path text not null,                -- under UPLOAD_DIR, with a random name
  file_name text not null check (length(file_name) between 1 and 255), -- as uploaded, for the download
  mime text not null,
  size bigint not null,
  uploaded_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (document_id, version)
);
