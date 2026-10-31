-- ปฏิทินงาน (SPEC.md Phase 1): events, who is assigned, and in-app notifications
create table events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 200),
  type text not null check (type in ('meeting', 'activity', 'media', 'other')),
  location text check (length(location) <= 200),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  visibility text not null default 'internal' check (visibility in ('internal', 'public')),
  description text check (length(description) <= 2000),
  internal_note text check (length(internal_note) <= 2000), -- PR and admin only, never public
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index events_start_idx on events (start_at);
create index events_public_idx on events (start_at) where visibility = 'public' and status = 'scheduled';

create table event_assignments (
  event_id uuid not null references events (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  duty text not null check (length(duty) between 1 and 120),
  reminded_at timestamptz, -- the day-before reminder went out; cleared when the event moves
  primary key (event_id, user_id)
);
create index event_assignments_user_idx on event_assignments (user_id);

create table notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references users (id) on delete cascade,
  kind text not null,  -- event.assigned, event.reminder, event.cancelled
  ref_id text,         -- the event id
  text text not null check (length(text) <= 300),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, id desc);
