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
--   `npm run test:rls` runs 157 assertions plus three proofs that the test can
--   actually detect a broken policy. This file is the quick version you can run
--   from a browser with no tools installed.

do $rls$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  n int;
  failures int := 0;
begin
  -- ---------- set up ----------
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', a, 'authenticated', 'authenticated',
          'rls-test-a-' || a || '@viralradar.invalid', '', now(), now(), now()),
         ('00000000-0000-0000-0000-000000000000', b, 'authenticated', 'authenticated',
          'rls-test-b-' || b || '@viralradar.invalid', '', now(), now(), now());

  insert into public.ideas (user_id, id, title, source) values (a, 'idea-a', 'A idea', 'manual'), (b, 'idea-b', 'B idea', 'manual');
  insert into public.scripts (user_id, id, title, source) values (a, 'script-a', 'A script', 'manual'), (b, 'script-b', 'B script', 'manual');
  insert into public.results (user_id, id, title, views, source) values (a, 'result-a', 'A result', 10, 'manual'), (b, 'result-b', 'B result', 10, 'manual');
  insert into public.trends (user_id, url, title, source) values (a, 'https://a.example/1', 'A trend', 'youtube'), (b, 'https://b.example/1', 'B trend', 'youtube');
  insert into public.usage (user_id, date, provider, units, requests) values (a, current_date, 'youtube', 100, 1), (b, current_date, 'youtube', 100, 1);
  insert into public.import_tokens (user_id, token_hash, label) values (a, 'hash-a', 'A token'), (b, 'hash-b', 'B token');

  -- Signup should have created one settings row per user.
  select count(*) into n from public.settings where user_id in (a, b);
  if n = 2 then
    raise notice 'PASS  signup gave each user exactly one settings row';
  else
    failures := failures + 1;
    raise notice 'FAIL  expected 2 settings rows from the signup trigger, found %', n;
  end if;

  -- ---------- B must not be able to read A's rows ----------
  -- Become user B. set_config('role', ...) is the same thing as SET LOCAL ROLE,
  -- written as a function call because that always works inside plpgsql. The
  -- "true" makes both settings local to this transaction.
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into n from public.ideas where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s ideas';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s ideas', n; end if;

  select count(*) into n from public.scripts where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s scripts';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s scripts', n; end if;

  select count(*) into n from public.results where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s results';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s results', n; end if;

  select count(*) into n from public.trends where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s trends';
  else failures := failures + 1; raise notice 'FAIL  B can read % of A''s trends', n; end if;

  select count(*) into n from public.settings where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s settings';
  else failures := failures + 1; raise notice 'FAIL  B can read A''s settings'; end if;

  select count(*) into n from public.usage where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s usage';
  else failures := failures + 1; raise notice 'FAIL  B can read A''s usage'; end if;

  select count(*) into n from public.import_tokens where user_id = a;
  if n = 0 then raise notice 'PASS  B cannot read A''s import tokens';
  else failures := failures + 1; raise notice 'FAIL  B can read A''s import tokens'; end if;

  -- An unfiltered query must still only return B's own rows.
  select count(*) into n from public.ideas;
  if n = 1 then raise notice 'PASS  an unfiltered select returns only B''s own row';
  else failures := failures + 1; raise notice 'FAIL  an unfiltered select returned % rows, expected 1', n; end if;

  -- B can see B's own rows (otherwise the app would be broken, not secure).
  select count(*) into n from public.ideas where user_id = b;
  if n = 1 then raise notice 'PASS  B can read B''s own ideas';
  else failures := failures + 1; raise notice 'FAIL  B cannot read B''s own ideas'; end if;

  -- ---------- B must not be able to change or remove A's rows ----------
  with changed as (
    update public.ideas set title = 'changed by the wrong user' where user_id = a returning 1
  ) select count(*) into n from changed;
  if n = 0 then raise notice 'PASS  B cannot update A''s ideas';
  else failures := failures + 1; raise notice 'FAIL  B updated % of A''s ideas', n; end if;

  with removed as (
    delete from public.ideas where user_id = a returning 1
  ) select count(*) into n from removed;
  if n = 0 then raise notice 'PASS  B cannot delete A''s ideas';
  else failures := failures + 1; raise notice 'FAIL  B deleted % of A''s ideas', n; end if;

  -- ---------- B must not be able to plant a row in A's account ----------
  begin
    insert into public.ideas (user_id, id, title, source) values (a, 'planted', 'planted by B', 'manual');
    failures := failures + 1;
    raise notice 'FAIL  B inserted a row owned by A';
  exception
    when insufficient_privilege then raise notice 'PASS  B cannot insert a row owned by A';
  end;

  -- ---------- B must not be able to give its own row away ----------
  begin
    update public.ideas set user_id = a where user_id = b;
    -- An update that matched nothing is also a pass, but it should be refused.
    failures := failures + 1;
    raise notice 'FAIL  B handed its own row to A';
  exception
    when insufficient_privilege then raise notice 'PASS  B cannot hand its own row to A';
  end;

  -- ---------- no row may be ownerless ----------
  begin
    insert into public.ideas (user_id, id, title, source) values (null, 'ownerless', 'no owner', 'manual');
    failures := failures + 1;
    raise notice 'FAIL  an ownerless row was created';
  exception
    when insufficient_privilege or not_null_violation then raise notice 'PASS  an ownerless row is rejected';
  end;

  -- ---------- now the other direction: A must not reach B's rows ----------
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);

  select count(*) into n from public.ideas where user_id = b;
  if n = 0 then raise notice 'PASS  A cannot read B''s ideas';
  else failures := failures + 1; raise notice 'FAIL  A can read % of B''s ideas', n; end if;

  with changed as (
    update public.results set views = 999999 where user_id = b returning 1
  ) select count(*) into n from changed;
  if n = 0 then raise notice 'PASS  A cannot update B''s results';
  else failures := failures + 1; raise notice 'FAIL  A updated % of B''s results', n; end if;

  with removed as (
    delete from public.scripts where user_id = b returning 1
  ) select count(*) into n from removed;
  if n = 0 then raise notice 'PASS  A cannot delete B''s scripts';
  else failures := failures + 1; raise notice 'FAIL  A deleted % of B''s scripts', n; end if;

  begin
    insert into public.results (user_id, id, title, source) values (b, 'planted', 'planted by A', 'manual');
    failures := failures + 1;
    raise notice 'FAIL  A inserted a result owned by B';
  exception
    when insufficient_privilege then raise notice 'PASS  A cannot insert a result owned by B';
  end;

  -- ---------- a browser with no session gets nothing ----------
  perform set_config('role', 'anon', true);
  begin
    select count(*) into n from public.ideas;
    if n = 0 then
      raise notice 'PASS  anon (not signed in) sees no ideas';
    else
      failures := failures + 1;
      raise notice 'FAIL  anon can see % ideas', n;
    end if;
  exception
    when insufficient_privilege then raise notice 'PASS  anon (not signed in) has no access to ideas at all';
  end;

  -- ---------- clean up ----------
  -- Back to the owner role, which is allowed to remove the test users.
  perform set_config('role', 'none', true);
  delete from auth.users where id in (a, b);

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
