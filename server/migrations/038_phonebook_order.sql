-- สมุดโทรศัพท์ as the PR team writes it in Excel: a หน่วยงานหลัก may be only a group heading with no number of its own,
-- and units keep the order of the file (อธิการบดี before รองอธิการบดี), not name order.
alter table phonebook drop constraint phonebook_check;
alter table phonebook add constraint phonebook_number_check check (phone_number is not null or internal_number is not null or parent_id is null);
-- Order in the file it was last imported from; units added by hand (null) come after, by name
alter table phonebook add column position int;
