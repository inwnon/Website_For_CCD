-- =========================================================================
-- Drafts (submit.html "บันทึกร่าง"), longer headline and lead
-- =========================================================================
-- A draft is the sender's own: the PR team never sees it, it has no ref number and is not counted anywhere.
-- data is the form as it was (the same keys submit.html sends), checked only for size; the full checks run when it is sent.
-- Its files live in uploads/drafts/{draft id}/ and move to the submission when it is sent (POST /api/submissions, draftId).
create table submission_drafts (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references users (id) on delete cascade,
  type submission_type not null,
  title text not null default '' check (length(title) <= 180),
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index submission_drafts_sender_idx on submission_drafts (sender_id, updated_at desc);
create trigger submission_drafts_touch before update on submission_drafts for each row execute function touch_updated_at();

create table draft_files (
  id uuid primary key,
  draft_id uuid not null references submission_drafts (id) on delete cascade,
  kind text not null check (kind in ('photo', 'attach', 'art')),
  path text not null,
  name text not null,
  size bigint not null,
  mime text not null,
  position int not null default 0
);
create index draft_files_idx on draft_files (draft_id, kind, position);

-- Headline up to 180 characters, lead up to 250 (submit.html, rules.mjs)
alter table submissions drop constraint if exists submissions_title_check;
alter table submissions add constraint submissions_title_check check (length(title) between 1 and 180);
alter table submissions drop constraint if exists submissions_lead_check;
alter table submissions add constraint submissions_lead_check check (length(lead) <= 250);
