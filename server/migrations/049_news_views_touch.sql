-- =========================================================================
-- Counting a read (update news set views = views + 1, news.mjs) must not change updated_at: the sitemap <lastmod>
-- and the story's JSON-LD dateModified show the last edit, not the last reader.
-- =========================================================================
drop trigger if exists news_touch on news;
create trigger news_touch before update on news for each row
  when ((to_jsonb(old) - 'views' - 'updated_at') is distinct from (to_jsonb(new) - 'views' - 'updated_at'))
  execute function touch_updated_at();
