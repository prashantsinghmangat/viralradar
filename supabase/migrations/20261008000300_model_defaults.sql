-- Bring the model defaults in the database back in line with the code, and off
-- two names that no longer work.
--
-- Both providers moved under us in the same afternoon:
--
--   gemini-2.5-flash                        retired: "no longer available to
--                                           new users"
--   meta-llama/llama-3.3-70b-instruct:free  stopped being free: "the paid
--                                           version is available now"
--
-- The replacements were picked by measuring, not by reading a model card.
-- Sampling the Gemini models four times each gave gemini-flash-latest 1/4 (503
-- high demand), gemini-3.8-flash 2/4 (429) and gemini-3.5-flash 4/4. Six free
-- OpenRouter models were tried through the deployed function; most answered
-- "Provider returned error" or were restricted, and nemotron answered in under
-- a second.
--
-- There is no durable answer here: free tiers change. Both are Settings fields
-- so the next change needs no deploy, and test/defaults.test.js now checks the
-- column defaults match the code, because last time they silently drifted.

alter table viralradar.settings
  alter column gemini_model set default 'gemini-3.5-flash',
  alter column openrouter_model set default 'nvidia/nemotron-3-super-120b-a12b:free';

-- Only rows still holding a name that is known not to work are moved. A model
-- somebody chose deliberately is left alone.
update viralradar.settings
   set gemini_model = 'gemini-3.5-flash'
 where gemini_model in ('gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest');

update viralradar.settings
   set openrouter_model = 'nvidia/nemotron-3-super-120b-a12b:free'
 where openrouter_model in ('meta-llama/llama-3.3-70b-instruct:free', 'meta-llama/llama-3.1-70b-instruct:free');

comment on column viralradar.settings.openrouter_model is
  'Model slug sent to OpenRouter. A ":free" model can stop being free without warning; if generating starts failing, check Test AI in Settings.';
