-- Importing a research pack or a note from Shorts Studio (or a Claude chat)
-- into a project folder, and re-importing the same one without duplicating it.
--
-- Scripts, ideas and results already upsert on (user_id, id), because their id
-- IS the row's own primary key — the export's id and the database's id are
-- the same text value. project_items is not like that: its id is a uuid the
-- database generates for every row, including the screenshots and notes
-- someone adds by hand in the app, which have no external id at all and must
-- not collide with one that arrives later.
--
-- external_id is therefore a second, optional identity: null for everything
-- made in the app, set to the import's own id for everything that came from
-- outside it. The partial unique index means only rows that actually carry
-- one can conflict, so re-importing the same research pack updates it and
-- nothing else is affected.

alter table viralradar.project_items add column external_id text;

comment on column viralradar.project_items.external_id is
  'The id from an external export (Shorts Studio, a Claude chat), so re-importing the same research pack or note updates it in place instead of duplicating it. Null for everything created in the app itself.';

create unique index project_items_external_id_idx on viralradar.project_items (user_id, external_id)
  where external_id is not null;
