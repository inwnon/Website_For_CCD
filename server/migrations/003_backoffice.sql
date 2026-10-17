-- Back office: imported stories, withdrawn stories, search, reads, settings and the usage history

create extension if not exists pg_trgm;

-- =========================================================================
-- Roles: pr_team lists everyone with a role other than their domain role.
-- coordinator = ผู้ประสานงานของหน่วยงาน (unit); sees reports of that unit only.
-- =========================================================================
alter table pr_team drop constraint pr_team_role_check;
alter table pr_team add constraint pr_team_role_check check (role in ('pr', 'admin', 'coordinator'));
alter table pr_team add column unit text;
alter table pr_team add constraint pr_team_unit_check check ((role = 'coordinator') = (unit is not null));

-- =========================================================================
-- Stories
-- =========================================================================
alter table news add column kind submission_type not null default 'news';
update news n set kind = s.type from submissions s where s.id = n.submission_id;
-- Imported (นำเข้าย้อนหลัง): entered by PR from an older post; published at its original date,
-- left out of the home page feed but in the archive, search, unit pages and reports.
alter table news add column imported boolean not null default false;
alter table news add column source_url text;
-- Withdrawn (ถอนข่าว): the page answers 410 with the reason
alter table news add column withdrawn_at timestamptz;
alter table news add column withdrawn_reason text check (length(withdrawn_reason) <= 300);
alter table news add column withdrawn_by uuid references users (id) on delete set null;

create index news_source_idx on news (source_url) where source_url is not null;
create index news_unit_idx on news (unit, published_at desc);
create index news_title_trgm on news using gin (title gin_trgm_ops);
create index news_lead_trgm on news using gin (lead gin_trgm_ops);
create index news_body_trgm on news using gin (body gin_trgm_ops);

-- =========================================================================
-- Reads: one per reader per story per day. Single reads are kept 90 days (the app deletes older ones);
-- the daily totals are kept for good.
-- =========================================================================
create table news_reads (
  news_id uuid not null references news (id) on delete cascade,
  day date not null,                 -- Bangkok date
  reader text not null,              -- user id, or a hash of IP + browser with a salt that changes daily
  source text not null,              -- search, facebook, line, internal, direct, other
  device text not null,              -- mobile, tablet, desktop
  at timestamptz not null default now(),
  primary key (news_id, day, reader)
);
create index news_reads_at_idx on news_reads (at);

create table news_reads_daily (
  news_id uuid not null references news (id) on delete cascade,
  day date not null,
  source text not null,
  device text not null,
  n integer not null default 0,
  primary key (news_id, day, source, device)
);
create index news_reads_daily_day_idx on news_reads_daily (day);

-- =========================================================================
-- Settings edited on admin.html (defaults live in server/settings.mjs)
-- =========================================================================
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id) on delete set null
);

-- =========================================================================
-- Usage history: who did what, when, in the back office
-- =========================================================================
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references users (id) on delete set null,
  actor_email text,
  action text not null,       -- e.g. submission.status, news.import, settings.update
  target text,                -- e.g. NW-2569-0001, a news id, a settings key
  summary text not null,      -- Thai sentence shown in the history list
  details jsonb not null default '{}'
);
create index audit_log_at_idx on audit_log (at desc);
create index audit_log_action_idx on audit_log (action, at desc);

-- Digest cover colours come from the digest template setting when it has any
create or replace function create_digest_drafts(p_today date default (now() at time zone 'Asia/Bangkok')::date)
returns void language plpgsql as $$
declare
  -- Cover colours rotate through the set used in digest-data.js
  themes jsonb := coalesce((select value -> 'themes' from settings where key = 'digest' and jsonb_array_length(value -> 'themes') > 0), '[
    {"bg": "#1B2560", "glow": "rgb(222 20 42 / .55)", "soft": "bg-red-soft"},
    {"bg": "#7A3CE2", "glow": "rgb(255 206 96 / .5)", "soft": "bg-purple-soft"},
    {"bg": "#B3218F", "glow": "rgb(0 174 239 / .45)", "soft": "bg-purple-soft"},
    {"bg": "#0A6A94", "glow": "rgb(222 20 42 / .5)", "soft": "bg-sky-soft"},
    {"bg": "#DE142A", "glow": "rgb(122 60 226 / .6)", "soft": "bg-red-soft"},
    {"bg": "#2A3B9C", "glow": "rgb(0 174 239 / .5)", "soft": "bg-royal-soft"}
  ]');
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
