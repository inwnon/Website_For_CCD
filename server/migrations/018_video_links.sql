-- =========================================================================
-- นักศึกษาฝึกงาน สสอ. in pr_team, and ลิงก์วิดีโอเพิ่มเติม
-- =========================================================================
-- An intern is listed in pr_team like the other given roles (admin.html), with no unit
alter table pr_team drop constraint pr_team_role_check;
alter table pr_team add constraint pr_team_role_check check (role in ('pr', 'admin', 'coordinator', 'intern'));

-- A video may come in more than one link (episodes, other platforms): the first is video_url, these are the rest,
-- in order (rules.mjs MAX_VIDEO_LINKS). The submission's links go to the story when PR publishes it.
alter table submissions add column if not exists video_links text[] not null default '{}';
alter table news add column if not exists video_links text[] not null default '{}';
