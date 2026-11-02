-- สมุดโทรศัพท์: a unit may sit under another (หน่วยงานหลัก → หน่วยงานย่อย), at any depth.
-- A name is used once under the same parent: every faculty has its own สำนักงานคณบดี.
-- A unit with sub-units cannot be deleted (no on delete action).
alter table phonebook add column parent_id uuid references phonebook (id) check (parent_id <> id);
create index phonebook_parent_idx on phonebook (parent_id);
drop index phonebook_unit_idx;
create unique index phonebook_unit_idx on phonebook (parent_id, lower(unit_name)) nulls not distinct;

-- Telephone numbers are written 077-913-333 (landline) or 081-234-5678 (mobile)
update phonebook set phone_number = regexp_replace(regexp_replace(phone_number, '\D', '', 'g'), '^(0\d{2})(\d{3})(\d{3,4})$', '\1-\2-\3')
  where regexp_replace(phone_number, '\D', '', 'g') ~ '^0\d{8,9}$';
