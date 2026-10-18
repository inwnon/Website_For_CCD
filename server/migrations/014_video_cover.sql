-- =========================================================================
-- Video: ภาพหน้าปก (submit.html), file kind "cover" — one image, the story's cover when published
-- =========================================================================
alter table submission_files drop constraint if exists submission_files_kind_check;
alter table submission_files add constraint submission_files_kind_check check (kind in ('photo', 'attach', 'video', 'art', 'cover'));
alter table draft_files drop constraint if exists draft_files_kind_check;
alter table draft_files add constraint draft_files_kind_check check (kind in ('photo', 'attach', 'art', 'cover'));
