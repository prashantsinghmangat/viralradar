---
name: deploy-check
description: Read-only deploy readiness check for ViralRadar — lists which migrations and Edge Functions are pending versus live, then prints the exact deploy order (fingerprint → db push → fingerprint → function deploys → git push) with the policy fingerprint SQL. Never deploys anything. Use when asked "what's left to deploy", "deploy check", or before handing over a deploy.
---

# deploy-check

Report what is not yet live, and print the commands **for the user to run**.

**This skill is read-only.** Never run `supabase db push`, `supabase db reset`,
`supabase functions deploy`, `git push`, or any statement that is not a `SELECT`.
If a step below fails because of credentials or a missing link, say so and move
on — do not try to fix it by deploying.

## 1. Collect the state

Run these (all read-only; `--linked` may prompt for the DB password — if it
cannot run, say so and fall back to the local lists only):

```bash
npx supabase migration list --linked
npx supabase functions list
ls supabase/migrations
ls supabase/functions
```

Also check for uncommitted/unpushed work, since the site deploys from git:

```bash
git status --short
git log --oneline origin/main..HEAD
```

## 2. Work out what is pending

- **Migrations** — any file in `supabase/migrations/` whose timestamp has no
  `Remote` entry in `migration list`. Name each one and what it adds (read the
  first comment block of the file, not the whole file).
- **Functions** — compare `supabase/functions/*/` against `functions list`.
  A function also counts as pending if it is deployed but its code or a
  `supabase/functions/_shared/core/` copy has changed since: check
  `git log -1 --format=%cr -- supabase/functions/<name>` against the deployed
  `UPDATED_AT`, and run `npm run sync:shared -- --check` to catch stale copies.
  A function that embeds changed shared logic needs a redeploy even if its own
  `index.ts` did not change.
- Cross-check `docs/PROJECT.md` §9 (Status) and the Step 14x rows in
  `docs/SETUP.md` — they record which phases are still unpushed. Read only
  those sections.

## 3. Print the deploy order

Print it as one block the user can work through top to bottom. Only include the
functions that are actually pending. Every migration touching
`storage.objects` or `realtime.messages` must be bracketed by the fingerprint —
this Supabase project is shared with the **tracebug** app, and the fingerprint
is the proof nothing of theirs moved.

**Step A — fingerprint before.** Run in the Supabase SQL editor (or any
read-only psql session) and keep the output:

```sql
-- Everything on the two shared tables that is NOT ViralRadar's.
-- Run before and after the push; the two outputs must be identical.
select
  md5(string_agg(
    format('%s|%s|%s|%s|%s|%s|%s',
           schemaname, tablename, policyname, permissive,
           cmd, coalesce(qual, ''), coalesce(with_check, '')),
    E'\n' order by schemaname, tablename, policyname)) as policy_fingerprint,
  count(*) as policies
from pg_policies
where (schemaname, tablename) in (('storage', 'objects'), ('realtime', 'messages'))
  and policyname not like 'vr\_%';

-- The RLS flags on those tables must be unchanged too.
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where (n.nspname, c.relname) in (('storage', 'objects'), ('realtime', 'messages'))
order by 1;

-- The list itself, for the record.
select schemaname, tablename, policyname, cmd
from pg_policies
where (schemaname, tablename) in (('storage', 'objects'), ('realtime', 'messages'))
order by 1, 2, 3;
```

**Step B — push the migrations.**

```bash
npx supabase db push
```

**Step C — fingerprint after.** Re-run the Step A queries. The
`policy_fingerprint`, the count, and the RLS flags must match Step A exactly.
If they do not, stop and tell me before deploying anything else.

**Step D — deploy the pending functions** (list only the pending ones):

```bash
npx supabase functions deploy <name> --use-api
```

**Step E — push to git**, which is what redeploys the Netlify site:

```bash
git push
```

Note after Step E anything that still needs doing by hand (Supabase secrets,
`cron_config` URLs, reinstalling the PWA so the service worker updates).

## 4. Report

At most 10 lines: pending migrations, pending/stale functions, shared-copy
drift, uncommitted or unpushed commits, and anything you could not check (e.g.
no `--linked` access) stated as unverified.
