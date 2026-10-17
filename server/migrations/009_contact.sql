-- =========================================================================
-- Name and phone on the profile (login.html step 2)
-- =========================================================================
-- first_name + last_name are what the user typed; users.name then becomes "first last" and Google sign-in no longer replaces it.
-- phone: digits only. Staff (@sru.ac.th): the 4-digit internal extension. Students and external users: a Thai number, 0 + 8–9 digits.
alter table users add column if not exists first_name text;
alter table users add column if not exists last_name text;
alter table users add column if not exists phone text;
