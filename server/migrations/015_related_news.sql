-- =========================================================================
-- ข่าวที่เกี่ยวข้อง: stories the PR team links to a story (pr-news.html), shown on news.html in this order
-- =========================================================================
alter table news add column if not exists related uuid[] not null default '{}';
