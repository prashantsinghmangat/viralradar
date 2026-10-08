-- Project folders: one folder per video, and the files and notes that go in it.
--
-- WHAT THIS IS FOR
--   A video is made of more than a script: a thumbnail draft, three
--   screenshots, a link to the tool being demonstrated, a line you thought of
--   on the bus. Those arrive on whichever device you happened to be holding,
--   and then have to reach the other one. A folder per video is where they
--   meet.
--
-- WHAT NEVER GOES IN HERE
--   Raw video. This Supabase project is shared with another app (tracebug) and
--   the free tier gives the whole project about 1 GB of file storage. One
--   export would eat a third of it. Part 2 sends video device to device
--   instead; a video only ever appears here as a row saying it exists.
--
-- THE TWO LIMITS
--   25 MB per file, and 300 MB for everything ViralRadar holds. Both are
--   enforced in three places on purpose, because each place catches a
--   different mistake:
--     the browser          refuses before spending mobile data, and explains
--     this schema          a CHECK and a storage policy, so a direct API call
--                          with the anon key is refused too
--     the bucket settings  file_size_limit, enforced by the Storage API itself
--   shared/projects.mjs holds the same two numbers for the browser. They are
--   restated here as literals because a policy cannot import anything, and
--   test/projects.test.js fails if the two ever disagree.

-- ---------- projects ----------

create table viralradar.projects (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         uuid not null default gen_random_uuid(),
  title      text not null,
  -- Deliberately NOT a foreign key to scripts, for the same reason
  -- results.script_id is not: a script can be deleted, or a folder can be
  -- made before its script is imported, and neither should fail.
  script_id  text,
  status     text not null default 'active'
             check (status in ('active', 'posted', 'archived')),
  -- Exactly one folder per user is the Inbox: where a share from Android's
  -- Share menu lands when no particular folder was chosen.
  is_inbox   boolean not null default false,
  origin_at  timestamptz not null default now(),
  -- When status last became 'posted'. This is the clock the 14-day cleanup
  -- reads, so it is maintained by a trigger rather than by the app: a folder
  -- that was marked posted and then back to active must not keep an old date
  -- and have its files deleted out from under it.
  posted_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

comment on table viralradar.projects is 'One folder per video. The Inbox is the one with is_inbox, created by the app on first use.';
comment on column viralradar.projects.script_id is 'Optional link to scripts.id for the same user. Not enforced, so deleting a script never breaks a folder.';
comment on column viralradar.projects.posted_at is 'Set by a trigger when status becomes posted. Files are deleted 14 days after this.';

-- One Inbox per user, and no way to end up with two. A partial unique index
-- says that in the database rather than hoping the app never races itself.
create unique index projects_one_inbox_idx on viralradar.projects (user_id) where is_inbox;
create index projects_origin_at_idx on viralradar.projects (user_id, origin_at desc);
create index projects_status_idx on viralradar.projects (user_id, status);
create index projects_script_id_idx on viralradar.projects (user_id, script_id);

create trigger projects_touch_updated_at before update on viralradar.projects
  for each row execute function viralradar.touch_updated_at();

-- posted_at follows status, in one place, so nothing else has to remember to.
create or replace function viralradar.touch_posted_at()
returns trigger
language plpgsql
as $$
begin
  -- TG_OP rather than "old is null": on an INSERT there is no OLD row at all,
  -- and reading one is a mistake waiting to happen.
  if tg_op = 'INSERT' then
    new.posted_at = case when new.status = 'posted' then now() else null end;
  elsif new.status = 'posted' and old.status is distinct from 'posted' then
    new.posted_at = now();
  elsif new.status is distinct from 'posted' then
    -- Un-posting restarts the clock rather than leaving a stale date behind,
    -- which would have the cleanup delete files from a folder back in use.
    new.posted_at = null;
  end if;
  return new;
end;
$$;

comment on function viralradar.touch_posted_at is
  'Keeps projects.posted_at in step with projects.status, so the 14-day cleanup can never read a stale date.';

create trigger projects_touch_posted_at before insert or update on viralradar.projects
  for each row execute function viralradar.touch_posted_at();

-- ---------- project_items ----------

create table viralradar.project_items (
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id           uuid not null default gen_random_uuid(),
  project_id   uuid not null,
  kind         text not null check (kind in ('text', 'link', 'image', 'file')),
  -- The text itself, for a note or a link. Null for anything with a file.
  content      text,
  -- Where the bytes are in the vr-project-files bucket. Null for text and links.
  storage_path text,
  file_name    text,
  mime         text,
  size_bytes   bigint,
  sha256       text,
  -- Which device this came from, so "New from Laptop" can say so. A name typed
  -- in Settings, not anything the browser reports.
  from_device  text,
  -- One short line describing this item, whatever it is, maintained by the
  -- database. The Projects screen draws a preview on each folder card, and
  -- without this it would have to read every note in full to do it: a note can
  -- be 20,000 characters, and a few hundred of them is megabytes over a phone
  -- connection to draw a list of folders.
  preview      text generated always as (
                 left(regexp_replace(coalesce(content, file_name, ''), '\s+', ' ', 'g'), 80)
               ) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, id),

  -- A composite foreign key, not just (project_id): this is what makes it
  -- impossible for an item to sit in another user's folder. The pair has to
  -- exist in projects, and projects' primary key is the same pair, so an item
  -- and its folder always have the same owner. RLS stops a user reaching
  -- another user's rows at all; this stops the rows themselves being wrong.
  foreign key (user_id, project_id)
    references viralradar.projects (user_id, id) on delete cascade,

  -- Each kind has a shape, and only one of them. Without this a 'file' row
  -- with no storage_path would be a download button pointing at nothing.
  constraint project_items_shape check (
    case kind
      when 'text' then content is not null and storage_path is null
      when 'link' then content is not null and storage_path is null
      else storage_path is not null and file_name is not null and content is null
    end
  ),

  -- 25 MB, the same number as MAX_FILE_BYTES in shared/projects.mjs and as the
  -- bucket's file_size_limit. The Storage API enforces its own copy; this one
  -- catches a row that claims a size the upload never had.
  constraint project_items_size check (
    size_bytes is null or (size_bytes > 0 and size_bytes <= 26214400)
  ),

  -- A path must be inside the folder it belongs to. Written as a comparison
  -- between columns of the same row, so a row cannot claim a file under
  -- someone else's prefix even if the storage policies were widened.
  constraint project_items_path_prefix check (
    storage_path is null
    or storage_path like (user_id::text || '/' || project_id::text || '/%')
  ),

  -- Lowercase hex, 64 characters, or nothing at all. Part 2 compares these to
  -- prove a transfer did not change a byte, and a mixed-case copy of the same
  -- digest would compare unequal.
  constraint project_items_sha256 check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
);

comment on table viralradar.project_items is 'What is in a folder: notes, links and files. Never raw video — only a row saying one exists.';
comment on column viralradar.project_items.storage_path is 'Key in the vr-project-files bucket, always <user_id>/<project_id>/<name>. Enforced by a CHECK as well as by the storage policies.';
comment on column viralradar.project_items.from_device is 'The device name from Settings, so the other device can say where an item came from.';
comment on column viralradar.project_items.sha256 is 'Lowercase hex digest of the bytes, when it is known. What Part 2 compares to prove a transfer was exact.';

create index project_items_project_idx on viralradar.project_items (user_id, project_id, created_at desc);
create index project_items_created_at_idx on viralradar.project_items (user_id, created_at desc);
-- The cleanup looks for rows that have a file at all; most do not.
create index project_items_stored_idx on viralradar.project_items (user_id, project_id)
  where storage_path is not null;

create trigger project_items_touch_updated_at before update on viralradar.project_items
  for each row execute function viralradar.touch_updated_at();

-- ---------- row level security ----------
--
-- The same two gates as every other table: the row is yours, and you are a
-- ViralRadar user at all. One policy per verb, so a mistake can only ever
-- widen one of them.

alter table viralradar.projects enable row level security;

create policy projects_select_own on viralradar.projects
  for select to authenticated using (user_id = auth.uid() and (select viralradar.is_allowed()));
create policy projects_insert_own on viralradar.projects
  for insert to authenticated with check (user_id = auth.uid() and (select viralradar.is_allowed()));
create policy projects_update_own on viralradar.projects
  for update to authenticated using (user_id = auth.uid() and (select viralradar.is_allowed())) with check (user_id = auth.uid() and (select viralradar.is_allowed()));
create policy projects_delete_own on viralradar.projects
  for delete to authenticated using (user_id = auth.uid() and (select viralradar.is_allowed()));

alter table viralradar.project_items enable row level security;

create policy project_items_select_own on viralradar.project_items
  for select to authenticated using (user_id = auth.uid() and (select viralradar.is_allowed()));
create policy project_items_insert_own on viralradar.project_items
  for insert to authenticated with check (user_id = auth.uid() and (select viralradar.is_allowed()));
create policy project_items_update_own on viralradar.project_items
  for update to authenticated using (user_id = auth.uid() and (select viralradar.is_allowed())) with check (user_id = auth.uid() and (select viralradar.is_allowed()));
create policy project_items_delete_own on viralradar.project_items
  for delete to authenticated using (user_id = auth.uid() and (select viralradar.is_allowed()));

grant select, insert, update, delete on table
  viralradar.projects, viralradar.project_items
  to authenticated, service_role;

revoke all on table
  viralradar.projects, viralradar.project_items
  from anon;

-- Realtime: an item added on the laptop should appear on the phone a second
-- later, which is the entire point of the feature. The policies apply to
-- Realtime too, so a subscriber only ever receives their own rows. The
-- publication is shared with the other app in this project, so these two lines
-- only ever add to it.
alter publication supabase_realtime add table viralradar.projects;
alter publication supabase_realtime add table viralradar.project_items;

-- ---------- how much ViralRadar is holding ----------
--
-- The honest answer comes from storage.objects, not from summing
-- project_items.size_bytes: if an upload succeeded and then the row insert
-- failed, the bytes are still there and still counted against the project. The
-- cap has to be computed from what actually exists.
--
-- SECURITY DEFINER, with the owner filter written into the function body. It
-- has to be DEFINER because it is called from inside a policy ON
-- storage.objects, and a SECURITY INVOKER function would re-enter that table's
-- policies to answer. The filter means the elevated privilege buys nothing:
-- the function can only ever total up the caller's own prefix, in ViralRadar's
-- own bucket, and only for someone on the allowlist.
create or replace function viralradar.storage_used()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'vr-project-files'
    and (storage.foldername(o.name))[1] = auth.uid()::text
    and (select viralradar.is_allowed());
$$;

comment on function viralradar.storage_used is
  'Bytes the caller is holding in the vr-project-files bucket. Can only ever report the caller''s own prefix, whoever calls it.';

revoke all on function viralradar.storage_used() from public, anon;
grant execute on function viralradar.storage_used() to authenticated, service_role;

-- The gate the upload policy asks. 300 MB, matching TOTAL_BYTES_CAP in
-- shared/projects.mjs.
--
-- WHAT THIS DOES AND DOES NOT PROMISE
--   It is checked as the row is created, so the file being uploaded is not yet
--   counted. The promise is therefore "no upload may START once 300 MB is
--   already held", which can overshoot by at most one file — 325 MB in the
--   worst case. Counting the new row instead would need its size, and
--   storage.objects does not have the metadata filled in yet at that point.
--   325 MB of a ~1 GB shared quota is still a slice tracebug can live with,
--   and the browser refuses at 300 MB long before this does.
create or replace function viralradar.storage_under_cap()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select viralradar.storage_used() < 314572800;
$$;

comment on function viralradar.storage_under_cap is
  'Is the caller below ViralRadar''s 300 MB slice of this shared project? Asked by the storage insert policy.';

revoke all on function viralradar.storage_under_cap() from public, anon;
grant execute on function viralradar.storage_under_cap() to authenticated, service_role;

-- ---------- the bucket ----------
--
-- Private: public = false, so there is no URL that serves a file without a
-- session. The app reads files through a signed URL it asks for at the moment
-- it needs one.
--
-- file_size_limit is the Storage API's own 25 MB check, which is the only one
-- of the three that can refuse an upload before the bytes are transferred.
--
-- ON CONFLICT so applying this migration twice is harmless, and so a bucket
-- created by hand from the dashboard is corrected rather than duplicated. Only
-- this one id is ever touched: the other app's buckets are not ours to change.
insert into storage.buckets (id, name, public, file_size_limit)
values ('vr-project-files', 'vr-project-files', false, 26214400)
on conflict (id) do update
  set public = false,
      file_size_limit = 26214400;

-- ---------- storage policies ----------
--
-- These are policies on storage.objects, which belongs to the Storage
-- extension and is shared with the other app in this project. So:
--   * every policy name starts vr_, so it can never collide with one of theirs
--   * every policy is scoped to bucket_id = 'vr-project-files' in its FIRST
--     condition, so it can never widen anything outside ViralRadar's bucket
--   * nothing here alters, drops or replaces a policy that was already there
--
-- The owner of a file is the first folder in its path, which is why
-- storagePath() in shared/projects.mjs puts the user id there. The policies
-- compare that against auth.uid(), so a user can only ever touch their own
-- prefix. `owner` is deliberately not used: it is set by the Storage API and is
-- null for a row created any other way, so a path check is the stronger one.
--
-- array_length(...) = 2 pins the shape to <user_id>/<project_id>/<file>:
-- nothing at the bucket root, and nothing nested deeper.

create policy vr_project_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vr-project-files'
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and (select viralradar.is_allowed())
  );

create policy vr_project_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vr-project-files'
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and (select viralradar.is_allowed())
    and (select viralradar.storage_under_cap())
  );

-- Update is needed for an upsert of the same path, and for nothing else. Both
-- clauses carry every gate: without the WITH CHECK, a file could be renamed
-- into someone else's prefix.
create policy vr_project_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'vr-project-files'
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and (select viralradar.is_allowed())
  )
  with check (
    bucket_id = 'vr-project-files'
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and (select viralradar.is_allowed())
  );

create policy vr_project_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'vr-project-files'
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and (select viralradar.is_allowed())
  );

-- ---------- the 14-day cleanup ----------
--
-- Which files are due to go. One function, so "14 days after a project was
-- marked posted" is stated once and can be tested on its own, rather than
-- being a date arithmetic expression buried in an Edge Function.
--
-- SECURITY INVOKER, like add_usage: called as the signed-in user it returns
-- their own due files and nothing else, because the policies still apply.
-- Called with the service role (which is how the schedule calls it) the
-- p_user_id filter is the only thing scoping it, which is why it is required.
create or replace function viralradar.project_files_due(
  p_user_id uuid,
  p_days integer default 14
)
returns table (
  item_id      uuid,
  project_id   uuid,
  storage_path text,
  size_bytes   bigint
)
language sql
security invoker
set search_path = ''
as $$
  select i.id, i.project_id, i.storage_path, i.size_bytes
  from viralradar.project_items i
  join viralradar.projects p
    on p.user_id = i.user_id and p.id = i.project_id
  where i.user_id = p_user_id
    and i.storage_path is not null
    and p.status = 'posted'
    and p.posted_at is not null
    and p.posted_at < now() - make_interval(days => coalesce(p_days, 14))
  order by p.posted_at, i.created_at;
$$;

comment on function viralradar.project_files_due is
  'Files in posted projects older than p_days (14 by default). The one place the retention rule is written.';

revoke all on function viralradar.project_files_due(uuid, integer) from public, anon;
grant execute on function viralradar.project_files_due(uuid, integer) to authenticated, service_role;

-- Where the cleanup calls. The trends refresh already has function_url here;
-- this is the second function the schedule needs to reach. Null means "not set
-- up yet", and the job then does nothing rather than guessing a URL.
alter table viralradar.cron_config add column if not exists purge_function_url text;

comment on column viralradar.cron_config.purge_function_url is
  'Which function the nightly cleanup calls. Null until it is filled in, and then the job does nothing.';

-- What the schedule runs.
--
-- It does not delete anything itself, on purpose. Deleting a row from
-- storage.objects does NOT delete the bytes behind it: they stay in the bucket,
-- still counted against this project's 1 GB, and now with no row to find them
-- by. Only the Storage API really removes a file, so the job asks
-- vr-purge-project-files to do it, exactly as the morning refresh asks
-- vr-refresh-trends. The function deletes the files first and the rows after,
-- so a failure half way leaves rows pointing at files that are gone rather
-- than files nothing points at.
--
-- SECURITY DEFINER because the job runs as the postgres role and still has to
-- read an encrypted secret out of Vault.
create or replace function viralradar.request_project_file_purge()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg    viralradar.cron_config;
  secret text;
begin
  select * into cfg from viralradar.cron_config limit 1;
  if not found then
    raise notice 'viralradar: no cron_config row, nothing to clean up';
    return;
  end if;

  if cfg.purge_function_url is null then
    raise notice 'viralradar: cron_config.purge_function_url is not set, nothing to clean up';
    return;
  end if;

  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'viralradar_cron_secret'
  limit 1;

  if secret is null then
    raise warning 'viralradar: no viralradar_cron_secret in Vault, not calling the cleanup';
    return;
  end if;

  perform net.http_post(
    url     := cfg.purge_function_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-vr-cron-secret', secret
               ),
    body    := jsonb_build_object('user_id', cfg.user_id),
    timeout_milliseconds := 120000   -- a few hundred files, deleted in batches
  );
end;
$$;

comment on function viralradar.request_project_file_purge is
  'Called by the schedule. Asks vr-purge-project-files to delete files from projects that were posted more than 14 days ago.';

revoke all on function viralradar.request_project_file_purge() from public, anon, authenticated;

-- 02:00 UTC is 07:30 IST, half an hour after the morning refresh, so the two
-- jobs never overlap. pg_cron schedules by name, so applying this twice
-- updates the job rather than creating a second one. The prefix keeps it clear
-- of the other app's job in this project.
select cron.schedule(
  'viralradar-purge-project-files',
  '0 2 * * *',
  $$ select viralradar.request_project_file_purge(); $$
);
