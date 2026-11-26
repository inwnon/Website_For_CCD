-- =========================================================================
-- Email outbox retries (notify.mjs sendQueued): a failed email waits longer after each try (5, 15, 45, 135, 405
-- minutes) instead of three tries 30 seconds apart, so a short SMTP outage no longer loses mail. next_at also
-- leases a row while it is being sent, so two app processes never send the same email.
-- =========================================================================
alter table email_outbox add column next_at timestamptz not null default now();
drop index if exists email_outbox_queued;
create index email_outbox_queued on email_outbox (next_at, id) where status = 'queued';
