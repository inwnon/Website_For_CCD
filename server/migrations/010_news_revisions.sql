-- =========================================================================
-- Edit history of every story (pr-news.html → ประวัติการแก้ไข)
-- =========================================================================
-- A trigger writes a row for every insert and every change of what readers see, whichever code path made it,
-- so no version can be missed. View counts and other bookkeeping columns are not editorial changes.
-- Who made the change comes from the transaction setting app.actor (db.mjs asActor), JSON { id, email, name, action }.
create table if not exists news_revisions (
  id          bigserial primary key,
  news_id     uuid not null references news(id) on delete cascade,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  actor_name  text,
  -- created | edited | featured | unfeatured | withdrawn | restored | album (or the action the app names)
  action      text not null,
  -- { field: { "from": …, "to": … } } for the fields that changed (empty for "created")
  changes     jsonb not null default '{}',
  -- the story's editorial fields after this change
  snapshot    jsonb not null
);
create index if not exists news_revisions_news_at on news_revisions (news_id, at desc, id desc);

create or replace function news_revision() returns trigger language plpgsql as $$
declare
  fields text[] := array['kind', 'title', 'title_en', 'lead', 'body', 'body_en', 'unit', 'categories', 'audience', 'cover_path', 'gallery',
    'video_url', 'album_url', 'credit', 'event_date', 'place', 'featured', 'published_at', 'withdrawn_at', 'withdrawn_reason', 'source_url'];
  f text;
  o jsonb;
  n jsonb := to_jsonb(NEW);
  diff jsonb := '{}';
  actor jsonb := nullif(current_setting('app.actor', true), '')::jsonb;
  act text;
begin
  if TG_OP = 'UPDATE' then
    o := to_jsonb(OLD);
    foreach f in array fields loop
      if (o -> f) is distinct from (n -> f) then
        diff := diff || jsonb_build_object(f, jsonb_build_object('from', o -> f, 'to', n -> f));
      end if;
    end loop;
    if diff = '{}' then return NEW; end if;
  end if;
  act := coalesce(actor ->> 'action', case
    when TG_OP = 'INSERT' then 'created'
    when diff ? 'withdrawn_at' and NEW.withdrawn_at is not null then 'withdrawn'
    when diff ? 'withdrawn_at' then 'restored'
    when diff ? 'featured' and (select count(*) from jsonb_object_keys(diff)) = 1 then case when NEW.featured then 'featured' else 'unfeatured' end
    when diff ? 'album_url' and (select count(*) from jsonb_object_keys(diff)) = 1 then 'album'
    else 'edited' end);
  insert into news_revisions (news_id, actor_id, actor_email, actor_name, action, changes, snapshot)
  values (NEW.id, nullif(actor ->> 'id', '')::uuid, actor ->> 'email', actor ->> 'name', act, diff,
    (select jsonb_object_agg(k, n -> k) from unnest(fields) k));
  return NEW;
end $$;

drop trigger if exists news_revision on news;
create trigger news_revision after insert or update on news for each row execute function news_revision();

-- Stories that existed before the history: one "created" row each, at the time they were created
insert into news_revisions (news_id, at, actor_id, actor_email, actor_name, action, changes, snapshot)
select n.id, n.created_at, n.created_by, u.email, u.name, 'created', '{}',
  jsonb_build_object('kind', n.kind, 'title', n.title, 'title_en', n.title_en, 'lead', n.lead, 'body', n.body, 'body_en', n.body_en, 'unit', n.unit,
    'categories', n.categories, 'audience', n.audience, 'cover_path', n.cover_path, 'gallery', n.gallery, 'video_url', n.video_url, 'album_url', n.album_url,
    'credit', n.credit, 'event_date', n.event_date, 'place', n.place, 'featured', n.featured, 'published_at', n.published_at,
    'withdrawn_at', n.withdrawn_at, 'withdrawn_reason', n.withdrawn_reason, 'source_url', n.source_url)
from news n left join users u on u.id = n.created_by
where not exists (select 1 from news_revisions r where r.news_id = n.id);
