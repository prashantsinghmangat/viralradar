-- Point the default Gemini model at an alias instead of a version number.
--
-- gemini-2.5-flash was retired: every call came back "This model is no longer
-- available to new users". A pinned version will always do that eventually,
-- and the app would break on a day nobody had touched it.
--
-- gemini-flash-latest is an alias Google keeps pointing at the current flash
-- model, so it ages without breaking. The model is still a Settings field, so
-- a specific version can be chosen deliberately when there is a reason to.

alter table viralradar.settings
  alter column gemini_model set default 'gemini-flash-latest';

-- Rows created before this are still holding the retired name. Only the ones
-- that were never changed by hand are updated: a model somebody chose on
-- purpose is left alone.
update viralradar.settings
   set gemini_model = 'gemini-flash-latest'
 where gemini_model in ('gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash');

comment on column viralradar.settings.gemini_model is
  'Model name sent to Gemini. Prefer an alias such as gemini-flash-latest; a pinned version is eventually retired and then every call fails.';
