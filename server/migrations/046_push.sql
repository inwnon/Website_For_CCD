-- Web Push (push.mjs): the browsers/phones each person turned on, and which in-app notices were already pushed
create table push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references users (id) on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 1000), -- the push service's address for this browser
  p256dh text not null check (length(p256dh) <= 200),             -- the browser's public key (base64url)
  auth text not null check (length(auth) <= 50),                  -- its auth secret (base64url)
  user_agent text check (length(user_agent) <= 300),
  -- the sign-in that turned it on: logging out removes the row (auth.mjs); a session that only expires leaves it
  session_id text references sessions (id) on delete set null,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index push_subscriptions_user_idx on push_subscriptions (user_id);

alter table notifications add column pushed_at timestamptz;
-- Notices from before Web Push are not sent to phones
update notifications set pushed_at = now();
create index notifications_unpushed_idx on notifications (id) where pushed_at is null;
