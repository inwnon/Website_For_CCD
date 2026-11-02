-- Sessions now end 8 hours after the last use (auth.mjs): those opened under the old 30-day rule get the same limit
update sessions set expires_at = least(expires_at, now() + interval '8 hours');
