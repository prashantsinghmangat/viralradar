-- The brand kit the cover generator leans on: up to three colours, a font
-- preference in plain words, the handle to put in a corner, and which side of
-- the frame the face usually sits on.
--
-- On the existing settings row rather than a table of its own, for the same
-- reason weekly_goal is: a handful of preferences, one owner, the same
-- lifecycle as every other preference. Every part is optional — the defaults
-- below are the "not set" state, and shared/thumbnail.mjs's readBrandKit()
-- reports set:false for them, which is what makes thumbnailPrompt() say
-- nothing at all about branding rather than asking a model to interpret an
-- empty heading.
--
-- No new policy: settings is already covered by the existing per-user RLS on
-- the table, which is on the row, not on its columns.
alter table viralradar.settings
  add column brand_colors text[] not null default '{}',
  add column brand_font   text   not null default '',
  add column brand_handle text   not null default '',
  add column brand_face   text   not null default '';

-- Checked here as well as in the browser: the column is written straight from
-- a form, and 'centre' or 'middle' would reach a prompt as an instruction
-- nobody can follow. Empty stays legal — it is the "not set" state.
alter table viralradar.settings
  add constraint settings_brand_face_check
  check (brand_face in ('', 'left', 'right'));

-- "Up to 3" is a promise the prompt makes to itself: a concept asks for two or
-- three colours, so a fourth would be a colour no concept can use.
alter table viralradar.settings
  add constraint settings_brand_colors_check
  check (coalesce(array_length(brand_colors, 1), 0) <= 3);

comment on column viralradar.settings.brand_colors is 'Up to 3, as typed (hex or plain words). Empty means no brand palette.';
comment on column viralradar.settings.brand_face is 'Which side the creator''s face usually sits on: left, right, or empty for unset.';
