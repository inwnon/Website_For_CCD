-- สมุดโทรศัพท์ (SPEC.md Phase 1): unit numbers only, never a person's phone
create table phonebook (
  id uuid primary key default gen_random_uuid(),
  unit_name text not null check (length(unit_name) between 1 and 200),
  phone_type text not null default 'unit' check (phone_type in ('unit', 'internal')),
  number text not null check (length(number) between 3 and 30),
  note text check (length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
