# ViralRadar cloud setup — everything you do by hand

This is the full list of manual steps, in order.

**Almost all of these are done.** The app is live at
https://ytshortradar.netlify.app, signs you in, syncs between laptop and phone,
imports, generates and refreshes trends on schedule. All seven migrations are
applied, and `npm run test:rls` passes **309 assertions and 7 proofs** against
the real database — including the project-file bucket and the private channel
the two devices signal on.

So this document now does two jobs: it is the **record** of how the live setup
was put together, and the **recipe** if it ever has to be done again — a new
Supabase project, a new machine, or a rebuild from scratch. Steps you have
already done are marked ✅.

**What is still outstanding**, all of it for the project-folders and video
features:

| Step | What |
|---|---|
| 10 | deploy `vr-purge-project-files` — the other three are deployed |
| 11b | set `cron_config.purge_function_url`, or the nightly cleanup does nothing |
| 14b | reload the installed PWA so its service worker picks up the Share Target |
| 14c | run a video transfer between two devices on one network |
| 16 | the folder watcher — optional, not built, probably never needed |

The local app also still works, untouched, on the `local-sqlite` branch:
`git switch local-sqlite` then `npm start`.

**One rule above all others:** this Supabase project is shared with your
tracebug app. **Never run `supabase db reset`.** It erases the entire database,
tracebug included. `supabase db push` is safe — it only adds migrations that are
not there yet.

---

## Accounts you need

| Service | Cost | What for |
|---|---|---|
| Supabase | Free | Database, login, Edge Functions, daily schedule |
| Netlify | Free | Hosts the web app |
| GitHub | Free | Netlify deploys from here |
| Google AI Studio | Free | Gemini API key, for writing ideas and scripts |
| OpenRouter | Free | Backup AI, when Gemini hits its daily limit |
| Google Cloud | Free | YouTube Data API key (you may already have this) |

You already have the Supabase project (tracebug) and the Supabase CLI
(version 2.120.0) and Deno installed.

---

# PART 1 — The database and your account ✅

Everything in this part is done. After Step 2 the database stopped being a
guess and became something the tests could check against.

## Step 1. Point the tools at your database

1. Open the Supabase dashboard and pick your **tracebug** project.
2. Click **Connect** at the top of the page, next to the branch name.
3. Choose the **Direct / Connection string** tab (the database icon). That tab
   means "connect straight to Postgres" rather than through a client library —
   it is not only the direct-connection string.
4. Use the **pooled** string, labelled **Shared pooler** (older wording: Session
   pooler). You can recognise it by three things: the host ends in
   `.pooler.supabase.com`, the port is `5432`, and the user is
   `postgres.<project-ref>` — with a dot, not plain `postgres`.
   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
   ```
   Avoid the **Direct connection** string (host `db.<ref>.supabase.co`): it is
   IPv6-only and usually does not work from a home internet connection.
5. In `D:\Project\viralradar`, copy `.env.example` to `.env` if you have not
   already. Open `.env` in Notepad and add the line, with `[YOUR-PASSWORD]`
   replaced by your real database password:
   ```
   DATABASE_URL=postgresql://postgres.abcdefghijkl:your-real-password@aws-1-ap-south-1.pooler.supabase.com:5432/postgres
   ```
   If you have forgotten the password: **Project Settings → Database → Reset
   database password**. Resetting it does not affect tracebug's data, but if
   tracebug has the old password saved somewhere you will need to update it there.

`.env` is gitignored, so the password never leaves your laptop.

## Step 2. Look at what is already in the project

```powershell
cd D:\Project\viralradar
npm install
npm run inspect:db
```

This only reads. It runs ten `SELECT` statements and changes nothing.

It is the quickest way to see the real state of things: which tables exist, how
many rows are in each, whether the schema is exposed to the browser, and how
much of the 500 MB free limit is used. Worth running any time something looks
wrong, before guessing.

## Step 3. Create the tables

First let the CLI into your Supabase account. This is separate from the database
password: it is how the CLI proves it is allowed to act on your projects.

```powershell
npx supabase login
```

A browser window opens. Sign in and approve it; the CLI may show a short
verification code to confirm it matches what the browser shows. The token is
stored on this laptop, outside the project folder, so it never reaches git.

If the browser does not open, create a token by hand at
**https://supabase.com/dashboard/account/tokens**, then:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_the-token-you-created"
```

That lasts for the current terminal window only, which is a good thing.

Then link the project and push the migrations:

```powershell
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Your project ref is the random-looking part of your project URL
(`https://abcdefghijkl.supabase.co` → `abcdefghijkl`), also shown under
**Project Settings → General → Reference ID**.

`link` asks for your database password. You can paste it (it is saved in
`supabase/.temp`, which is gitignored) or press Enter to skip, in which case
`db push` asks for it instead.

`db push` lists the migrations it is about to apply and asks you to confirm.
There are seven, and they are safe to run against a project that already has
some of them: it applies only the ones missing. Between them they create a
schema called `viralradar` and ten tables inside it — the nine the app uses,
plus `allowed_users`, which controls who may use ViralRadar at all — then the
security policies, the daily schedule, the model defaults, the project folders
with their file storage, and the device-to-device video transfer. Nothing
touches `public`, where tracebug lives.

The last two migrations are the only ones that reach outside the `viralradar`
schema, and it is worth knowing what they do there, because **Storage and
Realtime are shared with tracebug** the same way `auth.users` is:

- **one row** in `storage.buckets`, for a private bucket called
  `vr-project-files` with a 25 MB per-file limit
- **four policies** on `storage.objects`, all named `vr_project_files_*` and
  all scoped to that bucket in their very first condition
- **two policies** on `realtime.messages`, named `vr_devices_read` and
  `vr_devices_write`, which are what make the channel your two devices signal
  on a private one rather than merely an obscurely named one

None of them alters or removes anything that was already there — a policy on
`storage.objects` or `realtime.messages` may well be tracebug's.

**This was measured, not assumed.** A fingerprint of every policy on those two
tables that is *not* ViralRadar's was taken before and after the push and came
back identical, and the RLS flags on both tables were unchanged. What was there
beforehand: three policies of tracebug's on `storage.objects`
(`reports_select_own`, `reports_insert_own`, `reports_delete_own`) and **none at
all** on `realtime.messages` — which means tracebug uses no private Realtime
channels, so there was nothing there for the new policies to interact with. The
statement that does this is in PROJECT.md §5; worth re-running before any future
migration that touches either table.

Check it worked: **Table Editor** → the schema dropdown (top left, probably says
"public") → you should now be able to pick **viralradar** and see `ideas`,
`scripts`, `results`, `trends`, `settings`, `usage`, `import_tokens`,
`projects`, `project_items`. Then **Storage** in the left sidebar should list a
bucket called `vr-project-files` with a padlock (private).

### If `db push` fails on a policy outside the viralradar schema

`storage.objects` and `realtime.messages` belong to their extensions rather than
to you, so depending on how your project is set up the CLI may be refused when
it tries to add a policy to one. The error says something about permission or
ownership.

Everything before that point has still been applied. Do the refused part from
the dashboard, which runs as an owner and will be allowed:

1. **Storage → New bucket.** Name it exactly `vr-project-files`. Leave
   **Public** off. Under *Additional configuration*, set the file size limit to
   **25 MB**.
2. **SQL Editor → New query.** Open
   `supabase/migrations/20261008000400_projects.sql`, copy the part from
   `-- ---------- storage policies ----------` to the end of the last
   `create policy` block, paste it, and run it.
3. Same again for `supabase/migrations/20261008000500_video_transfer.sql`: the
   two `create policy ... on realtime.messages` blocks.

Then carry on. `npm run test:rls` checks the result either way — it reads the
policies back out of the database rather than out of the files — so you do not
have to take anyone's word for whether it worked.

## Step 4. Let the browser see the new schema

The app cannot read anything until you do this. The CLI cannot do it for you.

1. **Project Settings → API**
2. Find **Exposed schemas** (it may be called "Data API settings").
3. Add `viralradar` to the list. Keep `public` in the list.
4. Save.

This is additive. tracebug keeps working exactly as before.

**Check it took.** Add these two lines to `.env` (both from Project Settings →
API Keys — the **publishable** key, never the secret one):

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-publishable-key>
```

then run `npm run inspect:db` again. The last section tells you whether the
schema is really exposed — this is the one setting nothing else can verify, and
if it is wrong the app just looks empty with no error.

## Step 5. Prove nobody can read your data

```powershell
npm run test:rls
```

This creates three throwaway users and tries 309 ways to get at data that is not
theirs, then deletes them. Two of the three are ViralRadar users; the third is
signed in but not on the allowlist, standing in for a tracebug account. It also
breaks seven security rules on purpose inside a transaction, checks the test
notices, and rolls back so the rules come straight back.

It covers the files as well as the rows, which are protected by a different set
of policies on a table shared with tracebug. To test the 300 MB cap without
uploading 300 MB, one of the throwaway users is given a storage row that *claims*
to be 320 MB with no bytes behind it. The run then proves that user's next
upload is refused, that the other user — in the same bucket — is unaffected, and
that being full still lets you delete, or there would be no way back. All of it
is rolled back or deleted at the end.

It also checks the private channel your two devices signal on, in both
directions, and reads the policies back out of the database rather than out of
the migration files — which is the one assertion in there that tells you a
migration was really applied.

What you want to see at the end:

```
assertions: 309 passed, 0 failed
proofs:     7 passed, 0 failed

PASS - a user can only reach their own rows, and the test can detect it when that breaks.
```

**This has been run against the live database and passes** — 309 assertions,
7 proofs, with all three throwaway users and every fixture cleaned up
afterwards. That is the first clean run including the project-file bucket and
the signalling channel, and getting there took three bugs in the harness itself;
they are written up in PROJECT.md §11, because each one was a test that could
not have failed.

**If anything ever fails, paste it to me and put no real data in the project
until it passes.** There is also a browser version: paste
`supabase/tests/rls.sql` into **SQL Editor → New query → Run**. Note that the
Supabase SQL editor shows only the **last** statement's result and does not
surface `NOTICE` output at all, so read the error it ends with rather than
looking for a Messages tab.

## Step 6. Create your account

Your login. Do this now, because the daily schedule needs your user id.

1. **Authentication → Users → Add user → Create new user**
2. Enter your email. Tick **Auto Confirm User** so you do not have to click a
   confirmation link.
3. **Set a password.** This is the one you will type to sign in. Pick something
   only you know — nobody else, including whoever wrote this, ever sees it:
   Supabase stores a hash, not the password.
4. Click your new user in the list and copy the **User UID** (a long
   `xxxxxxxx-xxxx-...` string).

**To change the password later:** Authentication → Users → click your user →
**Reset password**, or send yourself a sign-in link from the app and set a new
one.

> **Why the password cannot live in the code.** Everything the site serves —
> every `.js` and `.html` file — is downloaded by the browser and readable by
> anyone who opens it. A password written into the app would be a password
> everybody has. Keeping it in Supabase is what makes "only I know it" true. A
> test fails the build if anything that looks like a credential appears in the
> shipped files.

**Save that UID somewhere.** I need it in Part 2 for the daily schedule.

### Step 6b. Add yourself to the ViralRadar allowlist

This Supabase project already has **3 accounts** in it from tracebug. Signing in
is therefore not enough to be a ViralRadar user — you also have to be on the
allowlist. Nobody can add themselves: the table is readable and writable only by
the service role.

**SQL Editor → New query**, with your UID from the step above:

```sql
insert into viralradar.allowed_users (user_id, note)
values ('paste-your-user-uid-here', 'me');
```

Check it took:

```sql
select user_id, note from viralradar.allowed_users;
```

Until you do this, you can log in but every screen will be empty — which is
exactly what the three tracebug accounts will see, permanently.

Do **not** turn off signups yet. That comes at the very end, and it is now
optional — see Step 15.

## Step 7. Get the three API keys

All free. **Never paste a key into the app itself or into the browser.**

Each key goes in up to two places, and nowhere else:

- **Supabase secrets** (Part 2, Step 9) — required. This is where the deployed
  functions read them from. They never reach your phone or your browser.
- **`.env` on this laptop** — optional. Only so the tests can call the real
  providers instead of a stand-in. `.env` is gitignored, so it stays here.

**Gemini** (main AI)
1. Go to **https://aistudio.google.com/apikey** and sign in with your Google
   account.
2. Click **Create API key**.
3. If it asks about a Google Cloud project, choose **Create API key in new
   project** — the simplest option, and nothing else will use it.
4. Copy the key. It starts with `AIza...` and is shown in full whenever you go
   back to that page, so it is not a once-only secret like the database one.
5. Optional, for the tests: add it to `.env` as
   ```
   GEMINI_API_KEY=AIza...
   ```

Free tier, with a per-day request limit. The model is set in ViralRadar's
Settings (default `gemini-2.5-flash`), so if your account does not have free
access to a particular model you can change it there without touching any code.

**OpenRouter** (backup AI, used when Gemini is out of quota)
1. Go to https://openrouter.ai and sign up
2. Go to https://openrouter.ai/keys → **Create key**
3. Copy it. We will use a model whose name ends in `:free`, so there is nothing
   to pay.

**YouTube Data API** (trend radar) — you may already have this in `.env`
1. https://console.cloud.google.com → create or pick a project
2. Search **YouTube Data API v3** → **Enable**
3. **APIs & Services → Credentials → Create credentials → API key**
4. Copy it. 10,000 units a day free; the app stops itself at 25 searches a day.

Without the YouTube key the radar still works using Hacker News, Reddit and
GitHub. Without any AI key, the "Generate ideas" and "Write script" buttons will
tell you no key is set, and everything else still works.

## Step 8. Put the code on GitHub

Netlify deploys from GitHub, so this has to exist before Part 3.

1. Go to https://github.com/new
2. Repository name: `viralradar`
3. Choose **Private**.
4. Do **not** tick "Add a README", ".gitignore" or a licence — the project
   already has them.
5. Click **Create repository**, then run this in PowerShell, replacing
   `<your-username>`:

```powershell
cd D:\Project\viralradar
git remote add origin https://github.com/<your-username>/viralradar.git
git push -u origin main
git push origin cloud
```

Both branches end up on GitHub:

- `main` — the old local-only version, untouched, still runs with `npm start`
- `cloud` — the new synced version, which is what Netlify will deploy

If git asks you to sign in, a browser window will open; approve it there.

`.env` is gitignored, so none of your keys or passwords go to GitHub. Worth
checking once: run `git status` and confirm `.env` is not listed.

---

# PART 2 — Keys and the Edge Functions  (one function still to deploy)

All three functions are deployed and all the secrets are set. The commands are
here so the same thing can be done again without working it out twice.

## Step 9. Give Supabase the API keys

Secrets are independent of the functions — setting them before a function exists
is fine, and changing one later needs no redeploy.

```powershell
cd D:\Project\viralradar
npx supabase secrets set "GEMINI_API_KEY=AIza-your-real-key"
```

Quote the whole `NAME=value` pair: PowerShell otherwise treats some characters
in a key as syntax. Repeat for the others as you get them:

```powershell
npx supabase secrets set "OPENROUTER_API_KEY=sk-or-your-real-key"
npx supabase secrets set "YOUTUBE_API_KEY=your-youtube-key"
```

**`SEARCH_API_KEY` is optional and you can ignore it.** With it, a Research Pack
finds its pages through a search API; without it, it uses the AI's own candidate
URLs and then checks them. Either way every page is fetched and verified before
anything is written. If you do want one, a Brave Search free-tier key works:

```powershell
npx supabase secrets set "SEARCH_API_KEY=your-brave-key"
```

Check it worked:

```powershell
npx supabase secrets list
```

That prints the **names and a hash**, never the values. Seeing
`GEMINI_API_KEY` in the list is the confirmation.

### Setting several at once, without them in your command history

PowerShell remembers every command you type, including the key. If you would
rather it did not, put them in a file instead:

1. Create `supabase/.env.secrets` (gitignored, so it stays on this laptop):
   ```
   GEMINI_API_KEY=AIza-your-real-key
   OPENROUTER_API_KEY=sk-or-your-real-key
   YOUTUBE_API_KEY=your-youtube-key
   ```
2. Push them all in one go, then delete the file:
   ```powershell
   npx supabase secrets set --env-file supabase/.env.secrets
   Remove-Item supabase/.env.secrets
   ```

**Do not** point `--env-file` at your main `.env`. It would try to send
`DATABASE_URL` as well, which has no business being there, and Supabase refuses
any name starting with `SUPABASE_` anyway.

### What you must NOT set

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are given
  to every function automatically. Supabase rejects those names, and the
  functions already expect the built-in ones.
- Nothing here ever reaches your browser, your phone or the database. That is
  the whole reason the AI calls happen in an Edge Function instead of in the
  app.

## Step 10. Deploy the five functions

```powershell
npx supabase functions deploy vr-import --use-api
npx supabase functions deploy vr-generate --use-api
npx supabase functions deploy vr-research --use-api
npx supabase functions deploy vr-refresh-trends --use-api
npx supabase functions deploy vr-purge-project-files --use-api
```

`--use-api` builds them on Supabase's side, so you do not need Docker. (I
checked this flag against your installed CLI: "Bundle functions server-side
without using Docker.")

They are named `vr-` on purpose, so they can never overwrite a function
belonging to tracebug.

## Step 11. Turn on the daily refresh

1. **Database → Extensions**, search and enable **pg_cron** and **pg_net**.
2. I will give you one SQL statement to paste into the **SQL Editor**. It stores
   a secret in Supabase Vault and schedules the trend refresh for 01:30 UTC,
   which is 7:00 AM in India. Your user UID from Step 6 goes into it.

The daily run has a useful side effect: free Supabase projects are paused after
about a week with no activity, and this keeps the project awake — which now
keeps tracebug awake too.

## Step 11b. Turn on the nightly file cleanup

The migration already scheduled this job for 02:00 UTC (7:30 AM IST), half an
hour after the trend refresh so the two never overlap. It needs one more thing:
where to call. Until that is filled in the job runs, finds nothing configured,
and does nothing — which is the right behaviour, but it also means the cleanup
is not happening.

**SQL Editor → New query**, with your project ref in place of the placeholder:

```sql
update viralradar.cron_config
   set purge_function_url = 'https://<your-project-ref>.supabase.co/functions/v1/vr-purge-project-files';
```

That table has exactly one row, created in Step 11. It reuses the same Vault
secret and the same `user_id`, so there is nothing else to set.

**Why a function at all, rather than SQL?** Deleting a row from
`storage.objects` does not delete the bytes behind it. They stay in the bucket,
still counted against this project's ~1 GB, and now with nothing left to find
them by. Only the Storage API really removes a file, and SQL cannot call it.

**Check it without waiting two weeks.** Open **Settings** in the app and tap
**Clean up now**. It runs the same function against the same rule and tells you
how many files went and how much space came back. With nothing due it says
"Nothing to clean up", which is also a pass — it means the function is deployed,
reachable and allowed.

---

# PART 3 — The site and your phone  (the two-device checks still to do)

## Step 12. Create the Netlify site

1. Go to https://app.netlify.com and sign up, choosing **Sign up with GitHub**.
2. **Add new site → Import an existing project → GitHub**.
3. Authorise Netlify, then pick your `viralradar` repository.
4. Set these, exactly:
   - **Branch to deploy**: `main`
   - **Build command**: leave as whatever `netlify.toml` provides
   - **Publish directory**: leave as whatever `netlify.toml` provides
5. Before the first deploy, click **Add environment variables** (or set them
   afterwards under **Site configuration → Environment variables**):

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<your-project-ref>.supabase.co` |
   | `SUPABASE_ANON_KEY` | your publishable key (see below) |

6. **Deploy**.

Both values come from **Project Settings → API Keys**. You want the key that
begins **`sb_publishable_`**.

**Not the long `eyJ...` one.** That is the legacy anon key, and this project has
legacy keys switched off (they were disabled on 2026-07-19). Using it gives
"Legacy API keys are disabled" when you try to sign in. `npm run build` now asks
the project whether it accepts the key and refuses to build if it does not, so
this fails at deploy time rather than on the sign-in screen.

The publishable key is safe in a browser: Row Level Security is what protects
your data, which is what Step 5 proved.

**Never use the secret / `service_role` key here.** That one bypasses all
security. It belongs only in Supabase secrets.

Your site gets an address like `https://viralradar-abc123.netlify.app`. You can
rename it under **Site configuration → Change site name**.

From then on, every push to the `cloud` branch redeploys automatically.

## Step 13. Log in

1. Open the Netlify address on your laptop.
2. Type your email and press the login button.
3. Check your email and click the magic link. It opens the app, logged in.
4. Do the same on your phone.

If the link arrives but opens **the other app** (tracebug.dev), that is the one
genuinely shared setting in Authentication. Fix it like this:

**Authentication → URL Configuration → Redirect URLs → Add URL:**

```
https://ytshortradar.netlify.app/**
```

**Leave Site URL as `https://tracebug.dev`.** Site URL is project-wide and the
other app depends on it. Redirect URLs is a list and only ever adds, so both
apps can live together: each one asks to come back to its own address, and
Supabase allows it only if the address is on this list. ViralRadar does ask —
but when the address is not listed, Supabase quietly falls back to Site URL,
which is how a sign-in link ends up on the wrong site.

If the link does not arrive at all, check your spam folder first.

Free Supabase sends a limited number of emails per hour, which is plenty for one
person.

## Step 14. Add it to your phone's home screen

Android, Chrome: open the site → menu (⋮) → **Add to Home screen** → **Install**.
It then opens like an app, with its own icon and no browser bars.

iPhone, Safari: Share → **Add to Home Screen**.

Once installed it opens instantly even on a bad connection, because the app
itself is kept on the device. Your data is not: ideas, scripts, results and
trends are always fetched fresh, so you never see yesterday's numbers and
mistake them for today's. With no signal at all the app opens and says it
cannot reach the database, which is the honest answer.

When a new version is deployed you get a message saying so; reload to take it.

### Step 14b. Check ViralRadar is in the Share menu

Installing the app is also what puts ViralRadar in **Android's Share sheet**, so
you can send a screenshot or a link into it from any app.

It does not appear immediately. Android reads the share entry from the
manifest when the app is installed, and the service worker that receives the
share has to have activated. So:

1. Install it (above). If it was already installed before this feature existed,
   open it, wait for the "a new version is ready" message, and reload.
2. Open any photo → **Share** → scroll the app list. **ViralRadar** should be
   there.
3. Share a screenshot into it. The app opens, says it is adding it, and the
   image appears in your **Inbox** folder on the Projects screen — and on your
   laptop a second later.

If it is not in the list, force-close the app and reopen it once; the worker
activates on the next launch. On iPhone this does not work at all — Safari does
not support share targets — so from an iPhone use the **Add files or images**
button inside a folder instead.

Two things worth knowing:

- A share made with **no signal** is not lost. The worker parks it on the device
  and it is uploaded the next time you open the app with a connection.
- Only images and text are offered, not video. A video is far bigger than the
  25 MB per-file limit, and appearing in the Share sheet for something that
  would then be refused would be worse than not appearing at all.

### Step 14c. Test a video transfer (this one is on you)

This is the part of the app I could not test, and the only way to clear it is to
do it. **Put both devices on the same network first** — same Wi-Fi, or your
laptop connected to your phone's hotspot. Mobile data will not work, for the
reasons below.

1. Open ViralRadar on **both** devices, signed in to the same account.
2. On each, **Settings → This device**, give it a name (*Laptop*, *Phone*) and
   save. Check that each one now lists the other under **Your devices**. If it
   does not, nothing else here will work — see the troubleshooting table.
3. On one device open any project folder → **Send a video → Choose a video…**
   Pick something small the first time, 20–50 MB, so a failure costs seconds.
4. Pick the other device. It should show an **Incoming video** card within a
   second or two. Accept it.
   - On a **laptop** you are asked where to save it first. That is deliberate:
     the file is written straight to disk as it arrives, and the browser only
     allows that to be set up from a click.
   - On **Android** it downloads when it finishes.
5. Watch the progress bar, the speed and the time left. Then the verdict:

```
✓ Identical to original
SHA-256 e3b0c44298fc1c14...
```

6. **Check that digest yourself**, on both files. This is the whole claim:

```
Windows   certutil -hashfile video.mp4 SHA256
macOS     shasum -a 256 video.mp4
Linux     sha256sum video.mp4
```

   Both should match each other and match what ViralRadar showed. If they do,
   nothing was re-encoded, resized or lost.

7. The folder now holds a 📹 note — name, size, digest, which devices have it.
   **Not the video.** Check **Settings → Project files**: the figure must not
   have moved, because nothing was uploaded.

Then try the awkward cases, which are the ones worth knowing about:

- **Press Stop half way.** It should stop at once, say nothing was saved, and
  leave no part-written file. Starting again starts from the beginning — it does
  not resume.
- **Something big**, 1 GB or more, laptop to laptop. This is where streaming to
  disk earns its keep.
- **Big to a phone.** It should warn you *before* starting that the phone has to
  hold the whole thing in memory. Believe the warning.
- **Both devices on mobile data.** Expect it to fail after fifteen seconds with
  a message suggesting the phone's hotspot, and Telegram-as-a-File or Google
  Drive for when the two devices are not even in the same place. That is the
  design, not a fault: getting through carrier NAT needs a relay server, a
  relay carries every byte of every video, and there is no free one.

### Step 14d. Check a Research Pack against a page you can see

The migration and the function are new, so do these two first:

```powershell
cd D:\Project\viralradar
npx supabase db push
npx supabase functions deploy vr-research --use-api
```

`db push` adds `20261008000700_research.sql`, which only widens two check
constraints on `project_items` so a pack can be stored, and
`20261008000800_import_projects.sql`, which adds `external_id` (nullable,
with its own partial unique index) so re-importing the same research pack or
note updates it instead of duplicating it. Nothing is dropped by either.

Then the part worth actually doing — **pick a page you can read yourself**, so
you can tell whether the pack is true:

1. **Scripts** screen. In the top box type what the tool is, and in the second
   box paste its real URL. Press **🔍 Research Pack**.
2. Open that URL in another tab and keep it next to the pack.
3. Check three things, in this order:
   - the source shows a green **● Live** badge, and the URL is the one you gave
     (or the one it redirected to);
   - every green **✓ Verified** fact is genuinely on the page you are looking
     at. This is the claim the whole feature rests on;
   - anything tagged yellow **⚠ Unverified** is something you now go and check —
     that tag is the feature working, not failing.
4. Press **✍️ Write script from this**. The script must not contain any limit,
   price or watermark claim that was not in the verified list. If it does, the
   pack is fine and the prompt is not — tell me, because that is a real bug.
5. Open **📁 Its folder**. The pack is saved there as a 🔍 item. Check
   **Settings → Project files**: the figure must not have moved, because a pack
   is JSON in a row, not a file.

Then one deliberate failure, which is quicker than it sounds:

- Put a URL that does not exist (`https://not-a-real-tool-xyz.example`) in the
  second box and press it. You should get an error saying nothing was written —
  **not** a pack. A pack with no sources would be guesswork, so the function
  refuses to write one.

And one without a URL at all: type just a subject and leave the URL box empty.
It then finds candidate pages itself and checks them, and the pack says so with
a yellow badge reading *URLs were the AI's guesses, then checked*. Expect this
to be slower and less reliable than giving it the link.

## Step 15. Close the door (optional)

**ViralRadar is already closed** without this step. The allowlist from Step 6b
is the real lock: a new account can be created, can sign in, and still sees
nothing and can create nothing. The three tracebug accounts are in exactly that
position today.

Turning signups off is belt and braces, and it is **project-wide** — it would
stop new tracebug registrations too. tracebug has 3 accounts and a `sessions`
table linked to `auth.users`, so think about whether anything there still needs
new people to be able to register.

If you want it anyway, only after logging in successfully on **both** laptop and
phone:

1. **Authentication → Sign In / Providers**
2. Turn **off** "Allow new users to sign up"
3. Save

Your own login keeps working, because your account already exists.

If tracebug does need open signups, leave this alone. Nothing about ViralRadar's
security depends on it.

## Step 16. Start the folder watcher (optional, NOT BUILT YET)

> **`npm run watcher` does not exist yet.** This is the one piece of the plan
> still unwritten, and it is a convenience rather than a requirement: *Paste
> from Shorts Studio* on the Ideas, Scripts or Import screen does the same job
> in one tap, and works on the phone, which the watcher never could. The steps
> below are what it will take when it is built.

Only needed if you want files from Shorts Studio to import themselves from your
Downloads folder.

1. In the app: **Settings → Import tokens → Create token**. Copy it — it is
   shown once and only its SHA-256 hash is stored.
2. Add two lines to `.env`:
   ```
   VR_IMPORT_URL=https://<your-project-ref>.supabase.co/functions/v1/vr-import
   VR_IMPORT_TOKEN=vr_the-token-you-just-copied
   ```
3. Run it:
   ```powershell
   npm run watcher
   ```

Leave that window open while you work. Any `viralradar-*.json` saved into your
Downloads folder is uploaded and then moved to `viralradar-imported\` (or
`viralradar-failed\` with a note explaining why). It appears on your phone a
second or two later.

You can also always paste or upload exports in the **Import** screen, so the
watcher is a convenience, not a requirement.

# Keeping it running

- **Nothing to do daily.** The trend refresh runs by itself at 7:00 AM IST.
- **Free Supabase pauses a project after about a week of no activity.** The daily
  cron counts as activity, so this should not happen. If it ever does, the
  dashboard shows a **Restore** button and nothing is lost.
- **Netlify free tier**: 100 GB bandwidth and 300 build minutes a month. A
  personal app uses a tiny fraction of that.
- **Supabase free tier**: 500 MB database, shared with tracebug. ViralRadar's
  share is a few thousand small rows — `npm run inspect:db` shows the real
  number any time.
- **File storage is about 1 GB for the whole project**, also shared with
  tracebug. ViralRadar takes a fixed **300 MB** of it and refuses uploads past
  that, so tracebug cannot be starved by a stack of screenshots. **Settings →
  Project files** shows how full that slice is. Two things keep it from filling
  up on its own: one file can be at most 25 MB, and files in a project marked
  **Posted** are deleted fourteen days later by the nightly job. Raw video is
  never uploaded at all.
- **Video transfer costs nothing and counts against nothing.** The two devices
  talk to each other directly; Supabase only carries a few kilobytes of
  handshake. Sending a 4 GB export uses none of the 300 MB, none of the database
  and none of the bandwidth allowance.
- **Backups**: Settings → Download backup gives you one JSON file with
  everything. Worth doing occasionally; free Supabase keeps no backups of its own.
- **Expect the free AI models to move.** In the few days this was built, one
  Gemini model was retired outright and one OpenRouter model stopped being free.
  Neither needs a code change: both are Settings fields, and **Test AI** names
  the cause. This is the one part of the app that will need occasional attention.

---

# Never do these

- **`supabase db reset`** — erases the whole database, tracebug included.
- **Putting the `service_role` / secret key in Netlify, the browser, or `.env`
  on a machine you do not control.** It ignores all security rules.
- **Committing `.env`.** It is gitignored; keep it that way.
- **Pasting an API key into the app itself.** Keys only ever go into Supabase
  secrets, by command line.
- **Making the `vr-project-files` bucket public**, or raising its size limit.
  Public means a URL that works for anyone who has it, forever, with no policy in
  the way. The app never needs one: it asks for a short-lived signed URL each
  time it shows you a file.
- **Touching a storage policy that is not named `vr_...`.** `storage.objects` is
  one table shared with tracebug, and the others are tracebug's.
- **Uploading raw video.** It does not fit, and that is the point: a video goes
  from one device straight to the other without being stored anywhere.
- **Touching a policy on `realtime.messages` that is not named `vr_...`.** Same
  reason as storage: one shared table, and the others are tracebug's.
- **Adding a TURN server to make mobile data work.** A relay carries every byte
  of every video, which is both a bill and a thing standing between your two
  devices. The hotspot trick, or — when the two devices are not even in the
  same place — send it to yourself another way instead.

---

# If something goes wrong

| What you see | What it means |
|---|---|
| `ENOTFOUND` or a timeout from `npm run test:rls` | You used the Direct connection string. Switch to the pooled one (**Shared pooler**, port 5432). |
| `password authentication failed` | Wrong database password in `DATABASE_URL`. Reset it under Project Settings → Database. |
| `Access token not provided` from a supabase command | Run `npx supabase login` first (Step 3). That is the CLI signing in to your account, not the database password. |
| Sign-in link opens tracebug.dev instead of ViralRadar | Add `https://ytshortradar.netlify.app/**` to **Authentication → URL Configuration → Redirect URLs**. Leave Site URL alone. |
| `Legacy API keys are disabled` when signing in | `SUPABASE_ANON_KEY` is the old `eyJ...` key. Use the `sb_publishable_...` one in Netlify and in `.env`, then deploy again. |
| App loads but every screen is empty, no error | `viralradar` is probably missing from **Exposed schemas** (Step 4). |
| Logged in fine, but everything is empty and nothing saves | You are not on the allowlist (Step 6b). This is also exactly what a tracebug account sees. |
| `permission denied for schema viralradar` | Same as above, or the migrations have not been pushed. |
| Magic link email never arrives | Check spam, then **Authentication → URL Configuration** → Site URL and Redirect URLs must include your Netlify address. |
| Netlify build fails on a missing variable | `SUPABASE_URL` or `SUPABASE_ANON_KEY` is not set in **Site configuration → Environment variables**. |
| "Gemini daily limit reached" | Normal. It falls back to OpenRouter by itself. |
| Generating fails on **both** providers | **Settings -> Test AI.** It tries each one and shows the real reason. A free model being retired or quietly becoming paid is the likeliest cause, and the fix is a different name in the model field - no deploy needed. |
| `is unavailable for free` / `use this slug instead` | That OpenRouter model stopped being free. Pick another ending in `:free` from https://openrouter.ai/models and put it in Settings. Dropping the `:free` suffix as the message suggests would start charging you. |
| `is not found for API version` / `no longer available` from Gemini | That Gemini model was retired. Try `gemini-3.5-flash`, then Test AI. |
| `invalid input syntax for type date` on a generated item | Fixed, but if it ever comes back it means a model wrote something other than a date. Nothing is lost - nothing was saved. Tell me the exact text. |
| Watcher says 401 | The import token was revoked or mistyped. Make a new one in Settings. |
| `db push` fails on `create policy ... on storage.objects` | `storage.objects` is not yours to change from the CLI in every project. Everything before it was applied; do the bucket and its policies from the dashboard — Step 3 → "If `db push` fails on the storage part". |
| Uploading a file says "That upload was refused" | Either ViralRadar has used its 300 MB (**Settings → Project files** shows it) or the storage policies did not get applied. `npm run test:rls` tells you which. |
| An upload says the file is bigger than 25 MB and it clearly is not | The bucket's `file_size_limit` was not set. **Storage → vr-project-files → Configuration** → 25 MB. |
| A project file shows "this file is no longer stored" | The nightly cleanup removed it because its project was marked Posted more than fourteen days ago. Expected. Delete the item, or copy it back in. |
| ViralRadar is not in Android's Share menu | The installed app has not picked up the new service worker. Open it, reload, force-close and reopen. See Step 14b. On iPhone this is never available. |
| A shared screenshot never appears in the Inbox | Open the app directly — a share waits on the device until the app next opens with a connection, and that is when it is uploaded. |
| **Settings → Project files** says it cannot read how much is used | `storage_used()` was not created, or `viralradar` is missing from Exposed schemas. `npm run inspect:db` distinguishes the two. |
| **Clean up now** says the function is not deployed | `npx supabase functions deploy vr-purge-project-files --use-api` (Step 10). |
| **Research Pack** says the function is not deployed | `npx supabase functions deploy vr-research --use-api` (Step 10). |
| **Research Pack** fails with a message about `kind` or a constraint | The migration has not been applied. `npx supabase db push` (Step 14d). |
| A Research Pack comes back with nothing verified | The page loaded but the model could not match its claims to the text — often a site that renders everything in JavaScript, where there is no text to read server-side. The pack is honest about it rather than guessing. Paste a plainer page, such as the tool's pricing or docs page. |
| Every source says **✕ Not reachable** | The site refused the fetch, or took more than ten seconds. Open the URL yourself to check it is alive; some sites block anything that is not a real browser. Nothing is written when nothing loads, which is the intended behaviour. |
| **Your devices** says nothing else is online, but the other device is open | Both have to be signed in to the *same account* and have finished loading. If it persists, the `realtime.messages` policies did not get applied — see Step 3 → "If `db push` fails on a policy outside the viralradar schema". `npm run test:rls` says which. |
| "Could not open the channel your devices use to find each other" | The two `vr_devices_*` policies are missing, so Realtime refuses the private channel. Same fix as above. Nothing else in the app is affected. |
| A transfer gets stuck on "Connecting…" and then gives up after 15 seconds | The two devices are not on the same network. Mobile data essentially never works — it needs a relay server and there is no free one. Connect your laptop to your phone's hotspot, which puts them on one network and spends none of its data on the transfer itself. If the two devices are genuinely not in the same place, no local-network trick helps — send the video to yourself as a **File** on Telegram (not as a video, which gets recompressed), or through the Google Drive app. |
| "The copy does not match the original" | Some bytes arrived wrong and the file was thrown away, which is correct. Try again. If it happens twice on the same file, tell me — that is worth looking at. |
| A big transfer to a phone dies near the end | The phone has to hold the whole file in memory before it can save it; ViralRadar warns about this before starting. Send to a laptop instead. |
| The incoming video card never appears on the other device | It is already busy with another transfer (one at a time, by design) — or that device's app is on an old service worker. Reload it. |
| Where did my video go? | Nowhere near Supabase — that is the point. On a laptop, where you chose to save it; on Android, Downloads. The folder keeps only a 📹 note about it. |

When in doubt, paste the exact message to me — I would rather see the real error
than guess from a description.
