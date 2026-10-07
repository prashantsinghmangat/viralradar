# ViralRadar — what this project is and where it has got to

A personal app for one person (Prashant). It keeps the ideas, scripts and
results exported from a separate tool called **Shorts Studio**, and each morning
it collects trending short-video and tech links so there is something to make
videos about.

It is being migrated from **a local-only app** (Express + SQLite, one laptop) to
**a synced cloud app** (Supabase + Netlify, laptop and phone, anywhere).

This file is the orientation document: architecture, decisions, status and the
gaps. [SETUP.md](SETUP.md) is the step-by-step list of things to do by hand.

---

## 1. The two versions

| | `local-sqlite` branch | `main` branch |
|---|---|---|
| Runs on | one laptop | Netlify + Supabase |
| Data | `data/viralradar.db` (SQLite) | Postgres, in a `viralradar` schema |
| Server | Express on port 3000 | none — the browser talks to Supabase directly |
| Live updates | Server-Sent Events | Supabase Realtime |
| Daily trend refresh | node-cron | pg_cron + pg_net |
| AI | none | Gemini, falling back to OpenRouter |
| Phone | same Wi-Fi only | anywhere, installable |

`main` is the cloud version, and is what Netlify deploys. The local-only
version is kept intact on the **`local-sqlite`** branch, also tagged
**`v1-local`**: it still runs with `npm start`, and it is both the fallback
and the source for the one-time data migration.

---

## 2. Shape of the cloud version

```
   PHONE / LAPTOP BROWSER                     LAPTOP (optional)
   ┌───────────────────────┐                  ┌──────────────────────┐
   │ Netlify static site   │                  │ Downloads watcher    │
   │ vanilla JS PWA        │                  │ npm run watcher      │
   │ supabase-js, anon key │                  │ viralradar-*.json    │
   └───────────┬───────────┘                  └──────────┬───────────┘
               │ reads + writes, protected by RLS        │ POST, vr_ token
               │                                         │
   ┌───────────▼─────────────────────────────────────────▼───────────┐
   │ SUPABASE  (project "tracebug", shared with another app)         │
   │                                                                 │
   │  Postgres — schema "viralradar", 8 tables, RLS on every one     │
   │  Auth     — email + password (auth.users is shared)             │
   │  Edge Functions (Deno):                                         │
   │     vr-import          JWT or vr_ token                         │
   │     vr-generate        holds GEMINI / OPENROUTER keys           │
   │     vr-refresh-trends  holds YOUTUBE / GITHUB keys              │
   │  pg_cron — 01:30 UTC (07:00 IST) → vr-refresh-trends            │
   └─────────────────────────────────────────────────────────────────┘
```

**What lives where, and why**

- **Browser**: everything that is just reading and writing your own rows. Safe
  because of Row Level Security, which is what makes the anon key safe to ship.
- **Edge Functions**: only the things that cannot be in a browser — holding API
  keys, and fetching from sites that would refuse a cross-origin request.
- **Laptop**: only the Downloads folder watcher, because only the laptop can see
  the Downloads folder. It needs no database and no server.

---

## 3. The shared Supabase project

The free tier allows two projects and both were already in use, so ViralRadar
shares the **tracebug** project rather than getting its own. That drives several
decisions:

- **Its own schema.** Everything is in `viralradar.*`, never `public`, so no
  table name can collide. The Data API has `viralradar` added to *Exposed
  schemas*, and the frontend uses `createClient(url, key, { db: { schema: 'viralradar' } })`.
- **Prefixed function names** — `vr-import`, `vr-generate`, `vr-refresh-trends` —
  because function names are global to a project.
- **No trigger on `auth.users`.** One would fire for the other app's signups too.
  The `settings` row is created by the app on first use instead.
- **An allowlist.** `auth.users` already held 3 accounts belonging to the other
  app. They can sign in; they must not be able to use ViralRadar. See §5.
- **Never run `supabase db reset`** — it would wipe the other app too.

---

## 4. Data model

Schema `viralradar`. Every table has `user_id uuid not null default auth.uid()
references auth.users(id) on delete cascade`, `created_at`, and `updated_at`
maintained by a trigger.

| Table | Key | Holds |
|---|---|---|
| `ideas` | `(user_id, id)` | date, title, hook, tool, show, why, format, `status` new/picked/skipped |
| `scripts` | `(user_id, id)` | topic, title, `beats` jsonb, captions, `hashtags[]`, `broll[]`, audio, `stage` to_shoot/shot/edited/posted |
| `results` | `(user_id, id)` | posted_on, `platforms[]`, format, hook, len, cta, views/likes/comments/shares/saves/follows, `script_id` |
| `trends` | `(user_id, url)` | title, source, summary, thumbnail, views, views_per_hour, score, fetched_on, `extra` jsonb |
| `settings` | `user_id` | `niche_keywords[]`, language, default_length, `ai_order[]`, gemini_model, openrouter_model |
| `usage` | `(user_id, date, provider)` | units, requests — YouTube quota and AI call counts |
| `import_tokens` | `id` | `token_hash` (SHA-256 only), label, last_used_at |
| `allowed_users` | `user_id` | who may use ViralRadar at all |

Notes that matter:

- **`(user_id, id)` primary keys** are what make imports upsert instead of
  duplicating, per user.
- **`origin_at`** (indexed) is when the item was made according to the export —
  `date` / `created_at` / `logged_at`, falling back to import time. The UI sorts
  by it.
- **`raw` jsonb** keeps the original export item whole, so a new Shorts Studio
  field is never lost even though no column exists for it.
- **`status` and `stage` are never written by an import**, so re-importing a
  script cannot drag it back from "posted" to "to shoot".
- **`results.script_id` is not a foreign key** on purpose: a bundle export can
  list a result before its script, and import must not depend on item order.

---

## 5. Security model

**Two gates on every policy**, both of which must pass:

```sql
user_id = auth.uid()                   -- the row is yours
(select viralradar.is_allowed())       -- you are a ViralRadar user at all
```

Each table has four separate policies (select / insert / update / delete) rather
than one `for all`, so a mistake can only ever widen one verb. Update policies
carry `WITH CHECK` as well as `USING`, which is what stops a row being handed to
someone else.

`allowed_users` is locked the opposite way: RLS on with **no policies at all**,
and `anon`/`authenticated` revoked, so only the service role can read or change
it. `is_allowed()` is `SECURITY DEFINER` with an empty `search_path` so it can
read a table its caller cannot.

`anon` — a browser before sign-in — has no privileges on anything.

**Where the service role is used, the gates must be re-implemented by hand.** The
import function's token path runs as the service role, which bypasses RLS
entirely, so it:
1. sets `user_id` explicitly on every row, and
2. checks the allowlist itself.

Miss either and an import token becomes a way around every policy.

**Secrets.** API keys live only in Supabase secrets, read by Edge Functions. They
never reach the browser, the phone or the database. Import tokens are stored only
as a SHA-256 hash; the token itself is shown once in the browser and never saved.

**Signing up is not the lock.** Turning off project-wide signups is optional
belt-and-braces; the allowlist is the actual control, and it works whether or not
signups are open. That matters because the signup setting is shared with the
other app.

---

## 6. Code layout

```
shared/              runtime-agnostic cores — Node, Deno and the browser all use these
  contract.mjs         the Shorts Studio export contract: validate + shape rows
  import-core.mjs      Postgres mapping and added/updated counting
  tokens.mjs           import tokens: generate, hash, read an Authorization header
  prompts.mjs          AI prompt rules, output shapes, JSON repair
  radar.mjs            run every trend source, dedupe by URL (no writes)
  sources/*.mjs        youtube, hackernews, reddit, github
  stats.mjs            results analytics (runs in the browser in the cloud build)
  defaults.mjs, time.mjs, http.mjs

server/              the local SQLite app (branch main). Kept for the data migration
                     and because its tests are the proof the extraction was faithful.

supabase/
  migrations/        the schema and the policies
  tests/rls.sql      the isolation test, as one block for the dashboard
  functions/
    _shared/cors.ts    allow-list of origins, no wildcard
    _shared/auth.ts    JWT vs vr_ token, and the storage port
    _shared/core/      GENERATED copy of shared/*.mjs — see below
    vr-import/         deployed. vr-generate and vr-refresh-trends

scripts/             sync-shared, inspect-db, test-rls, rls-plan, db-url
public/              the frontend (still the local version)
test/                116 tests
```

**Why `_shared/core/` is a copy.** A deployed Edge Function only receives files
under `supabase/functions/`, so it cannot import `shared/` at the repository
root. `npm run sync:shared` copies them in, and a test fails if the copy drifts,
if a function imports outside the folder, or if an import points at a missing
file. `shared/` stays the single source of truth; the copies carry a
"GENERATED — DO NOT EDIT" header.

---

## 7. The import contract

Unchanged from the local version, deliberately:

```json
{
  "app": "shorts-studio",
  "schema": 1,
  "type": "script" | "ideas" | "results" | "bundle",
  "exported_at": "...",
  "items": [ ... ]
}
```

Anything else is refused with a message meant to be read by a person ("Wrong
app: expected …", "Schema mismatch: …"). The cloud and local importers are run
side by side in the tests on the same files and asserted to produce **identical
messages, counts and errors** — that is the test for "reuse, do not rewrite".

---

## 8. The screens, and what the cloud version adds

Six screens, hash-routed, no build step. All existing markup and behaviour is
kept; the cloud version changes where the data comes from and adds the AI.

| Screen | Today | Cloud version adds |
|---|---|---|
| **Radar** | trend cards by source, velocity score, Refresh now | "Write script" on any trend card |
| **Ideas** | grouped by day, Picked / Skip, filters | **Generate ideas**, and "Write script" on an idea |
| **Scripts** | board: To shoot → Shot → Edited → Posted, drag or arrows; detail view with teleprompter and copy buttons | arrives live when generated or imported elsewhere |
| **Results** | totals, avg views, save rate, streak, bars by format/hook/len/CTA, top 5, full table | same numbers, computed in the browser |
| **Import** | paste box, file upload, recent imports log | **Paste from Shorts Studio** button (clipboard), same on Ideas and Scripts |
| **Settings** | watch folder, keywords, YouTube quota, LAN URLs, backup/restore | niche keywords, language, default length, AI order and models, **Test AI**, import token management, backup/restore |

**The everyday flow**

1. Export from Shorts Studio → it lands in Downloads → the watcher uploads it,
   or you paste it on the Import screen.
2. It appears on the phone within a second or two, with a toast (Realtime).
3. Radar has fresh trends every morning at 07:00 IST.
4. Pick an idea, or generate ideas, or write a script from a trend.
5. Move the script across the board as you shoot and edit.
6. Log results in Shorts Studio, export, and the Results screen updates.

---

## 9. Status

| Phase | State |
|---|---|
| 1. Branch and baseline | **done** |
| 2. Shared cores extracted | **done** — local app still passes its original tests |
| 3. Schema, RLS, isolation test | **done, verified against the real database** |
| 4. `vr-import` | **done, deployed and probed live** |
| 4. `vr-generate` | not started |
| 4. `vr-refresh-trends` | not started |
| 5. pg_cron daily refresh | not started |
| 6. Frontend on supabase-js + Realtime | **done, deployed** |
| 7. Generate / Write script / Paste buttons | not started |
| 8. Netlify build and deploy | **done** — PWA (manifest, service worker) still to do |
| 9. Watcher as a standalone script | not started |
| 10. SQLite → cloud migration script | not started |
| 11. README rewrite | SETUP.md done; README still describes the local app |

### What works today

Open **https://ytshortradar.netlify.app**, sign in with an email and password,
and Ideas, Scripts, Results, Import and Settings all read and write the real
database. An import on one device shows up on the other within a second or two.

### What does not work yet

- **Radar is empty and "Refresh now" fails** — `vr-refresh-trends` is not
  written, so nothing has ever collected trends. Phase 4/5.
- **"Generate ideas", "Write script" and "Test AI" fail** — `vr-generate` is not
  written. Phase 4/7.
- **No "Paste from Shorts Studio" button** yet; the paste box and file upload on
  the Import screen both work. Phase 7.
- **Not installable to a home screen** — no manifest or service worker. Phase 8.
- **No folder watcher** and **no migration from the old SQLite file**. Phases 9
  and 10.

**Done by hand so far:** migrations pushed, schema exposed to the Data API,
account created with a password and on the allowlist, all three API keys in
Supabase secrets, `ALLOWED_ORIGINS` set, code on GitHub, Netlify deploying from
`main`, `vr-import` deployed.

---

## 10. Testing

`npm test` — **174 tests**, no network, no database, no keys needed.

`npm run test:rls` — **193 assertions and 4 proofs** against the real Supabase
database. It connects as `postgres`, which owns the tables and therefore
bypasses RLS, so every assertion runs in its own transaction that first becomes
a real signed-in user (`SET LOCAL ROLE authenticated` plus `request.jwt.claims`)
and is then rolled back. Three throwaway accounts are created and deleted; one
is deliberately left off the allowlist.

The **proofs** are the unusual part: each breaks one policy inside a transaction,
demands that a named assertion now *fails*, and rolls back. A proof that does not
produce a failure is itself reported as a failure. This caught two assertions
that were passing for the wrong reason (see §11).

Other things the suite checks that are easy to get wrong:
- every SQL file parses under the **real PostgreSQL grammar** (libpg-query)
- migrations never touch `public` or `auth`, never drop, never delete rows
- the cloud and local importers produce identical messages
- the generated copies under `supabase/functions/` match their originals

A deployed Edge Function cannot be run here, so it is **probed over HTTP**
instead: a pre-flight from the real site gets CORS headers and one from any
other site gets none; a GET is refused; a request with no credentials, an
unknown import token and an expired session each come back with their own
message. That is six of the function's paths checked against the live thing.
The success path is covered in Node against a fake store.

Where a check could pass vacuously, it has been **tamper-tested**: the mistake is
introduced on purpose, the suite is confirmed to fail, and the file is restored.

---

## 11. Decisions and mistakes worth knowing

**Decisions**

- Reuse over rewrite: one `shared/` module per concern, used by Node, Deno and
  the browser, rather than a cloud copy of each.
- Storage is injected as a port, so the real import logic is testable in Node
  without a database.
- One policy per verb, so a mistake can only widen one thing.
- `(select is_allowed())` rather than `is_allowed()` so the planner evaluates it
  once per statement, not once per row.

**Mistakes found, and by what**

- *A regex in the RSS parser lost its escaping during extraction* — `[\s\S]`
  inside a template literal silently matches only `s`/`S`, so the Reddit
  fallback would have quietly returned nothing. Found by a test written against
  a fake feed.
- *Two proofs could not fail* — both used `INSERT … RETURNING`, which needs the
  SELECT policy as well, so widening only the INSERT policy still refused the
  statement. The assertions were partly guaranteed by the wrong policy. Found by
  the first run against the real database; nothing offline could have caught it.
- *A clause check that only matched correct clauses* — gating an update's
  `USING` half but not its `WITH CHECK` half passed. Found by tamper-testing.
- *The gateway rejected import tokens before the function ran* — Supabase
  verifies the Authorization header as a JWT by default, so a `vr_...` token
  came back "UNAUTHORIZED_INVALID_JWT_FORMAT" and the watcher could never have
  worked. Fixed with `verify_jwt = false` in config.toml; the function does its
  own authentication either way. Found by probing the deployed function.
- *A mangled service key failed silently* — the key variable held a list in a
  shape the first parser did not expect, so the client was built with no
  privileges and every query came back "permission denied for schema
  viralradar", which reads like a database problem and is not. Now in
  shared/keys.mjs with its own tests.
- *A build-time check reported success without looking* — it treated any 401
  as "schema exposed, anon refused", when the 401 was the project rejecting
  the key. It said step 4 was done when it had not been.
- *A bare `Bearer` header* was classified as a JWT and would have been forwarded
  as one.
- *`decodeURIComponent` throws on a stray `%`* — exactly the password that sends
  someone looking for help would have crashed the helper meant to help them.

---

## 12. Known gaps

- **Deno is not installed on this machine**, so the functions cannot be
  type-checked or executed locally. TypeScript parses them, the untestable layer
  is kept deliberately thin — all behaviour lives in `shared/*.mjs` — and the
  deployed function is probed over HTTP instead (see §10).
- **`vr-import` has not yet been used to import a real file.** Its six refusal
  paths are verified against the deployed function; the success path has only
  been tested against a fake store in Node. Importing anything from the app
  settles it.
- **OpenRouter key is not set locally**, so provider *fallback* cannot be tested
  against two real providers. Gemini is in both `.env` and Supabase secrets;
  OpenRouter and YouTube are in Supabase secrets only.
- **Realtime between two devices** has not been watched happening, and there is
  no PWA to install yet.
- The **allowlist** has one entry. The other three accounts in this project can
  sign in and will see an empty app that saves nothing — by design, but it has
  not been confirmed by signing in as one of them.

Two things that were unknown until the first deploy, now settled: the
`jsr:@supabase/supabase-js@2` import resolves, and `--use-api` does bundle the
`_shared/core/` copies.

---

## 13. Commands

| Command | What it does | Needs |
|---|---|---|
| `npm test` | the whole offline suite | nothing |
| `npm run test:rls` | isolation test against the real database | `DATABASE_URL` |
| `npm run inspect:db` | read-only report plus a setup checklist | `DATABASE_URL`, optionally `SUPABASE_URL`/`SUPABASE_ANON_KEY` |
| `npm run sync:shared` | refresh the copy under `supabase/functions/` | nothing |
| `npm run build` | build the site into dist/, as Netlify does | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `npm start` | the old local app (branch `local-sqlite` only) | nothing |
| `npx supabase db push` | apply migrations | logged in, linked |
| `npx supabase secrets list` | names and hashes of the secrets | logged in, linked |
| `npx supabase functions deploy vr-import --use-api` | deploy a function without Docker | logged in, linked |

Environment: Node 24, Supabase CLI 2.120.0, PostgreSQL 17.6, project
`tracebug` (shared with another app), region `ap-south-1`.
