-- The Radar's "N of 5 videos this week" card needs a goal number, editable
-- in Settings. It rides on the existing settings row rather than its own
-- table — one number, one owner, same lifecycle as every other preference.
alter table viralradar.settings
  add column weekly_goal integer not null default 5;
