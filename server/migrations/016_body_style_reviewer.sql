-- =========================================================================
-- ตรวจทานโดย: who in the PR team put the story on the site (the last one who published or imported it)
-- =========================================================================
alter table news add column if not exists reviewed_by uuid references users (id) on delete set null;
update news set reviewed_by = created_by where reviewed_by is null;

-- =========================================================================
-- How the story text reads: font size 16–20 px and line spacing (tight 1.6, normal 1.75, loose 2.0).
-- Null = the page default (17 px, normal). Bold is in the text itself as **…**.
-- =========================================================================
alter table news add column if not exists body_size smallint check (body_size between 16 and 20);
alter table news add column if not exists body_leading text check (body_leading in ('tight', 'normal', 'loose'));
alter table submissions add column if not exists body_size smallint check (body_size between 16 and 20);
alter table submissions add column if not exists body_leading text check (body_leading in ('tight', 'normal', 'loose'));

-- =========================================================================
-- แก้ไขข่าว on pr.html: the PR team's own version of work not yet published, used when it is published.
-- { title, lead, body, bodySize, bodyLeading, titleEn, bodyEn, videoUrl, albumUrl, categories, audience, cover, gallery, by, at }
-- =========================================================================
alter table submissions add column if not exists pr_edit jsonb;

-- The edit history also records the text settings
create or replace function news_revision() returns trigger language plpgsql as $$
declare
  fields text[] := array['kind', 'title', 'title_en', 'lead', 'body', 'body_en', 'unit', 'categories', 'audience', 'cover_path', 'gallery',
    'video_url', 'album_url', 'credit', 'event_date', 'place', 'featured', 'published_at', 'withdrawn_at', 'withdrawn_reason', 'source_url',
    'body_size', 'body_leading'];
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
