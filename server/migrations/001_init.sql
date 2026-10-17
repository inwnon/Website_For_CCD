-- ข่าว มรส. — initial schema
-- Roles: staff (@sru.ac.th), student (@student.sru.ac.th), external (any other Google account),
--        pr / admin (emails listed in pr_team; they override the domain role).
-- Who may read or change what is checked in server/ (see server/access.mjs).

create type user_role as enum ('staff', 'student', 'external', 'pr', 'admin');
create type submission_type as enum ('news', 'video', 'banner');
-- review: รอ PR ตรวจ · writing: PR กำลังเขียนข่าว · revise: ขอให้แก้ไข · published · rejected
create type submission_status as enum ('review', 'writing', 'revise', 'published', 'rejected');
create type audience as enum ('public', 'student', 'staff');
create type digest_kind as enum ('weekly', 'monthly');
create type digest_status as enum ('review', 'published');

create function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- =========================================================================
-- People and sessions
-- =========================================================================
create table pr_team (
  email text primary key check (email = lower(email)),
  role user_role not null default 'pr' check (role in ('pr', 'admin')),
  added_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  google_sub text unique,                 -- Google account id; null for dev-login accounts
  email text not null unique check (email = lower(email)),
  name text not null default '',
  avatar_url text,
  role user_role not null,
  unit text,
  sub_unit text,
  position text,
  major text,
  track text,
  year smallint check (year between 1 and 8),
  org text,
  consent_at timestamptz,                 -- PDPA step of login.html; null = sign-up not finished
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_touch before update on users for each row execute function touch_updated_at();

create table sessions (
  id text primary key,                    -- sha256 of the cookie token; the token itself is never stored
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expiry_idx on sessions (expires_at);

-- =========================================================================
-- Submissions (ส่งข่าว / วิดีโอ / แบนเนอร์)
-- =========================================================================
create table ref_counters (
  prefix text not null,
  year int not null, -- Buddhist year
  last int not null default 0,
  primary key (prefix, year)
);

-- NW-2569-0001, VD-2569-0001, BN-2569-0001
create function next_ref(p_type submission_type) returns text language plpgsql as $$
declare
  p text := case p_type when 'news' then 'NW' when 'video' then 'VD' else 'BN' end;
  y int := extract(year from now() at time zone 'Asia/Bangkok')::int + 543;
  n int;
begin
  insert into ref_counters as c (prefix, year, last) values (p, y, 1)
  on conflict (prefix, year) do update set last = c.last + 1
  returning last into n;
  return format('%s-%s-%s', p, y, lpad(n::text, 4, '0'));
end $$;

create table submissions (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  type submission_type not null,
  status submission_status not null,
  sender_id uuid not null references users (id) on delete restrict,
  unit text not null check (length(unit) between 1 and 200),
  title text not null check (length(title) between 1 and 120),
  lead text check (length(lead) <= 200),
  description text,
  body text,
  event_date date,
  place text check (length(place) <= 120),
  categories text[] not null default '{}' check (cardinality(categories) <= 5),
  content_mode text check (content_mode in ('own', 'pr')), -- news only: own = sender wrote it, pr = PR writes from attachments
  people jsonb not null default '{}', -- { chair: {name, pos}, reporter: {name, pos}, guests: [{name, pos}] }
  credit text check (length(credit) <= 80),
  news_video_url text,
  news_video_platform text check (news_video_platform in ('youtube', 'facebook', 'tiktok', 'drive')),
  video_mode text check (video_mode in ('link', 'file')),
  video_url text,
  video_platform text check (video_platform in ('youtube', 'facebook', 'tiktok', 'drive')),
  title_en text check (length(title_en) <= 160),
  body_en text,
  audience audience[] not null check (cardinality(audience) > 0),
  note text check (length(note) <= 300),
  sender_unread boolean not null default false, -- something new for the sender (inbox badge)
  pr_unread boolean not null default true,      -- something new for the PR team
  news_id uuid,                                 -- the published story (FK added below)
  sent_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index submissions_sender_idx on submissions (sender_id, sent_at desc);
create index submissions_status_idx on submissions (status, sent_at desc);
create trigger submissions_touch before update on submissions for each row execute function touch_updated_at();

create table submission_events (
  id bigint generated always as identity primary key,
  submission_id uuid not null references submissions (id) on delete cascade,
  status text not null, -- 'sent' or a submission_status
  actor_id uuid references users (id) on delete set null,
  at timestamptz not null default now()
);
create index submission_events_idx on submission_events (submission_id, at);

create table messages (
  id bigint generated always as identity primary key,
  submission_id uuid not null references submissions (id) on delete cascade,
  author_id uuid references users (id) on delete set null,
  side text not null check (side in ('sender', 'pr')),
  display_name text not null, -- PR replies always show as งานประชาสัมพันธ์
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index messages_idx on messages (submission_id, created_at);

create table submission_files (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  kind text not null check (kind in ('photo', 'attach', 'video', 'art')),
  path text not null unique, -- relative to UPLOAD_DIR
  name text not null,        -- original file name
  size bigint not null check (size >= 0),
  mime text not null,
  position smallint not null default 0,
  created_at timestamptz not null default now()
);
create index submission_files_idx on submission_files (submission_id, kind, position);

-- =========================================================================
-- News (published stories)
-- =========================================================================
create table news (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  submission_id uuid unique references submissions (id) on delete set null,
  title text not null,
  title_en text,
  lead text,
  body text not null default '',
  body_en text,
  unit text not null,
  categories text[] not null default '{}',
  audience audience[] not null default '{public}' check (cardinality(audience) > 0),
  cover_path text,                   -- relative to UPLOAD_DIR/media
  gallery text[] not null default '{}',
  video_url text,
  credit text,
  event_date date,
  place text,
  featured boolean not null default false,
  views integer not null default 0,
  published_at timestamptz,          -- null = not live yet; a future time = scheduled
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index news_published_idx on news (published_at desc);
create trigger news_touch before update on news for each row execute function touch_updated_at();

alter table submissions
  add constraint submissions_news_fk foreign key (news_id) references news (id) on delete set null;

create table saved_news (
  user_id uuid not null references users (id) on delete cascade,
  news_id uuid not null references news (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, news_id)
);

-- =========================================================================
-- News digests (เล่มสรุปข่าว)
-- =========================================================================
create table digests (
  id text primary key, -- w-2569-10-02 / m-2569-10 (matches digest-data.js)
  kind digest_kind not null,
  no text not null,
  range_label text not null,
  range_start date not null,
  range_end date not null check (range_end >= range_start),
  status digest_status not null default 'review',
  mode text not null default 'auto' check (mode in ('auto', 'manual', 'pdf')),
  groups jsonb not null default '[]',   -- [{ cat, ids: [news id] }] as digest-book.js keeps it
  excluded jsonb not null default '[]',
  cover_path text,                      -- relative to UPLOAD_DIR
  pdf_path text,
  pdf_pages int check (pdf_pages > 0),
  theme jsonb not null default '{}',    -- { bg, glow, soft }
  drafted_at timestamptz not null default now(),
  published_at timestamptz,
  approved_by uuid references users (id) on delete set null,
  unique (kind, range_start)
);

-- =========================================================================
-- Automatic digest drafts: weekly on Monday 06:00, monthly on the 1st at 06:00 (Bangkok).
-- The app calls create_digest_drafts() on that schedule; drafts wait for PR approval.
-- =========================================================================
create function th_month(m int, short boolean) returns text language sql immutable as $$
  select (case when short
    then array['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
    else array['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
               'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
  end)[m]
$$;

create function create_digest_drafts(p_today date default (now() at time zone 'Asia/Bangkok')::date)
returns void language plpgsql as $$
declare
  -- Cover colours rotate through the set used in digest-data.js
  themes jsonb := '[
    {"bg": "#1B2560", "glow": "rgb(222 20 42 / .55)", "soft": "bg-red-soft"},
    {"bg": "#7A3CE2", "glow": "rgb(255 206 96 / .5)", "soft": "bg-purple-soft"},
    {"bg": "#B3218F", "glow": "rgb(0 174 239 / .45)", "soft": "bg-purple-soft"},
    {"bg": "#0A6A94", "glow": "rgb(222 20 42 / .5)", "soft": "bg-sky-soft"},
    {"bg": "#DE142A", "glow": "rgb(122 60 226 / .6)", "soft": "bg-red-soft"},
    {"bg": "#2A3B9C", "glow": "rgb(0 174 239 / .5)", "soft": "bg-royal-soft"}
  ]';
  s date;
  e date;
  n int;
  no text;
begin
  -- Weekly: on Monday, the Monday–Sunday that just ended; numbered within the month it started in
  if extract(isodow from p_today) = 1 then
    s := p_today - 7;
    e := p_today - 1;
    select count(*) + 1 into n from digests
      where kind = 'weekly' and date_trunc('month', range_start) = date_trunc('month', s);
    no := lpad(n::text, 2, '0');
    insert into digests (id, kind, no, range_label, range_start, range_end, theme)
    values (
      format('w-%s-%s-%s', extract(year from s)::int + 543, to_char(s, 'MM'), no),
      'weekly', no,
      case when date_trunc('month', s) = date_trunc('month', e)
        then format('%s–%s %s %s', extract(day from s), extract(day from e),
          th_month(extract(month from e)::int, true), extract(year from e)::int + 543)
        else format('%s %s – %s %s %s', extract(day from s), th_month(extract(month from s)::int, true),
          extract(day from e), th_month(extract(month from e)::int, true), extract(year from e)::int + 543)
      end,
      s, e, themes -> (extract(week from s)::int % jsonb_array_length(themes)))
    on conflict do nothing;
  end if;

  -- Monthly: on the 1st, the month that just ended
  if extract(day from p_today) = 1 then
    s := (p_today - interval '1 month')::date;
    e := p_today - 1;
    insert into digests (id, kind, no, range_label, range_start, range_end, theme)
    values (
      format('m-%s-%s', extract(year from s)::int + 543, to_char(s, 'MM')),
      'monthly', to_char(s, 'MM'),
      format('%s %s', th_month(extract(month from s)::int, false), extract(year from s)::int + 543),
      s, e, themes -> (extract(month from s)::int % jsonb_array_length(themes)))
    on conflict do nothing;
  end if;
end $$;
