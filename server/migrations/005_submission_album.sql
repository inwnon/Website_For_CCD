-- Units may send the link to their full photo album with the work; PR carries it to the story ("ดูรูปภาพเพิ่มเติม")
alter table submissions add column if not exists album_url text;
