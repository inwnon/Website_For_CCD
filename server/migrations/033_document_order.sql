-- คลังเอกสาร: the order of documents inside a งาน, set by the team. Until then, the order they were uploaded.
alter table documents add column position int;
update documents d set position = r.n
  from (select id, row_number() over (partition by work_id order by created_at, id) n from documents) r
  where r.id = d.id;
alter table documents alter column position set not null;
create index documents_work_position on documents (work_id, position);
