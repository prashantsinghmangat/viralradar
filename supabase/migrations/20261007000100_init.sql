-- ViralRadar: schema, tables, defaults and indexes.
--
-- WHY A SCHEMA OF ITS OWN
--   This Supabase project is shared with another app, so nothing here goes in
--   "public". Everything lives in the "viralradar" schema: no table name can
--   ever collide with the other app's, and the whole app can be backed up or
--   removed as one unit. Nothing in this file touches public or auth.
--
--   One manual step makes it reachable from the browser:
--     Dashboard -> Project Settings -> API -> Exposed schemas -> add "viralradar"
--   That is additive; "public" stays exposed and the other app is unaffected.
--   The frontend then uses createClient(url, key, { db: { schema: 'viralradar' } }).
--
-- Every table is per-user: user_id defaults to auth.uid() so the browser never
-- has to send it, and it is NOT NULL so a service-role write that forgets to
-- set it fails loudly instead of creating an ownerless row.

create schema if not exists viralradar;

-- Only signed-in users and the service role may even see the schema. "anon"
-- (a browser with no session) is given nothing.
grant usage on schema viralradar to authenticated, service_role;
revoke all on schema viralradar from anon;

-- ---------- helpers ----------

-- Keeps updated_at honest on every UPDATE.
create or replace function viralradar.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- "Today" for quota counting and trend runs. One fixed timezone (IST) keeps
-- the daily YouTube cap predictable, matching shared/time.mjs.
create or replace function viralradar.ist_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- ---------- ideas ----------

create table viralradar.ideas (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  date       date,
  title      text,
  hook       text,
  tool       text,
  show       text,
  why        text,
  format     text,
  status     text not null default 'new'
             check (status in ('new', 'picked', 'skipped')),
  source     text not null default 'shorts-studio'
             check (source in ('claude', 'gemini', 'openrouter', 'shorts-studio', 'manual')),
  origin_at  timestamptz not null default now(),
  raw        jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

comment on column viralradar.ideas.id is 'The id from the Shorts Studio export. Unique per user, so re-importing updates instead of duplicating.';
comment on column viralradar.ideas.origin_at is 'When the item was made according to the export (date), falling back to import time. The UI sorts by this.';
comment on column viralradar.ideas.raw is 'The original export item, kept whole so new Shorts Studio fields are never lost.';

create index ideas_origin_at_idx on viralradar.ideas (user_id, origin_at desc);
create index ideas_status_idx on viralradar.ideas (user_id, status);

create trigger ideas_touch_updated_at before update on viralradar.ideas
  for each row execute function viralradar.touch_updated_at();

-- ---------- scripts ----------

create table viralradar.scripts (
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id             text not null,
  topic          text,
  title          text,
  beats          jsonb not null default '[]'::jsonb,
  thumbnail_text text,
  yt_title       text,
  ig_caption     text,
  fb_caption     text,
  hashtags       text[] not null default '{}',
  pinned_comment text,
  broll          text[] not null default '{}',
  audio          text,
  stage          text not null default 'to_shoot'
                 check (stage in ('to_shoot', 'shot', 'edited', 'posted')),
  source         text not null default 'shorts-studio'
                 check (source in ('claude', 'gemini', 'openrouter', 'shorts-studio', 'manual')),
  origin_at      timestamptz not null default now(),
  raw            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, id)
);

comment on column viralradar.scripts.stage is 'Pipeline column on the Scripts board. Re-importing a script never resets it.';
comment on column viralradar.scripts.origin_at is 'The export created_at, falling back to import time. The UI sorts by this.';

create index scripts_origin_at_idx on viralradar.scripts (user_id, origin_at desc);
create index scripts_stage_idx on viralradar.scripts (user_id, stage);

create trigger scripts_touch_updated_at before update on viralradar.scripts
  for each row execute function viralradar.touch_updated_at();

-- ---------- results ----------

create table viralradar.results (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  title      text,
  posted_on  date,
  platforms  text[] not null default '{}',
  format     text,
  hook       text,
  len        text,
  cta        text,
  views      bigint,
  likes      bigint,
  comments   bigint,
  shares     bigint,
  saves      bigint,
  follows    bigint,
  script_id  text,
  source     text not null default 'shorts-studio'
             check (source in ('claude', 'gemini', 'openrouter', 'shorts-studio', 'manual')),
  origin_at  timestamptz not null default now(),
  raw        jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Deliberately not a foreign key to scripts: a bundle export can list a result
-- before the script it belongs to, and an import must never fail on item order.
comment on column viralradar.results.script_id is 'Optional link to scripts.id for the same user. Not enforced, so import order never matters.';
comment on column viralradar.results.origin_at is 'The export logged_at, falling back to posted_on, then import time.';

create index results_origin_at_idx on viralradar.results (user_id, origin_at desc);
create index results_posted_on_idx on viralradar.results (user_id, posted_on desc);
create index results_script_id_idx on viralradar.results (user_id, script_id);

create trigger results_touch_updated_at before update on viralradar.results
  for each row execute function viralradar.touch_updated_at();

-- ---------- trends ----------

create table viralradar.trends (
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  url            text not null,
  title          text,
  source         text not null,
  summary        text,
  thumbnail      text,
  views          bigint,
  views_per_hour numeric,
  published_at   timestamptz,
  score          numeric not null default 0,
  fetched_on     date not null default viralradar.ist_today(),
  extra          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, url)
);

comment on column viralradar.trends.url is 'Cleaned and deduped by shared/radar.mjs. One row per URL per user.';
comment on column viralradar.trends.score is 'Per-hour velocity within the source (views, points, upvotes or stars per hour). Compare within one source only.';
comment on column viralradar.trends.extra is 'Source-specific details, including the keyword that found a YouTube clip.';

create index trends_day_idx on viralradar.trends (user_id, fetched_on desc, score desc);
create index trends_source_idx on viralradar.trends (user_id, source);

create trigger trends_touch_updated_at before update on viralradar.trends
  for each row execute function viralradar.touch_updated_at();

-- ---------- settings (one row per user) ----------

create table viralradar.settings (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  niche_keywords   text[] not null default array['ai tools', 'free ai website', 'useful websites', 'chatgpt tricks', 'coding tips', 'tech hacks'],
  language         text not null default 'English',
  default_length   text not null default '30s',
  ai_order         text[] not null default array['gemini', 'openrouter'],
  gemini_model     text not null default 'gemini-2.5-flash',
  openrouter_model text not null default 'meta-llama/llama-3.3-70b-instruct:free',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- There is deliberately NO trigger on auth.users to create this row. This
-- project is shared with another app, and a trigger there would fire for that
-- app's signups too. Instead the row is created on first use, by the app:
--   insert into viralradar.settings (user_id) values (auth.uid())
--   on conflict (user_id) do nothing;
-- Every column has a default, so that one statement is enough.
comment on table viralradar.settings is 'Exactly one row per user, created by the app on first use. Nothing here touches auth.';
comment on column viralradar.settings.ai_order is 'Providers are tried in this order; one with no key on the server is skipped.';

create trigger settings_touch_updated_at before update on viralradar.settings
  for each row execute function viralradar.touch_updated_at();

-- ---------- usage (YouTube quota and AI call counts) ----------

create table viralradar.usage (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date       date not null default viralradar.ist_today(),
  provider   text not null,
  units      integer not null default 0,
  requests   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, date, provider)
);

comment on table viralradar.usage is 'One row per user, per IST day, per provider.';
comment on column viralradar.usage.units is 'YouTube quota units (search.list costs 100, videos.list costs 1). Zero for AI providers.';
comment on column viralradar.usage.requests is 'Number of calls made: YouTube searches, or AI generate calls.';

create trigger usage_touch_updated_at before update on viralradar.usage
  for each row execute function viralradar.touch_updated_at();

-- ---------- import tokens (for the laptop folder watcher) ----------

create table viralradar.import_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token_hash   text not null unique,
  label        text,
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table viralradar.import_tokens is 'Personal tokens for the local watcher. Only the SHA-256 hash is stored; the token itself is shown once, in the browser, and never saved anywhere.';

create index import_tokens_user_idx on viralradar.import_tokens (user_id);

create trigger import_tokens_touch_updated_at before update on viralradar.import_tokens
  for each row execute function viralradar.touch_updated_at();
