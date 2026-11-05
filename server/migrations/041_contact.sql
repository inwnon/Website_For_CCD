-- ช่องทางการติดต่อ: the sender gives a link or a phone number; shown at the end of the published story.
-- Required on new work (checkSubmission); older work and stories have none.
alter table submissions
  add column contact_kind text check (contact_kind in ('link', 'phone')),
  add column contact_value text check (length(contact_value) <= 500),
  add check ((contact_kind is null) = (contact_value is null));
alter table news
  add column contact_kind text check (contact_kind in ('link', 'phone')),
  add column contact_value text check (length(contact_value) <= 500),
  add check ((contact_kind is null) = (contact_value is null));
