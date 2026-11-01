-- คำขอใช้บริการ (SPEC.md Phase 2): a secretary asks, PR decides; an approved request becomes a calendar event
create table service_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references users (id) on delete set null,
  title text not null check (length(title) between 1 and 200), -- becomes the event's title
  type text not null check (type in ('photo', 'video', 'news', 'other')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  location text not null check (length(location) between 1 and 200),
  details text check (length(details) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  review_note text check (length(review_note) <= 1000), -- shown to the requester; a rejection always has one
  reviewed_by uuid references users (id) on delete set null,
  reviewed_at timestamptz,
  event_id uuid references events (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_at > start_at),
  check (status <> 'rejected' or review_note is not null)
);
create index service_requests_requester_idx on service_requests (requester_id, created_at desc);
create index service_requests_created_idx on service_requests (created_at desc);
