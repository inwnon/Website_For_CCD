-- สมุดโทรศัพท์ (SPEC.md Phase 1): one row per unit, unit numbers only, never a person's phone
create table phonebook (
  id uuid primary key default gen_random_uuid(),
  unit_name text not null check (length(unit_name) between 1 and 200),
  phone_number text check (length(phone_number) between 3 and 30),
  internal_number text check (length(internal_number) between 3 and 30),
  note text check (length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (phone_number is not null or internal_number is not null)
);
create unique index phonebook_unit_idx on phonebook (lower(unit_name));
