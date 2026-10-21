-- ทางลัดของฉัน (index.html, PR team only): the desk pages each person put on their home page, in their order.
-- null = not chosen yet (the default set, auth.mjs SHORTCUT_DEFAULT).
alter table users add column if not exists shortcuts text[];
