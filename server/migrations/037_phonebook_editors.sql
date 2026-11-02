-- สมุดโทรศัพท์: only admin edits it at any time. An admin lends edit rights to one PR or intern account until a day ends;
-- after expires_at the row stays but gives nothing. Rights follow the email, like pr_team.
create table phonebook_editors (
  email text primary key check (email = lower(email)),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null
);
