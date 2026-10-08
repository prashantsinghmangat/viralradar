-- ViralRadar: Row Level Security isolation test, for the Supabase SQL Editor.
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> New query -> paste all of this -> Run.
--   Read the Messages/Notices panel. The last line must say ALL CHECKS PASSED.
--   If any check fails, the whole thing is rolled back and you get an error.
--
-- WHY IT LOOKS LIKE THIS
--   The SQL Editor runs as the "postgres" role, which OWNS these tables and so
--   BYPASSES Row Level Security completely. Testing from here without becoming
--   a real user would prove nothing. So every check first does:
--       set local role authenticated;
--       set_config('request.jwt.claims', '{"sub":"<uuid>", ...}', true)
--   which is exactly what the browser's anon key produces after sign-in.
--
--   Two throwaway users are created in auth.users and deleted at the end.
--   Nothing is left behind either way: on failure the transaction is rolled
--   back, on success the users are deleted explicitly.
--
-- THE MORE THOROUGH VERSION
--   `npm run test:rls` runs 292 assertions plus seven proofs that the test can
--   actually detect a broken policy. This file is the quick version you can run
--   from a browser with no tools installed.

do $rls$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();   -- signed in, but NOT a ViralRadar user
  n int;
  used bigint;
  under boolean;
  failures int := 0;
  -- Project folders refer to each other, so the ids have to be known in
  -- advance: an item's foreign key is the pair (user_id, project_id).
  proj_a uuid := gen_random_uuid();
  proj_b uuid := gen_random_uuid();
  -- A folder A marked posted a month ago, whose file is due for the 14-day
  -- cleanup, and one marked posted three days ago, whose file is not.
  proj_old uuid := gen_random_uuid();
  proj_new uuid := gen_random_uuid();
  path_old text;
  path_new text;
  path_huge text;
begin
  -- ---------- set up ----------
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', a, 'authenticated', 'authenticated',
          'rls-test-a-' || a || '@viralradar.invalid', '', now(), now(), now()),
         ('00000000-0000-0000-0000-000000000000', b, 'authenticated', 'authenticated',
          'rls-test-b-' || b || '@viralradar.invalid', '', now(), now(), now()),
         ('00000000-0000-0000-0000-000000000000', c, 'authenticated', 'authenticated',
          'rls-test-c-' || c || '@viralradar.invalid', '', now(), now(), now());

  -- a and b are ViralRadar users; c deliberately is not. c stands in for an
  -- account belonging to the other app that shares this Supabase project.
  insert into viralradar.allowed_users (user_id, note)
  values (a, 'rls test a'), (b, 'rls test b');

  insert into viralradar.ideas (user_id, id, title, source) values (a, 'idea-a', 'A idea', 'manual'), (b, 'idea-b', 'B idea', 'manual');
  insert into viralradar.scripts (user_id, id, title, source) values (a, 'script-a', 'A script', 'manual'), (b, 'script-b', 'B script', 'manual');
  insert into viralradar.results (user_id, id, title, views, source) values (a, 'result-a', 'A result', 10, 'manual'), (b, 'result-b', 'B result', 10, 'manual');
  insert into viralradar.trends (user_id, url, title, source) values (a, 'https://a.example/1', 'A trend', 'youtube'), (b, 'https://b.example/1', 'B trend', 'youtube');
  insert into viralradar.usage (user_id, date, provider, units, requests) values (a, current_date, 'youtube', 100, 1), (b, current_date, 'youtube', 100, 1);
  insert into viralradar.import_tokens (user_id, token_hash, label) values (a, 'hash-a', 'A token'), (b, 'hash-b', 'B token');

  -- Settings rows are created by the app on first use, not by a trigger on
  -- auth.users: this project is shared with another app, and a trigger there
  -- would fire for that app's signups too. Created here the same way the app
  -- does it, with every column falling back to its default.
  insert into viralradar.settings (user_id) values (a), (b) on conflict (user_id) do nothing;

  -- ---------- project folders and their files ----------
  --
  -- A's folder is the Inbox, because every user has exactly one.
  insert into viralradar.projects (user_id, id, title, is_inbox)
  values (a, proj_a, 'A folder', true), (b, proj_b, 'B folder', false);

  insert into viralradar.project_items (user_id, id, project_id, kind, content, from_device)
  values (a, gen_random_uuid(), proj_a, 'text', 'A note', 'Laptop'),
         (b, gen_random_uuid(), proj_b, 'text', 'B note', 'Phone');

  -- posted_at is set to now() by a trigger the moment status becomes 'posted',
  -- so the dates are moved back afterwards. That second update leaves status
  -- alone, which is why the trigger does not undo it.
  insert into viralradar.projects (user_id, id, title, status)
  values (a, proj_old, 'A posted a month ago', 'posted'),
         (a, proj_new, 'A posted three days ago', 'posted');
  update viralradar.projects set posted_at = now() - interval '30 days' where id = proj_old;
  update viralradar.projects set posted_at = now() - interval '3 days'  where id = proj_new;

  path_old  := a || '/' || proj_old || '/old.png';
  path_new  := a || '/' || proj_new || '/new.png';
  path_huge := b || '/' || proj_b   || '/huge.bin';

  insert into viralradar.project_items
    (user_id, id, project_id, kind, storage_path, file_name, mime, size_bytes)
  values (a, gen_random_uuid(), proj_old, 'image', path_old, 'old.png', 'image/png', 1000),
         (a, gen_random_uuid(), proj_new, 'image', path_new, 'new.png', 'image/png', 2000);

  -- Rows with a size in metadata and no bytes behind them. That is the only
  -- sane way to test a 300 MB cap: this single 320 MB row puts B over it
  -- without anything being uploaded. Both are deleted at the end.
  insert into storage.objects (bucket_id, name, metadata) values
    ('vr-project-files', path_old,  '{"size": 1000}'::jsonb),
    ('vr-project-files', path_new,  '{"size": 2000}'::jsonb),
    ('vr-project-files', path_huge, '{"size": 320000000}'::jsonb);

  select count(*) into n from viralradar.settings where user_id in (a, b);
  if n = 2 then
    raise notice 'PASS  each user has exactly one settings row';
  else
    failures := failures + 1;
    raise notice 'FAIL  expected 2 settings rows, found %', n;
  end if;

  -- ---------- B must not be able to read A's rows ----------
  -- Become user B. set_config('role', ...) is the same thing as SET LOCAL ROLE,
  -- written as a function call because that always works inside plpgsql. The
  -- "true" makes both settings local to this transaction.
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into n from viralradar.ideas where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s ideas';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s ideas', n; end if;

  select count(*) into n from viralradar.scripts where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s scripts';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s scripts', n; end if;

  select count(*) into n from viralradar.results where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s results';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s results', n; end if;

  select count(*) into n from viralradar.trends where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s trends';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s trends', n; end if;

  select count(*) into n from viralradar.settings where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s settings';
  else failures := failures + 1; raise notice 'FAIL  B can read A''s settings'; end if;

  select count(*) into n from viralradar.usage where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s usage';
  else failures := failures + 1; raise notice 'FAIL  B can read A''s usage'; end if;

  select count(*) into n from viralradar.import_tokens where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s import tokens';
  else failures := failures + 1; raise notice 'FAIL  B can read A''s import tokens'; end if;

  select count(*) into n from viralradar.projects where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s projects';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s projects', n; end if;

  select count(*) into n from viralradar.project_items where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read what is in A''s projects';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s project items', n; end if;

  -- ---------- files: a different table, with different policies ----------
  -- storage.objects is the Storage extension's, shared with the other app in
  -- this project. There is no user_id on it: who owns a file is the first
  -- folder of its path, which is why the app puts the user id there.
  select count(*) into n from storage.objects
   where bucket_id = 'vr-project-files' and name like a || '/%';
  if n = 0 then raise notice 'PASS  B cannot see A''s files';
  else failures := failures + 1; raise notice 'FAIL  B can see % of A''s files', n; end if;

  select count(*) into n from storage.objects
   where bucket_id = 'vr-project-files' and name not like b || '/%';
  if n = 0 then raise notice 'PASS  an unfiltered select returns only B''s own files';
  else failures := failures + 1; raise notice 'FAIL  B can see % files that are not B''s', n; end if;

  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('vr-project-files', a || '/' || proj_a || '/planted.png', '{"size": 10}'::jsonb);
    failures := failures + 1;
    raise notice 'FAIL  B uploaded a file into A''s folder';
  exception
    when insufficient_privilege then raise notice 'PASS  B cannot upload into A''s folder';
  end;

  with removed as (
    delete from storage.objects where bucket_id = 'vr-project-files' and name like a || '/%' returning 1
  ) select count(*) into n from removed;
  if n = 0 then raise notice 'PASS  B cannot delete A''s files';
  else failures := failures + 1; raise notice 'FAIL  B deleted % of A''s files', n; end if;

  -- ---------- the 300 MB cap, per user ----------
  -- B is holding 320 MB, so B must be refused. That the SAME bucket lets A
  -- upload is what says the cap is counted per user rather than across the lot.
  select viralradar.storage_used() into used;
  if used >= 320000000 then raise notice 'PASS  B''s usage counts B''s own files (% bytes)', used;
  else failures := failures + 1; raise notice 'FAIL  B''s usage reads % bytes, expected at least 320000000', used; end if;

  select viralradar.storage_under_cap() into under;
  if under is false then raise notice 'PASS  B is over the 300 MB cap';
  else failures := failures + 1; raise notice 'FAIL  B is holding 320 MB but is not reported as over the cap'; end if;

  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('vr-project-files', b || '/' || proj_b || '/one-more.png', '{"size": 10}'::jsonb);
    failures := failures + 1;
    raise notice 'FAIL  B uploaded past the 300 MB cap';
  exception
    when insufficient_privilege then raise notice 'PASS  B cannot upload while over the 300 MB cap';
  end;

  -- Being full must not mean being stuck: deleting is the way back.
  with removed as (
    delete from storage.objects where bucket_id = 'vr-project-files' and name = path_huge returning 1
  ) select count(*) into n from removed;
  if n = 1 then raise notice 'PASS  B can still delete files while over the cap';
  else failures := failures + 1; raise notice 'FAIL  B cannot delete while over the cap, so there is no way back'; end if;
  -- Put it back: the assertions below still need B to be over the cap.
  insert into storage.objects (bucket_id, name, metadata)
  values ('vr-project-files', path_huge, '{"size": 320000000}'::jsonb);

  -- An unfiltered query must still only return B's own rows.
  select count(*) into n from viralradar.ideas;
  if n = 1 then raise notice 'PASS  an unfiltered select returns only B''s own row';
  else failures := failures + 1; raise notice 'FAIL  an unfiltered select returned % rows, expected 1', n; end if;

  -- B can see B's own rows (otherwise the app would be broken, not secure).
  select count(*) into n from viralradar.ideas where user_id = b;
  if n = 1 then raise notice 'PASS  B can read B''s own ideas';
  else failures := failures + 1; raise notice 'FAIL  B cannot read B''s own ideas'; end if;

  -- ---------- B must not be able to change or remove A's rows ----------
  with changed as (
    update viralradar.ideas set title = 'changed by the wrong user' where user_id = a returning 1
  ) select count(*) into n from changed;
  if n = 0 then raise notice 'PASS  B cannot update A''s ideas';
  else failures := failures + 1; raise notice 'FAIL  B updated % of A''s ideas', n; end if;

  with removed as (
    delete from viralradar.ideas where user_id = a returning 1
  ) select count(*) into n from removed;
  if n = 0 then raise notice 'PASS  B cannot delete A''s ideas';
  else failures := failures + 1; raise notice 'FAIL  B deleted % of A''s ideas', n; end if;

  -- ---------- B must not be able to plant a row in A's account ----------
  begin
    insert into viralradar.ideas (user_id, id, title, source) values (a, 'planted', 'planted by B', 'manual');
    failures := failures + 1;
    raise notice 'FAIL  B inserted a row owned by A';
  exception
    when insufficient_privilege then raise notice 'PASS  B cannot insert a row owned by A';
  end;

  -- ---------- B must not be able to give its own row away ----------
  begin
    update viralradar.ideas set user_id = a where user_id = b;
    -- An update that matched nothing is also a pass, but it should be refused.
    failures := failures + 1;
    raise notice 'FAIL  B handed its own row to A';
  exception
    when insufficient_privilege then raise notice 'PASS  B cannot hand its own row to A';
  end;

  -- ---------- no row may be ownerless ----------
  begin
    insert into viralradar.ideas (user_id, id, title, source) values (null, 'ownerless', 'no owner', 'manual');
    failures := failures + 1;
    raise notice 'FAIL  an ownerless row was created';
  exception
    when insufficient_privilege or not_null_violation then raise notice 'PASS  an ownerless row is rejected';
  end;

  -- ---------- now the other direction: A must not reach B's rows ----------
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);

  select count(*) into n from viralradar.ideas where user_id = b;
  if n = 0 then raise notice 'PASS  A cannot read B''s ideas';
  else failures := failures + 1; raise notice 'FAIL  A can read % of B''s ideas', n; end if;

  with changed as (
    update viralradar.results set views = 999999 where user_id = b returning 1
  ) select count(*) into n from changed;
  if n = 0 then raise notice 'PASS  A cannot update B''s results';
  else failures := failures + 1; raise notice 'FAIL  A updated % of B''s results', n; end if;

  with removed as (
    delete from viralradar.scripts where user_id = b returning 1
  ) select count(*) into n from removed;
  if n = 0 then raise notice 'PASS  A cannot delete B''s scripts';
  else failures := failures + 1; raise notice 'FAIL  A deleted % of B''s scripts', n; end if;

  begin
    insert into viralradar.results (user_id, id, title, source) values (b, 'planted', 'planted by A', 'manual');
    failures := failures + 1;
    raise notice 'FAIL  A inserted a result owned by B';
  exception
    when insufficient_privilege then raise notice 'PASS  A cannot insert a result owned by B';
  end;

  -- ---------- A is under the cap, and may upload ----------
  select viralradar.storage_used() into used;
  if used = 3000 then raise notice 'PASS  A''s usage counts only A''s own files (3000 bytes), not B''s 320 MB';
  else failures := failures + 1; raise notice 'FAIL  A''s usage reads % bytes, expected exactly 3000', used; end if;

  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('vr-project-files', a || '/' || proj_a || '/fresh.png', '{"size": 10}'::jsonb);
    raise notice 'PASS  A can upload into A''s own folder, even though B is over the cap';
  exception
    when insufficient_privilege then
      failures := failures + 1;
      raise notice 'FAIL  A cannot upload, so the cap is being counted across the whole bucket';
  end;

  -- The path has to be exactly <user_id>/<project_id>/<file>: nothing loose at
  -- the top of the bucket, and no deeper tree the app would never show.
  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('vr-project-files', a || '/loose.png', '{"size": 10}'::jsonb);
    failures := failures + 1;
    raise notice 'FAIL  A uploaded a file with no project folder';
  exception
    when insufficient_privilege then raise notice 'PASS  a file must be inside a project folder';
  end;

  -- ---------- the 14-day cleanup ----------
  -- A has a file in a folder posted a month ago and one in a folder posted
  -- three days ago. Exactly one being due is what says the fortnight is
  -- actually being applied, rather than "posted" alone.
  select count(*) into n from viralradar.project_files_due(a, 14);
  if n = 1 then raise notice 'PASS  one of A''s two posted folders has a file due for cleanup';
  else failures := failures + 1; raise notice 'FAIL  % files are due for A, expected exactly 1', n; end if;

  select count(*) into n from viralradar.project_files_due(a, 14) where storage_path = path_old;
  if n = 1 then raise notice 'PASS  the file due is the one from the folder posted a month ago';
  else failures := failures + 1; raise notice 'FAIL  the wrong file is due for cleanup'; end if;

  select count(*) into n from viralradar.project_files_due(a, 60);
  if n = 0 then raise notice 'PASS  with a 60-day retention nothing is due, so the period is really a parameter';
  else failures := failures + 1; raise notice 'FAIL  % files are due at 60 days, expected 0', n; end if;

  select count(*) into n from viralradar.project_files_due(b, 14);
  if n = 0 then raise notice 'PASS  A cannot find out which of B''s files are due';
  else failures := failures + 1; raise notice 'FAIL  A can see % of B''s due files', n; end if;

  -- ---------- rows that belong to you and are still wrong ----------
  -- RLS decides WHICH rows you may write. It says nothing about whether their
  -- contents make sense, and these rows point at each other and at files.
  begin
    insert into viralradar.project_items (user_id, id, project_id, kind, content)
    values (a, gen_random_uuid(), proj_b, 'text', 'in the wrong folder');
    failures := failures + 1;
    raise notice 'FAIL  A put an item in B''s folder';
  exception
    when foreign_key_violation or insufficient_privilege then
      raise notice 'PASS  A cannot put an item in B''s folder';
  end;

  begin
    insert into viralradar.project_items (user_id, id, project_id, kind, storage_path, file_name, size_bytes)
    values (a, gen_random_uuid(), proj_a, 'file', a || '/' || proj_a || '/huge.mp4', 'huge.mp4', 26214401);
    failures := failures + 1;
    raise notice 'FAIL  a file over the 25 MB limit was accepted';
  exception
    when check_violation then raise notice 'PASS  a file over 25 MB is refused by the database too';
  end;

  begin
    insert into viralradar.project_items (user_id, id, project_id, kind, storage_path, file_name, size_bytes)
    values (a, gen_random_uuid(), proj_a, 'file', b || '/' || proj_b || '/theirs.png', 'theirs.png', 10);
    failures := failures + 1;
    raise notice 'FAIL  a row claimed a file in another user''s folder';
  exception
    when check_violation then raise notice 'PASS  a stored path must be inside the folder the row says it is in';
  end;

  begin
    insert into viralradar.projects (user_id, id, title, is_inbox)
    values (a, gen_random_uuid(), 'Inbox', true);
    failures := failures + 1;
    raise notice 'FAIL  A ended up with two Inboxes';
  exception
    when unique_violation then raise notice 'PASS  a second Inbox is refused';
  end;

  -- ---------- a browser with no session gets nothing ----------
  perform set_config('role', 'anon', true);
  begin
    select count(*) into n from viralradar.ideas;
    if n = 0 then
      raise notice 'PASS  anon (not signed in) sees no ideas';
    else
      failures := failures + 1;
      raise notice 'FAIL  anon can see % ideas', n;
    end if;
  exception
    when insufficient_privilege then raise notice 'PASS  anon (not signed in) has no access to ideas at all';
  end;

  -- ---------- signed in, but not a ViralRadar user ----------
  -- This is the case the other app in this project creates. A valid account is
  -- not enough: you also have to be on the allowlist.
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into n from viralradar.ideas;
  if n = 0 then raise notice 'PASS  C is signed in but not on the allowlist, and sees no ideas';
  else failures := failures + 1; raise notice 'FAIL  C can see % ideas without being on the allowlist', n; end if;

  select count(*) into n from viralradar.results;
  if n = 0 then raise notice 'PASS  C sees no results either';
  else failures := failures + 1; raise notice 'FAIL  C can see % results', n; end if;

  select count(*) into n from viralradar.projects;
  if n = 0 then raise notice 'PASS  C sees no projects';
  else failures := failures + 1; raise notice 'FAIL  C can see % projects', n; end if;

  select count(*) into n from storage.objects where bucket_id = 'vr-project-files';
  if n = 0 then raise notice 'PASS  C sees no project files';
  else failures := failures + 1; raise notice 'FAIL  C can see % project files', n; end if;

  -- The usage function is SECURITY DEFINER, so here it is the filter in its own
  -- body that has to hold rather than any policy.
  select viralradar.storage_used() into used;
  if used = 0 then raise notice 'PASS  C''s usage reads as nothing, whatever is in the bucket';
  else failures := failures + 1; raise notice 'FAIL  C can total up % bytes', used; end if;

  begin
    insert into storage.objects (bucket_id, name, metadata)
    values ('vr-project-files', c || '/' || gen_random_uuid() || '/c.png', '{"size": 10}'::jsonb);
    failures := failures + 1;
    raise notice 'FAIL  C uploaded a file despite not being on the allowlist';
  exception
    when insufficient_privilege then raise notice 'PASS  C cannot upload anything, not even into a folder of its own';
  end;

  begin
    insert into viralradar.ideas (user_id, id, title, source) values (c, 'c-row', 'made by C', 'manual');
    failures := failures + 1;
    raise notice 'FAIL  C created a row despite not being on the allowlist';
  exception
    when insufficient_privilege then raise notice 'PASS  C cannot create anything, not even a row of its own';
  end;

  -- The gate must not be self-service, for anyone.
  begin
    insert into viralradar.allowed_users (user_id, note) values (c, 'let me in');
    failures := failures + 1;
    raise notice 'FAIL  C added itself to the allowlist';
  exception
    when insufficient_privilege then raise notice 'PASS  C cannot add itself to the allowlist';
  end;

  -- Even an allowed user must not be able to read or change the allowlist.
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  begin
    select count(*) into n from viralradar.allowed_users;
    failures := failures + 1;
    raise notice 'FAIL  an allowed user can read the allowlist (% rows)', n;
  exception
    when insufficient_privilege then raise notice 'PASS  even an allowed user cannot read the allowlist';
  end;

  -- ---------- the bucket's own settings ----------
  -- Read as the owner, because this is configuration rather than isolation.
  -- It is here because file_size_limit is the ONE copy of the 25 MB limit that
  -- can refuse an upload before the bytes are transferred, and nothing else in
  -- this file would notice if it were missing.
  perform set_config('role', 'none', true);

  select count(*) into n from storage.buckets
   where id = 'vr-project-files' and public = false and file_size_limit = 26214400;
  if n = 1 then raise notice 'PASS  the bucket is private and limits one file to 25 MB';
  else failures := failures + 1; raise notice 'FAIL  the vr-project-files bucket is missing, public, or has the wrong file size limit'; end if;

  -- ---------- clean up ----------
  -- Storage rows do not hang off auth.users, so the cascade below does not
  -- reach them. They go first, and only ever under a test user's own prefix.
  delete from storage.objects
   where bucket_id = 'vr-project-files'
     and (name like a || '/%' or name like b || '/%' or name like c || '/%');

  delete from auth.users where id in (a, b, c);

  if failures = 0 then
    raise notice '----------------------------------------';
    raise notice 'ALL CHECKS PASSED. Users cannot see each other''s data.';
    raise notice 'Both throwaway users have been deleted.';
  else
    -- Raising rolls the whole transaction back, which also removes the test users.
    raise exception '% check(s) FAILED. Read the notices above. Nothing was left behind. Do not put real data in this project until this passes.', failures;
  end if;
end
$rls$;
