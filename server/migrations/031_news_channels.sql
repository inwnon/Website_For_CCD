-- ช่องทางเผยแพร่: where else the PR team published a story (keys in rules.mjs CHANNELS); empty = not stated
alter table news add column channels text[] not null default '{}';
