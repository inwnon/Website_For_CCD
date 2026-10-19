-- Adds the intern role (นักศึกษาฝึกงาน สสอ.): imports past stories (pr-import.html) and nothing else of the PR desk.
-- On its own because a new enum value cannot be used in the transaction that adds it (018 uses it).
alter type user_role add value if not exists 'intern';
