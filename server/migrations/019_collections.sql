-- =========================================================================
-- ชุดข่าว (collections): the stories of one event or project, in the order the PR team arranged them.
-- One page (collection.html?id=) and a strip on each story's page. A story may be in more than one set.
-- =========================================================================
create table if not exists collections (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  description text check (length(description) <= 1000),
  items uuid[] not null default '{}',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- "Which sets is this story in" (news.html)
create index if not exists collections_items on collections using gin (items);
