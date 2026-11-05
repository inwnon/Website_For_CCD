-- สมุดโทรศัพท์: admin, PR, secretaries and executives read it by role; other university accounts (staff, students)
-- only once an admin adds their email here. Rights follow the email, like pr_team; no end date.
create table phonebook_viewers (
  email text primary key check (email = lower(email)),
  granted_by text not null,
  granted_at timestamptz not null default now()
);
