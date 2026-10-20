-- เล่มสรุปข่าว: each page as a picture made ahead (WebP, drawn in the PR team's browser when they approve the issue),
-- with the page's text (searched on digest.html and inside the reader) and where its links are (put back over the picture).
-- sig: the issue's layout when the pictures were made; a different layout now (a story withdrawn, the book edited)
-- means the pictures are out of date and the reader draws the pages itself again.
create table if not exists digest_pages (
  digest_id text not null references digests (id) on delete cascade,
  no integer not null check (no between 1 and 60),
  path text not null,          -- full page, 1240 px wide, under UPLOAD_DIR
  thumb text not null,         -- 240 px wide, for the page strip
  w integer not null,
  h integer not null,
  body text not null default '',
  links jsonb not null default '[]', -- [{ x, y, w, h (0–1 of the page), href | goto }]
  primary key (digest_id, no)
);
alter table digests add column if not exists pages_sig text;
create index if not exists digest_pages_body_idx on digest_pages using gin (body gin_trgm_ops);
