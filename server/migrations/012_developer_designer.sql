-- =========================================================================
-- Role switch for the developer accounts, and ผู้ออกแบบ on banners
-- =========================================================================
-- acting_role: the role a developer account (DEVELOPERS in auth.mjs) works as in this session:
-- 'admin' = ผู้พัฒนาระบบ (all rights, the default), 'pr' = ทีม PR งานสื่อสารองค์กร. Null for everyone else.
alter table sessions add column if not exists acting_role text check (acting_role in ('pr', 'admin'));

-- Banner / infographic: who designed it (submit.html, after หน่วยงานเจ้าของงาน)
alter table submissions add column if not exists designer text check (length(designer) <= 120);
