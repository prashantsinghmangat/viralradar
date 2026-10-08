-- Research Pack: what was read off the live pages, kept with the video it is for.
--
-- A pack is a project_item of kind 'research' whose `content` is the pack as
-- JSON. It belongs in the folder because that is where everything else about
-- one video already lives — the screenshots, the links, the note from the bus —
-- and because a pack is only useful next to them.
--
-- WHY content RATHER THAN A COLUMN OF ITS OWN
--   The pack's shape will change: a field gets added the first time a page
--   turns out to describe something the shape has no room for. A jsonb column
--   would invite querying it, and then the shape could not change. Text in
--   `content` is read by exactly one piece of code, which is the right amount.
--
-- WHY NOT storage_path
--   A pack is a few kilobytes of text. Putting it in the bucket would spend the
--   300 MB slice on something the database holds for nothing, and would make it
--   unreadable without a signed URL.

do $relax$
declare
  doomed text;
begin
  -- Same approach as the video_ref migration, and for the same reason: the kind
  -- list and the shape rule have to be replaced together, and one of them was
  -- named by PostgreSQL rather than by us.
  for doomed in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'viralradar'
      and rel.relname = 'project_items'
      and con.contype = 'c'
      and con.conname in ('project_items_kind_check', 'project_items_shape')
  loop
    execute format('alter table viralradar.project_items drop constraint %I', doomed);
    raise notice 'viralradar: replacing check constraint %', doomed;
  end loop;
end
$relax$;

alter table viralradar.project_items
  add constraint project_items_kind_check
  check (kind in ('text', 'link', 'image', 'file', 'video_ref', 'research'));

-- A research pack is text, like a note, and must never have bytes in the
-- bucket: it is small, and a storage_path would mean a download button for
-- something the row already contains.
alter table viralradar.project_items
  add constraint project_items_shape check (
    case kind
      when 'text' then content is not null and storage_path is null
      when 'link' then content is not null and storage_path is null
      when 'research' then content is not null and storage_path is null
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

-- Finding the pack for a folder without reading everything else in it.
create index project_items_research_idx on viralradar.project_items (user_id, project_id, created_at desc)
  where kind = 'research';
