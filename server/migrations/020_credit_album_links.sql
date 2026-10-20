-- แบนเนอร์ / อินโฟกราฟิก: the credit line names either ผู้ออกแบบ (designer) or ที่มา (source); the sender picks one.
-- ลิงก์ภาพเพิ่มเติม: more than one (album_url is the first, album_links the others), as video_url / video_links.
alter table submissions add column if not exists credit_kind text check (credit_kind in ('designer', 'source'));
alter table news add column if not exists credit_kind text check (credit_kind in ('designer', 'source'));
alter table submissions add column if not exists album_links text[] not null default '{}';
alter table news add column if not exists album_links text[] not null default '{}';
