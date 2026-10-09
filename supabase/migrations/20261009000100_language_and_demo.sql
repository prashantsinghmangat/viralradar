-- Three independent additions for the UX batch: which language a script was
-- written in, which language a project defaults to for its next generation,
-- and which languages the Radar is set to show.
--
-- All three are plain ADD COLUMN, nullable or with a safe default, so nothing
-- existing changes shape. "demo" (the step-by-step walkthrough a script can
-- carry) needs no column at all — same as edit_plan, it rides in `raw`,
-- because it is one blob that is only ever read as a whole.

-- A script written through the language sheet remembers its own language, so
-- regenerating it (the edit plan, a rewrite) uses THIS, never the account-wide
-- default in settings.language. Null for anything imported from Shorts
-- Studio, which has no idea this concept exists.
alter table viralradar.scripts add column language text;

-- The language last chosen while working inside this project — a convenience
-- default for the next generation tied to it (a fresh Research Pack, Find
-- angles from this project's trend), not an authority over anything. Null
-- until a script's language has actually been chosen in that project's
-- context.
alter table viralradar.projects add column language text;

-- Which languages the Radar is set to show. Empty means "nothing is allowed",
-- which the app must never actually set — the Settings screen and
-- DEFAULT_RADAR_LANGUAGES (shared/defaults.mjs) are what keep this from
-- happening; the column itself places no constraint on it, the same way
-- niche_keywords is never constrained to be non-empty either.
alter table viralradar.settings add column radar_languages text[] not null default array['hi', 'en'];

comment on column viralradar.scripts.language is
  'The spoken language chosen when this script was written. Null for an import, which carries no such concept. Edit plans and re-generations for this script use this, never settings.language.';
comment on column viralradar.projects.language is
  'The language last chosen for a generation made in this project''s context — a prefill default for the next one, never an override of an explicit choice.';
comment on column viralradar.settings.radar_languages is
  'ISO 639-1 codes. A video whose detected language (YouTube''s own declaration, or its title''s Unicode script) is not in this list is left out of the Radar.';
