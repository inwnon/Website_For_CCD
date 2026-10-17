-- Adds the coordinator role (ผู้ประสานงานหน่วยงาน): sees the reports of one unit.
-- On its own because a new enum value cannot be used in the transaction that adds it.
alter type user_role add value if not exists 'coordinator';
