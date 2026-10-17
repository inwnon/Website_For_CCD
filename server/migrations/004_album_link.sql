-- "ดูรูปภาพเพิ่มเติม": link to the full photo album (Facebook album, Google Drive or Google Photos folder)
alter table news add column if not exists album_url text;
