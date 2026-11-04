-- แบนเนอร์กำหนดการ: up to 2 pictures per event (the limit is checked in calendar.mjs), shown wherever the event is
create table event_banners (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  file_path text not null, -- events/{event id}/{banner id}.webp under UPLOAD_DIR
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index event_banners_event_idx on event_banners (event_id, created_at);
