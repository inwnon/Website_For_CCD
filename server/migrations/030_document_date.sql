-- คลังเอกสาร: the date of the document itself. Year and รอบประเมิน are counted from it, so a document added late lands in the right round.
alter table documents add column doc_date date;
update documents set doc_date = (created_at at time zone 'Asia/Bangkok')::date;
alter table documents alter column doc_date set not null;
