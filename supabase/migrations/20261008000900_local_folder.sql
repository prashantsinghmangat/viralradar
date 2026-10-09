-- A project's local folder name, remembered rather than recomputed.
--
-- A folder on the laptop is named "<date> <title>" the first time it is
-- created (see shared/localfolder.mjs's projectFolderName()). If the title is
-- edited afterwards and the name were recomputed from it every time, the next
-- sync would create a SECOND folder under the new name rather than keep
-- writing into the one that already holds the research and the script. This
-- column is what makes "renaming the title does not create a second folder"
-- true: it is set once, when the folder is first made, and never recomputed.
--
-- Nullable, and absent for every project until its folder is actually created
-- — most projects will never have a local folder at all, since the feature is
-- Chrome/Edge desktop only.

alter table viralradar.projects add column local_folder_name text;

comment on column viralradar.projects.local_folder_name is
  'The folder name under the chosen local root ("<date> <title>", sanitised), fixed at creation so renaming the title never creates a second folder. Null until the folder has actually been made.';
