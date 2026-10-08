-- Device-to-device video transfer: the row that records it, and the private
-- channel the two devices use to find each other.
--
-- WHAT IS DELIBERATELY NOT HERE
--   Any way to store a video. A video export is hundreds of megabytes to a few
--   gigabytes; this Supabase project has about 1 GB of file storage for two
--   apps and ViralRadar keeps to 300 MB of it. So the video goes straight from
--   one device to the other over a WebRTC data channel, and the only thing that
--   reaches this database is a row saying it exists, how big it is, what its
--   SHA-256 is, and which devices hold it.
--
--   That is why 'video_ref' is the one kind of project_item that must NOT have
--   a storage_path, and why the CHECK below says so rather than trusting the
--   app to remember.

-- ---------- a place to say which devices hold a video ----------

alter table viralradar.project_items
  add column if not exists devices text[] not null default '{}';

comment on column viralradar.project_items.devices is
  'For a video_ref: the device names known to hold this video. Nothing enforces that they still do — it is a note, not an index.';

-- ---------- 'video_ref' becomes a kind of item ----------
--
-- Three CHECKs are dropped and rewritten rather than added to, because a
-- constraint cannot be extended in place. They are ours, in our own schema, and
-- each is immediately replaced, so there is no window in which a bad row could
-- be written: a migration runs in one transaction.
--
-- WHY A LOOP RATHER THAN THREE NAMES
--   Two of the three were named in the previous migration and could be dropped
--   by name. The kind list was written inline on the column, so PostgreSQL
--   named it — almost certainly project_items_kind_check, but "almost
--   certainly" is not something to hang a migration on. Dropping by what a
--   constraint DOES rather than by what it happens to be called works whatever
--   the name turned out to be.
--
--   The two constraints that are not being changed — the storage path prefix
--   and the digest format — are named explicitly and kept.
do $relax$
declare
  doomed text;
begin
  for doomed in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'viralradar'
      and rel.relname = 'project_items'
      and con.contype = 'c'
      and con.conname not in ('project_items_path_prefix', 'project_items_sha256')
  loop
    execute format('alter table viralradar.project_items drop constraint %I', doomed);
    raise notice 'viralradar: replacing check constraint %', doomed;
  end loop;
end
$relax$;

alter table viralradar.project_items
  add constraint project_items_kind_check
  check (kind in ('text', 'link', 'image', 'file', 'video_ref'));

-- Each kind has a shape, and only one of them.
--
-- A video_ref is the strictest of the five, because it is the only one that
-- makes a claim about something this database cannot see. It must carry a name,
-- a size, a digest and at least one device — so "1.80 GB, on Laptop and Phone,
-- verified identical" is structurally true rather than hopefully true — and it
-- must NOT carry a storage_path, because there are no bytes in the bucket and a
-- path would mean a download button pointing at nothing.
alter table viralradar.project_items
  add constraint project_items_shape check (
    case kind
      when 'text' then content is not null and storage_path is null
      when 'link' then content is not null and storage_path is null
      when 'video_ref' then
        storage_path is null
        and content is null
        and file_name is not null
        and size_bytes is not null
        and sha256 is not null
        and cardinality(devices) > 0
      else storage_path is not null and file_name is not null and content is null
    end
  );

-- The 25 MB limit is about Storage, so it applies only to rows that actually
-- have bytes in the bucket. A video_ref routinely describes two gigabytes and
-- costs this project nothing, which is the whole point of Part 2.
alter table viralradar.project_items
  add constraint project_items_size check (
    size_bytes is null
    or (
      size_bytes > 0
      and (storage_path is null or size_bytes <= 26214400)
    )
  );

-- Finding the videos in a folder without reading everything else in it.
create index project_items_video_ref_idx on viralradar.project_items (user_id, project_id, created_at desc)
  where kind = 'video_ref';

-- There is deliberately NO unique index on (user_id, project_id, sha256).
-- Sending the same video twice should update one row rather than make two, and
-- the app does exactly that — but it does it by reading first and merging. A
-- unique index would turn a lost race into a 23505 raised *after* a thirty
-- minute transfer had already succeeded, which would throw away the record of
-- the one thing that did work. A duplicate note is cosmetic; losing the note is
-- not.

-- ---------- the private channel the two devices talk on ----------
--
-- The devices have to exchange WebRTC offers, answers and ICE candidates before
-- they can connect, and something has to carry those. Supabase Realtime
-- broadcast does, on a channel named vr-devices-<user_id>.
--
-- THIS HAS TO BE PRIVATE, NOT JUST OBSCURELY NAMED
--   An ordinary Realtime channel is readable by anyone with the publishable key
--   who knows its name, and this project's auth.users is shared with another
--   app. A guessable name would mean another account could sit on the channel,
--   read the session descriptions — which contain both devices' IP addresses —
--   and inject offers of its own. So the channel is a PRIVATE one, and these
--   two policies on realtime.messages are what makes it mean something: a
--   session may only ever read and write the channel whose name is its own
--   user id.
--
-- Same rules as the storage policies, for the same reason: realtime.messages is
-- the Realtime extension's own table, shared with the other app in this
-- project. Every policy here is named vr_ so it cannot collide with one of
-- theirs, matches only this app's topic, and nothing is altered or dropped.
--
-- Adding policies here is additive. The existing postgres_changes subscriptions
-- for ideas, scripts, results and projects are authorised by those tables' own
-- RLS and are not affected.

create policy vr_devices_read on realtime.messages
  for select to authenticated
  using (
    realtime.topic() = 'vr-devices-' || auth.uid()::text
    and (select viralradar.is_allowed())
  );

create policy vr_devices_write on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() = 'vr-devices-' || auth.uid()::text
    and (select viralradar.is_allowed())
  );

-- ---------- reporting what a video is, without the video ----------
--
-- The Projects screen wants "how many videos, how big are they" per folder
-- without reading every row. One function, SECURITY INVOKER so the policies
-- still apply, means the browser asks one question instead of pulling the lot.
create or replace function viralradar.project_video_totals(p_user_id uuid)
returns table (
  project_id uuid,
  videos     bigint,
  bytes      bigint
)
language sql
security invoker
set search_path = ''
as $$
  select i.project_id, count(*)::bigint, coalesce(sum(i.size_bytes), 0)::bigint
  from viralradar.project_items i
  where i.user_id = p_user_id
    and i.kind = 'video_ref'
  group by i.project_id;
$$;

comment on function viralradar.project_video_totals is
  'Videos recorded per folder, and their total size. Counts rows, not bytes in Storage: a video_ref never has any.';

revoke all on function viralradar.project_video_totals(uuid) from public, anon;
grant execute on function viralradar.project_video_totals(uuid) to authenticated, service_role;
