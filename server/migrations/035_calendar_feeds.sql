-- iCal feeds (SPEC.md item 16, §7): one private read-only link per user. Only the SHA-256 of the token is kept,
-- so the link is shown once; a new link replaces the old one, and deleting the row revokes it.
create table calendar_feeds (
  user_id uuid primary key references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
