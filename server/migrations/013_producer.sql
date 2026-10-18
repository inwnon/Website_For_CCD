-- =========================================================================
-- Video: who produced it (submit.html, after the unit; optional)
-- =========================================================================
alter table submissions add column if not exists producer text check (length(producer) <= 120);
