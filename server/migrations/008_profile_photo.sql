-- =========================================================================
-- Profile photo the user uploads (login.html?profile=1)
-- =========================================================================
-- Kept apart from avatar_url (the Google photo, refreshed at every sign-in) so signing in again never replaces it.
-- A path under UPLOAD_DIR: avatars/{uuid}.webp, served at /api/avatars/{uuid}.webp
alter table users add column if not exists photo_path text;
