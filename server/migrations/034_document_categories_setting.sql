-- หมวดเอกสาร now come from settings.docCategories (chanon.html), so the fixed lists leave the table.
-- The server checks the category and whether it needs a unit name.
alter table documents drop constraint documents_category_check;
alter table documents drop constraint documents_unit_check;

-- Search matches the category's current label at query time: take the stored label out of search_text
update documents d set search_text = concat_ws(E'\n', d.title, d.unit_name, nullif(array_to_string(d.tags, E'\n'), ''), v.file_name)
  from document_versions v where v.document_id = d.id and v.version = d.version;
