-- New Project from your own idea: one column each on projects and scripts,
-- so both boards can show a "My idea" badge without reading a full row.
--
-- A script's `original` (the creator's own title/details/links/script before
-- a model touched them) needs no column: it rides inside raw, the same
-- passthrough shared/demo.mjs's `demo` and shared/edit-plan.mjs's `edit_plan`
-- already use, and is only ever read on the script's own detail screen.
-- `own_idea` is different: the Scripts board lists scripts with a narrow
-- select (see public/data.js's scripts.list()) that leaves raw out on
-- purpose, to keep the board light, so the badge needs its own column, set
-- directly by vr-generate the same way language is — never through
-- COLUMNS.script, so a future re-import of the same id cannot null it back
-- out. Projects have no raw column at all, so theirs needs one regardless.

alter table viralradar.projects
  add column own_idea boolean not null default false;
alter table viralradar.scripts
  add column own_idea boolean not null default false;

comment on column viralradar.projects.own_idea is
  'True for a folder made from New Project''s own-idea screen, rather than from an import or a script written from a trend. Drives the "My idea" badge.';
comment on column viralradar.scripts.own_idea is
  'True for a script written from New Project''s own-idea screen. Set directly by vr-generate, never through COLUMNS.script, so a later re-import cannot null it out. Drives the "My idea" badge.';
