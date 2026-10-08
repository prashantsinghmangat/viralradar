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
   PHONE / LAPTOP BROWSER                     LAPTOP (optional, NOT BUILT)
   ┌───────────────────────┐                  ┌──────────────────────┐
   │ Netlify static site   │                  │ Downloads watcher    │
   │ vanilla JS PWA        │                  │ npm run watcher      │
   │ supabase-js, anon key │                  │ viralradar-*.json    │
   └───────────┬───────────┘                  └──────────┬───────────┘
               │ reads + writes, protected by RLS        │ POST, vr_ token
               │                                         │
               │  video: a WebRTC data channel, straight │
               │  from one device to the other. Never    │
               │  through Supabase, at any size.         │
   ┌───────────▼─────────────────────────────────────────▼───────────┐
   │ SUPABASE  (project "tracebug", shared with another app)         │
   │                                                                 │
   │  Postgres — schema "viralradar", 10 tables, RLS on every one    │
   │  Auth     — email + password (auth.users is shared)             │
   │  Edge Functions (Deno):                                         │
   │     vr-import          JWT or vr_ token                         │
   │     vr-generate        holds GEMINI / OPENROUTER keys           │
   │     vr-refresh-trends  holds YOUTUBE / GITHUB keys              │
   │     vr-purge-project-files  deletes files posted 14 days ago    │
   │  Storage  — private bucket "vr-project-files", 300 MB of ~1 GB  │
   │  Realtime — a PRIVATE channel per user, carrying only the few   │
   │             kilobytes of WebRTC handshake. No video, ever.      │
   │  pg_cron — 01:30 UTC (07:00 IST) → vr-refresh-trends            │
   │            02:00 UTC (07:30 IST) → vr-purge-project-files       │
   └─────────────────────────────────────────────────────────────────┘
```

**What lives where, and why**

- **Browser**: everything that is just reading and writing your own rows. Safe
  because of Row Level Security, which is what makes the anon key safe to ship.
- **Edge Functions**: only the things that cannot be in a browser — holding API
  keys, and fetching from sites that would refuse a cross-origin request.
- **Laptop**: only the Downloads folder watcher, because only the laptop can see
  the Downloads folder. It needs no database and no server. Not built — the
  clipboard button covers the same need from either device.

---

## 3. The shared Supabase project

The free tier allows two projects and both were already in use, so ViralRadar
shares the **tracebug** project rather than getting its own. That drives several
decisions:

- **Its own schema.** Everything is in `viralradar.*`, never `public`, so no
  table name can collide. The Data API has `viralradar` added to *Exposed
  schemas*, and the frontend uses `createClient(url, key, { db: { schema: 'viralradar' } })`.
- **Prefixed function names** — `vr-import`, `vr-generate`, `vr-refresh-trends`,
  `vr-purge-project-files` — because function names are global to a project.
  Storage policy names are prefixed `vr_` for the same reason: they all live on
  one shared `storage.objects`.
- **A fixed slice of the file quota.** The whole project gets about 1 GB of
  Storage. ViralRadar takes 300 MB and refuses uploads past it, so tracebug is
  never starved. Raw video is never stored there at all.
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
| `projects` | `(user_id, id)` | title, `script_id`, `status` active/posted/archived, `is_inbox`, `posted_at` |
| `project_items` | `(user_id, id)` | `project_id`, `kind` text/link/image/file/video_ref, content, storage_path, file_name, mime, size_bytes, sha256, `devices[]`, from_device, `preview` (generated) |
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
  `projects.script_id` is not one either, for the same reason plus one more:
  deleting a script must not take its folder of screenshots with it.
- **`project_items` has a composite foreign key** on `(user_id, project_id)`
  rather than just `project_id`. `projects`' primary key is the same pair, so an
  item and its folder always have the same owner. RLS stops a user reaching
  another user's rows; this stops the rows themselves being wrong.
- **`project_items.preview`** is a generated column holding one short line of
  whatever the item is. The Projects screen draws a preview on each folder card,
  and without it the folder list would have to read every note in full — a note
  can be 20,000 characters.
- **One Inbox per user**, enforced by a partial unique index
  (`where is_inbox`). Two devices racing to create it end up with one folder,
  because the loser's insert is refused and it reads the winner's.
- **`projects.posted_at` is maintained by a trigger**, not by the app. It is the
  clock the 14-day file cleanup reads, and un-posting a folder clears it — a
  stale date would have files deleted from a folder back in use.

### Files

Files live in a private Storage bucket, `vr-project-files`, keyed
`<user_id>/<project_id>/<stamp>-<name>`. The user id comes first because that is
what the storage policies match on.

Two limits, both because this Supabase project is shared with another app
(`tracebug`) whose free tier gives the whole project about 1 GB of file storage:

| Limit | Value | Enforced by |
|---|---|---|
| One file | 25 MB | the browser, a `CHECK` on `size_bytes`, and the bucket's `file_size_limit` |
| Everything ViralRadar holds | 300 MB | the browser, and `storage_under_cap()` in the insert policy |

Each of the three places catches a different mistake: the browser refuses before
spending mobile data and can explain itself, the `CHECK` catches a row that
claims a size the upload never had, and `file_size_limit` is the only one that
can refuse before the bytes are transferred. `shared/projects.mjs` holds the
numbers for the browser; the SQL restates them as literals because a policy
cannot import anything, and `test/projects.test.js` fails if they ever disagree.

**Raw video is never uploaded.** It is far bigger than either limit. Part 2 sends
it device to device; a video only ever appears here as a row saying it exists.

The 300 MB figure is measured from `storage.objects`, not by summing
`project_items.size_bytes` — an upload that succeeded while its row insert failed
still occupies the shared quota, and a total that cannot see those bytes would
let the cap be walked past. It is checked as the row is created, so the new file
is not yet counted: the promise is "no upload may *start* once 300 MB is held",
which can overshoot by at most one file.

### Video

A video is **never stored anywhere**. `kind = 'video_ref'` is a row saying one
exists: name, size, SHA-256, and which devices hold it. Its CHECK is the
strictest in the schema, because it is the only row that makes a claim about
something the database cannot see — it must have a name, a size, a digest and at
least one device, and it must **not** have a `storage_path`. That last one is
load-bearing twice over: a path would be a download button pointing at nothing,
and it would be a way to smuggle a 2 GB row past the 25 MB size limit.

The size limit is therefore conditional — `storage_path is null or size_bytes <=
26214400` — so a 2 GB video_ref is legal and a 26 MB upload is not.

There is deliberately **no unique index** on `(user_id, project_id, sha256)`.
Sending the same video twice should merge into one note, and the data layer does
that by reading first. A unique index would turn a lost race into a constraint
violation raised *after* a half-hour transfer had succeeded, throwing away the
record of the one thing that worked. A duplicate note is cosmetic; losing it is
not.

Files in a project marked **posted** are deleted 14 days later by a pg_cron job.
The job does not delete anything itself: removing a row from `storage.objects`
leaves the bytes in the bucket, still counted against the quota and now with
nothing pointing at them. Only the Storage API really removes a file, so the job
asks `vr-purge-project-files` to do it — files first, rows second, so a failure
half way leaves rows pointing at files that are gone rather than files nothing
points at.

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

`anon` — a browser before sign-in — has no privileges on anything in the
`viralradar` schema.

**Storage is the one exception to all of the above shape.** `storage.objects` is
one table belonging to the Storage extension, shared with the other app in this
project, holding every app's files. It has no `user_id` column, so the four
`vr_project_files_*` policies compare the **first folder of the path** with
`auth.uid()` instead, plus the same `is_allowed()` gate. Each one also pins
`bucket_id = 'vr-project-files'` as its first condition and
`array_length(storage.foldername(name), 1) = 2`, so nothing can reach the other
app's files, land at the top of the bucket, or invent a deeper tree. Only the
insert policy carries the 300 MB cap: being full must not stop you reading or
deleting, or there would be no way back. Every policy name is prefixed `vr_`
because two policies on one shared table cannot have the same name, and no
migration here ever alters or drops a policy — it might be the other app's.

`anon` is deliberately **not** revoked from `storage.objects`: that table is
shared, and the other app may serve public files from it. The policies are
scoped to `authenticated`, so a browser with no session matches nothing and gets
an empty result rather than a refusal. The RLS suite states that explicitly, so
a future change cannot quietly turn it into a leak.

**The signalling channel is the third shared table.** The two devices have to
exchange WebRTC offers, answers and ICE candidates before they can connect, and
those carry both devices' IP addresses. An ordinary Realtime channel is readable
by anyone with the publishable key who knows its name, and this project's
`auth.users` is shared — so a guessable name would not be enough. The channel is
a **private** one (`config: { private: true }`), which makes Realtime consult
two policies on `realtime.messages`:

```sql
realtime.topic() = 'vr-devices-' || auth.uid()::text
and (select viralradar.is_allowed())
```

One for `select` (subscribing) and one for `insert` (broadcasting): reading
without writing is a device that cannot answer, writing without reading is one
that cannot hear. Same `vr_` prefix rule as storage, for the same reason.

`realtime.topic()` reads a setting the Realtime server puts on the connection,
which means the RLS suite can set it too and genuinely exercise the gate against
real `auth.uid()` and `is_allowed()` values. What it cannot prove is that
Realtime consults the policy at all — that is the server's behaviour, and only
two real devices show it. So the policies are *also* read back out of
`pg_policies`, which is the one assertion in that suite that says a migration
was really applied.

**Where the service role is used, the gates must be re-implemented by hand.** The
import function's token path runs as the service role, which bypasses RLS
entirely, so it:
1. sets `user_id` explicitly on every row, and
2. checks the allowlist itself.

Miss either and an import token becomes a way around every policy. The nightly
file cleanup runs the same way and does the same two things, and additionally
refuses to delete any path that is not under the user's own prefix — for a JWT
caller the storage policies would refuse it, but for the schedule nothing else
would.

`storage_used()` is the other place privilege is elevated. It has to be
`SECURITY DEFINER`, because it is called from inside a policy *on*
`storage.objects` and a `SECURITY INVOKER` function would re-enter that table's
policies to answer. That makes the filter in its body the only thing keeping it
honest, so it is written in: own prefix, own bucket, and only for someone on the
allowlist. The RLS suite checks that a user over the cap and a user under it get
their own figures, and that a non-allowlisted account reads zero whatever is in
the bucket.

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
  contract.mjs         the Shorts Studio export contract: validate, shape rows,
                       coerce dates so a model cannot sink an import
  import-core.mjs      Postgres mapping and added/updated counting
  trends-core.mjs      a whole trend refresh: fetch, score, replace, prune
  generate-core.mjs    ask an AI, fall back to the next, repair bad JSON
  prompts.mjs          prompt rules, output shapes, JSON extraction
  edit-plan.mjs        read and render the optional edit_plan on a script
  radar.mjs            run every trend source, dedupe by URL (no writes)
  sources/*.mjs        youtube, hackernews, reddit, github
  stats.mjs            results analytics (runs in the browser in the cloud build)
  tokens.mjs           import tokens: generate, hash, read an Authorization header
  projects.mjs         project folders: the two storage limits, the path layout,
                       the device naming and the upload rules
  sha256.mjs           SHA-256 a chunk at a time, so a 2 GB video can be verified
                       without ever being in memory in one piece
  transfer.mjs         the device-to-device protocol: chunking, backpressure,
                       progress, the digest verdict, the warnings. Four injected
                       ports, so whole transfers run in Node
  keys.mjs             pick a usable API key out of a bare value, list or JSON
  defaults.mjs         model names, language, length — matched to the DB defaults
  time.mjs, http.mjs

(no server/)         the local SQLite app lives on the `local-sqlite` branch,
                     not here. Nothing on this branch needs it, so this branch
                     does not carry express or better-sqlite3 either. The exact
                     messages it produced were captured first, and are asserted
                     in test/import-core.test.js, so the cloud path still has
                     to say the same words.

supabase/
  migrations/        7 files: schema, policies, usage + schedule, model defaults,
                     project folders + the storage bucket and its policies,
                     video_ref + the private signalling channel
  tests/rls.sql      the isolation test, as one block for the dashboard
  functions/
    _shared/cors.ts    allow-list of origins, no wildcard
    _shared/auth.ts    JWT vs vr_ token, and the storage port
    _shared/core/      GENERATED copy of shared/*.mjs — see below
    vr-import/         all four are deployed
    vr-generate/
    vr-refresh-trends/
    vr-purge-project-files/   deletes files from projects posted 14 days ago

public/              the whole frontend — no build step, no framework
  index.html           every screen, as one page
  app.js               screens, sign-in, Realtime, the AI buttons, project folders
  transfer.js          the untestable half of video transfer and nothing else:
                       RTCPeerConnection, presence, File System Access
  data.js              every database call, with the client injected so it tests
  styles.css           one stylesheet, dark, phone-first
  sw.js                service worker: shell cached, config always fresh, and the
                       one thing it is load-bearing for — answering the POST from
                       Android's Share menu, since this site has no server
  manifest.webmanifest, icons/      what makes it installable
  shared/              GENERATED copy of shared/*.mjs, imported as ES modules

scripts/             build, sync-shared, inspect-db, test-rls, rls-plan,
                     db-url, make-icons
test/                26 files, 374 tests
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

Seven screens, hash-routed, no build step. All existing markup and behaviour is
kept; the cloud version changes where the data comes from and adds the AI.

| Screen | Today | Cloud version adds |
|---|---|---|
| **Radar** | trend cards by source, velocity score, Refresh now | "Write script" on any trend card |
| **Ideas** | grouped by day, Picked / Skip, filters | **Generate ideas**, and "Write script" on an idea |
| **Scripts** | board: To shoot → Shot → Edited → Posted, drag or arrows; detail view with teleprompter and copy buttons | arrives live when generated or imported elsewhere; the **edit plan** below the teleprompter, and **Make edit plan** when a script has none |
| **Projects** | *new* | a folder per video: notes, links and files that reach the other device in a second. **Open project** from any script, an **Inbox** for anything shared in from Android, a per-item note saying which device it came from, and **Send a video** — straight to the other device over WebRTC, with the copy checked byte for byte |
| **Results** | totals, avg views, save rate, streak, bars by format/hook/len/CTA, top 5, full table | same numbers, computed in the browser |
| **Import** | paste box, file upload, recent imports log | **Paste from Shorts Studio** button (clipboard), same on Ideas and Scripts |
| **Settings** | watch folder, keywords, YouTube quota, LAN URLs, backup/restore | niche keywords, language, default length, AI order and models, **Test AI**, import token management, backup/restore, **this device's name**, and how much of the 300 MB of project files is used |

**The everyday flow**

1. Export from Shorts Studio → tap **Paste from Shorts Studio** on Ideas,
   Scripts or Import. (Or upload the file; or, once the watcher exists, let it
   import itself out of Downloads.)
2. It appears on the phone within a second or two, with a toast (Realtime).
3. Radar has fresh trends every morning at 07:00 IST.
4. Pick an idea, or generate ideas, or write a script from a trend.
5. Move the script across the board as you shoot and edit.
6. Log results in Shorts Studio, export, and the Results screen updates.

**The folder flow**

1. On a script, tap **Open project**. The folder is made the first time and
   reused afterwards.
2. On the phone, share a reference screenshot or a link into ViralRadar from any
   app's Share menu. It lands in the **Inbox**.
3. On the laptop, paste the tool's URL into the folder's Send box. The phone
   says *New from Laptop: …* a second later.
4. Shoot and edit on the phone, then **Send a video** to the laptop — or the
   other way round. It goes device to device, and the panel says
   *✓ Identical to original* when the digests agree.
5. Once the video is up, mark the folder **Posted**. Its files are deleted
   fourteen days later, by itself. The notes, links and video records stay.

---

## 9. Status

**The migration is done.** Everything in the plan is built, deployed and in use
except the optional folder watcher.

| Phase | State |
|---|---|
| 1. Branch and baseline | **done** |
| 2. Shared cores extracted | **done** — local app still passes its original tests |
| 3. Schema, RLS, isolation test | **done, verified against the real database** |
| 4. `vr-import` | **done, deployed and probed live** |
| 4. `vr-generate` | **done, deployed, both providers verified live** |
| 4. `vr-refresh-trends` | **done, deployed, run live** |
| 5. pg_cron daily refresh | **done** — 01:30 UTC, triggered and verified |
| 6. Frontend on supabase-js + Realtime | **done, deployed** |
| 7. Generate / Write script / Paste buttons | **done** |
| 8. Netlify build and deploy, PWA | **done** — installed on the phone |
| 9. Watcher as a standalone script | **not started** — optional, may be skipped |
| 10. README rewrite | **done** |

Phase 10 originally also contained a SQLite → Postgres migration. It was
dropped, not skipped: no local database ever held any data, so there was
nothing to move.

### What works today

Open **https://ytshortradar.netlify.app**, sign in with an email and password,
and all six screens read and write the real database:

- **Import** — paste, upload, or the clipboard button. A real export goes
  through the deployed function and lands as proper rows.
- **Realtime** — an import on the laptop appears on the phone a second or two
  later, with a toast, no refresh.
- **Radar** — Hacker News, Reddit and GitHub, refreshed by pg_cron at 07:00 IST
  without anything being open.
- **Ideas / Scripts / Results** — all the local app's screens, including the
  teleprompter, the board, the analytics, and the edit plan below the script.
- **AI** — ideas, scripts and edit plans, from Gemini, falling back to
  OpenRouter. Verified live in both directions: with `gemini_model` pointed at a
  model that does not exist, all three came back from OpenRouter and were
  written with `source = 'openrouter'`. Test AI shows both answering
  (Gemini ~2.0s, OpenRouter ~1.2s).
- **Installed on the phone** from the home screen, offline shell included.

### What does not work yet

- **YouTube is missing from the Radar.** The `YOUTUBE_API_KEY` secret is
  rejected by Google: "API key not valid". This is a key problem in the Google
  Cloud console, not a code problem — the YouTube source itself is written and
  tested. Hacker News, Reddit and GitHub all return results, so the Radar is
  useful without it.
- **No folder watcher.** Phase 9, optional. *Paste from Shorts Studio* does the
  same job in one tap and works on the phone, which a watcher never could.
- **Video transfer has never run between two real devices.** The protocol is
  tested end to end in Node — corrupted byte, cancel, backpressure, digest
  mismatch — but `RTCPeerConnection` has never actually opened here, so the
  handshake, presence, and the File System Access save path are unexercised.
  This is the largest untested surface in the project and it needs two devices
  on one Wi-Fi to clear.

**Done by hand:** migrations pushed, schema exposed to the Data API, account
created with a password and added to the allowlist, the three API keys
(Gemini, OpenRouter, YouTube) in Supabase secrets, `ALLOWED_ORIGINS` and
`CRON_SECRET` set, the cron secret also in Vault, code on GitHub,
Netlify deploying from `main`, all four functions deployed, PWA installed on
the phone.

---

## 10. Testing

`npm test` — **374 tests**, no network, no database, no keys needed. One
more is skipped unless `VR_SLOW_TESTS=1`: it hashes 512 MB to check the digest
at the size where the bit-length high word stops being zero.

`npm run test:rls` — **306 assertions and 7 proofs** against the real Supabase
database. It connects as `postgres`, which owns the tables and therefore
bypasses RLS, so every assertion runs in its own transaction that first becomes
a real signed-in user (`SET LOCAL ROLE authenticated` plus `request.jwt.claims`)
and is then rolled back. Three throwaway accounts are created and deleted; one
is deliberately left off the allowlist.

The **proofs** are the unusual part: each breaks one policy inside a transaction,
demands that a named assertion now *fails*, and rolls back. A proof that does not
produce a failure is itself reported as a failure. This caught two assertions
that were passing for the wrong reason (see §11).

The suite also covers **files**, which are a different table with different
policies and no `user_id` column:

- a user can read, rename and delete only files whose path starts with their own
  id, in ViralRadar's own bucket, in both directions between the two test users
- a file cannot be renamed out of its owner's prefix, which is the storage
  equivalent of handing a row away
- nothing can land at the top of the bucket or in a deeper tree
- an account that is signed in but not on the allowlist sees no files, can
  upload none, and totals up zero bytes whatever is in the bucket
- **the 300 MB cap**: one test user is given a 320 MB file in the fixtures, so
  the same run proves the cap refuses that user's next upload, that the other
  user — in the same bucket — is unaffected, and that being full still allows
  deleting, or there would be no way back
- **the 25 MB limit**, in both places that can refuse it: the `CHECK` on
  `size_bytes`, and the bucket's `file_size_limit`
- **the 14-day cleanup**: one folder posted 30 days ago and one posted 3 days
  ago, with a file in each. Exactly one being due is what says the fortnight is
  applied rather than "posted" alone; asking for 60 days returns nothing, which
  says the period is really a parameter; and one user cannot see which of the
  other's files are due
- **rows that belong to you and are still wrong** — an item in someone else's
  folder, a path pointing outside the folder it claims, a file over 25 MB, a
  second Inbox, a video claiming to be verified with no digest. RLS decides
  which rows you may write and says nothing about whether their contents are
  true, so these are constraints, and they are tested as such
- **the private signalling channel**, in both directions: each user is allowed
  on their own and refused on the other's, a channel name that is not a user id
  is allowed to nobody, and the non-allowlisted account is allowed nowhere.
  `realtime.topic()` reads a connection setting, so the suite can set it and
  exercise the real gate

### Testing the half that cannot be tested

A video transfer involves `RTCPeerConnection`, Realtime presence and the File
System Access API, none of which exist in Node. The usual outcome would be a
feature with no tests at all. Instead:

- **`shared/transfer.mjs` holds every decision**, behind four injected ports
  (signaling, channel, source, sink) — the same trick the import path uses with
  its storage port. `test/transfer.test.js` wires a sender and a receiver
  together through fakes and runs **whole transfers in Node**: a byte corrupted
  in flight (must refuse the file, not save it), a cancel half way (must leave
  nothing behind), a channel that fills up (must stop the sender, not the tab),
  a sender that lies about the size, a transfer that stops short whose digests
  would otherwise have matched.
- **`public/transfer.js` is only the wiring**, and a test asserts it stays that
  way: no hashing, no digest comparison, no chunk size or threshold in it.
  Anything that decides something there would be untested by construction.
- **`shared/sha256.mjs` is not trusted, it is checked.** It is hand-written,
  because `crypto.subtle.digest()` needs the whole message at once and a 2 GB
  video cannot be. A hand-written SHA-256 that is wrong in one case would report
  "✓ Identical to original" about a file that is not — worse than not checking.
  So it is run against the published FIPS vectors, and then against
  `crypto.subtle.digest()` on random data at hundreds of lengths in random chunk
  sizes, with the padding boundaries (55, 56, 63, 64 bytes) checked by name.

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
The success path was then confirmed against the real thing: an export sent
from the app arrived as one row with the right owner, `source` of
`shorts-studio`, `raw` holding the original item, and `stage` left at its
default — which is the import correctly not sending the pipeline columns.

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
- **Ports wherever the platform cannot be run in Node.** The import path has a
  storage port; a transfer has four. Both exist so the decisions can be tested
  and the untestable layer stays thin enough to read in one sitting.
- **A real SHA-256, not a hash of hashes.** A Merkle-style digest would also
  stream and would be a few lines, but it would not be the file's SHA-256, so
  it could not be checked against `sha256sum`. A number only ViralRadar can
  produce proves nothing to anyone.
- **No TURN relay, and the consequence stated rather than hidden.** It would
  cost money and would carry every byte of every video. Mobile data therefore
  does not work, so the failure message says exactly that and names LocalSend.

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
- *Two new shared modules were not shipped to the browser* — `sha256.mjs` and
  `transfer.mjs` were written and imported before being added to
  `BROWSER_SHARED`, which would have been a 404 and a blank screen. Caught
  immediately by the test that checks every import the browser makes is really
  copied. It also found that the rule it enforced was too strict: it forbade a
  browser module importing another at all, which `transfer.mjs` legitimately
  needs. The rule is now "it may, if the target is also shipped".
- *A Stop button that would not have stopped anything* — the receiving side
  only acts on an incoming message, so with a sender that had gone quiet the
  flag would have been read at some indefinite future point. Written first,
  spotted on re-reading, and now a short poll on both sides. The same pass found
  a variable used before its `let`, which happened to work only because the
  interval fired later.
- *A folder list that read every note in full* — the Projects screen draws a
  preview on each card, and the query pulled `content` to do it. A note can be
  20,000 characters, so a few hundred of them would be megabytes over a phone
  connection to draw a list of folders. Now a generated `preview` column. The
  test asserting the behaviour was written before the problem was noticed and
  had to be corrected along with it.
- *A build-time check reported success without looking* — it treated any 401
  as "schema exposed, anon refused", when the 401 was the project rejecting
  the key. It said step 4 was done when it had not been.
- *A bare `Bearer` header* was classified as a JWT and would have been forwarded
  as one.
- *`decodeURIComponent` throws on a stray `%`* — exactly the password that sends
  someone looking for help would have crashed the helper meant to help them.
- *A placeholder in a prompt is a value in the answer.* The ideas shape said
  `"date": "YYYY-MM-DD (today)"`. Gemini filled it in sensibly; the OpenRouter
  model copied the parenthetical, and because `date` is a real date column
  Postgres refused the whole statement: `invalid input syntax for type date:
  "2026-10-08 (today)"`. Found the first time the fallback ran against a second
  live provider, and invisible until then. Fixed at both ends — the prompt now
  carries the real date, and `dateOnly()` means nothing reaches a date column
  without being one. Two lessons: a second model is a test the first cannot
  perform, and a prompt is input validation.
- *JavaScript rolls impossible dates forward.* `new Date('2026-02-31')` is
  3 March, where Postgres rejects it. The first version of `dateOnly()` would
  have written a date nobody typed; the test caught it on its first run, which
  is why it checks the digits survive the round trip rather than only that
  parsing succeeded.

---

## 12. Known gaps

- **Deno is not on PATH on this machine**, so the functions cannot be
  type-checked or executed locally. TypeScript parses them, the untestable layer
  is kept deliberately thin — all behaviour lives in `shared/*.mjs` — and the
  deployed function is probed over HTTP instead (see §10).
- **The free models are a moving target, and this will need attention again.**
  Inside a few days gemini-2.5-flash was retired outright and
  meta-llama/llama-3.3-70b-instruct:free stopped being free. Both replacements
  were chosen by measuring: four samples of each Gemini model gave
  gemini-flash-latest 1/4 (503 high demand), gemini-3.8-flash 2/4 (429) and
  gemini-3.5-flash 4/4; six free OpenRouter models tried through the deployed
  function left nvidia/nemotron-3-super-120b-a12b:free as the one that answered.
  Both are Settings fields, both column defaults are now pinned to the code by
  test/defaults.test.js, and **Test AI** names the cause when one dies. There is
  no durable answer here — only a short path to the fix.
- **The import token path has not been exercised end to end.** The browser
  path has: a real export went through the deployed function and landed
  correctly. The token path is verified only as far as a refusal, because no
  token has been created yet and the watcher does not exist.
- **The OpenRouter key is not in `.env`**, only in Supabase secrets, so the
  fallback can only be exercised through the deployed function and not from a
  local test. That is how it was verified; there is no offline equivalent.
- **Realtime between two devices** is wired and works on one device; the
  two-device case has not been sat and watched. The PWA is installed on the
  phone, so this is now observable whenever you want to check it.
- The **allowlist** has one entry. The other three accounts in this project can
  sign in and will see an empty app that saves nothing — by design, but it has
  not been confirmed by signing in as one of them.
- **Project folders have not been used across two real devices yet.** Everything
  is built and tested, but the thing it exists for — share a screenshot in on the
  phone, see it on the laptop a second later — is observable and has not been
  sat and watched. The same is true of the Android Share menu entry, which only
  appears once the installed PWA has updated its service worker.
- **The nightly file cleanup has not fired yet.** The rule is tested against
  real dates in the RLS suite and the function is written, but it needs
  `cron_config.purge_function_url` filled in, and nothing has been posted for
  fourteen days. **Clean up now** in Settings runs it on demand, which is how to
  check it without waiting.
- **The 300 MB cap can overshoot by one file.** It is checked as the row is
  created, so the file being uploaded is not yet counted — 325 MB worst case out
  of a ~1 GB shared quota. Counting the new row would need its size, which
  `storage.objects` does not have at that point. The browser refuses at 300 MB
  long before the policy does.
- **A transfer does not resume.** Cancelling, or a dropped connection, is clean
  — the part-written file is discarded and no row is written — but starting
  again starts from the beginning. Real resumption would need the partial file
  and its byte offset to survive a tear-down, which the File System Access path
  could manage and the Blob path could not, so it would work on a laptop and
  not on a phone. That asymmetry was not worth shipping; "cancel is safe" is.
- **One transfer at a time**, deliberately. Two 2 GB transfers over one Wi-Fi
  link are slower than two in sequence, and on a phone they are two ways to run
  out of memory instead of one. A second offer is declined with a reason rather
  than ignored.
- **Mobile data will not work**, and cannot be made to without a TURN relay —
  which would have to be paid for and would carry every byte of every video.
  The 15-second timeout says so in words and points at LocalSend. This is a
  design decision, not a bug, but it is the thing most likely to be mistaken
  for one.
- **The private channel's authorisation is only half-proved.** The RLS suite
  sets `realtime.topic()` and exercises the real gate, and reads the policies
  back out of `pg_policies` — but whether the Realtime *server* consults them
  can only be shown by two real devices, one of which is signed in as somebody
  else. That test has not been run.

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
| `npm run sync:shared` | refresh the generated copies under `supabase/functions/` and `public/` | nothing |
| `npm run icons` | regenerate the PWA icons from scratch | nothing |
| `npm run build` | build the site into dist/, as Netlify does | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| `npm start` | the old local app — **on the `local-sqlite` branch only** | nothing |
| `npx supabase db push` | apply migrations | logged in, linked |
| `npx supabase secrets list` | names and hashes of the secrets | logged in, linked |
| `npx supabase functions deploy vr-import --use-api` | deploy a function without Docker | logged in, linked |

There are four functions to deploy: `vr-import`, `vr-generate`,
`vr-refresh-trends`, `vr-purge-project-files`.

Environment: Node 24, Supabase CLI 2.120.0, PostgreSQL 17.6, project
`tracebug` (shared with another app), region `ap-south-1`.
