# ViralRadar cloud setup — everything you do by hand

This is the full list of manual steps, in order. Each step says whether you can
do it **now** or whether it is **waiting on code I have not written yet**.

Nothing here is urgent. The local app keeps working the whole time on the
`local-sqlite` branch: `git switch local-sqlite` then `npm start`.

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

# PART 1 — Do these now

These unblock me. After step 2 the database is real and I can stop guessing.

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

**Paste the output back to me.** It tells us whether tracebug's tables are
managed by the Supabase CLI, which changes one thing in how we document
migrations. It also shows how much of the 500 MB free limit is used.

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

`db push` will ask you to confirm the two migrations. It creates a new schema
called `viralradar` and eight tables inside it: the seven the app uses, plus
`allowed_users`, which controls who may use ViralRadar at all. It does not touch
`public`, where tracebug lives.

Check it worked: **Table Editor** → the schema dropdown (top left, probably says
"public") → you should now be able to pick **viralradar** and see `ideas`,
`scripts`, `results`, `trends`, `settings`, `usage`, `import_tokens`.

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

This creates three throwaway users and tries 193 ways to get at data that is not
theirs, then deletes them. Two of the three are ViralRadar users; the third is
signed in but not on the allowlist, standing in for a tracebug account. It also
breaks four security rules on purpose inside a transaction, checks the test
notices, and rolls back so the rules come straight back.

What you want to see at the end:

```
assertions: 193 passed, 0 failed
proofs:     4 passed, 0 failed

PASS - a user can only reach their own rows, and the test can detect it when that breaks.
```

**If anything fails, paste it to me and put no real data in the project until it
passes.** There is also a browser version: paste `supabase/tests/rls.sql` into
**SQL Editor → New query → Run** and read the Messages panel.

## Step 6. Create your account

Your login. Do this now, because the daily schedule needs your user id.

1. **Authentication → Users → Add user → Create new user**
2. Enter your email. Tick **Auto Confirm User** so you do not have to click a
   confirmation link.
3. A password is fine to set but you will not use it — the app logs in with a
   magic link sent to your email.
4. Click your new user in the list and copy the **User UID** (a long
   `xxxxxxxx-xxxx-...` string).

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

# PART 2 — After I finish the Edge Functions

I will tell you when this part is ready. The commands are listed so you can see
what is coming; they will not work before the function files exist.

## Step 9. Give Supabase the API keys

You can do this now; it does not depend on the functions existing yet.

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

## Step 10. Deploy the three functions

```powershell
npx supabase functions deploy vr-import --use-api
npx supabase functions deploy vr-generate --use-api
npx supabase functions deploy vr-refresh-trends --use-api
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

---

# PART 3 — After I finish the web app

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

Both values come from **Project Settings → API Keys**. You want the
**publishable** key — on older projects it is labelled **anon / public**. It is
safe in a browser: Row Level Security is what protects your data, which is what
Step 5 proved.

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

If the link does not come: check spam, and check **Authentication → URL
Configuration** has your Netlify address in **Site URL** and in **Redirect
URLs**. I will put the exact values in the README.

Free Supabase sends a limited number of emails per hour, which is plenty for one
person.

## Step 14. Add it to your phone's home screen

Android, Chrome: open the site → menu (⋮) → **Add to Home screen** → **Install**.
It then opens like an app, without the browser bars.

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

## Step 16. Start the folder watcher (optional)

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

## Step 17. Move your existing data over

Only if you have data in the old local app. You currently have no
`data\viralradar.db` file, so there may be nothing to move.

```powershell
npm run migrate:to-cloud
```

It reads the old SQLite file and sends everything through the import function.
It is safe to run twice: imports match on id, so nothing duplicates.

---

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
- **Backups**: Settings → Download backup gives you one JSON file with
  everything. Worth doing occasionally; free Supabase keeps no backups of its own.

---

# Never do these

- **`supabase db reset`** — erases the whole database, tracebug included.
- **Putting the `service_role` / secret key in Netlify, the browser, or `.env`
  on a machine you do not control.** It ignores all security rules.
- **Committing `.env`.** It is gitignored; keep it that way.
- **Pasting an API key into the app itself.** Keys only ever go into Supabase
  secrets, by command line.

---

# If something goes wrong

| What you see | What it means |
|---|---|
| `ENOTFOUND` or a timeout from `npm run test:rls` | You used the Direct connection string. Switch to the pooled one (**Shared pooler**, port 5432). |
| `password authentication failed` | Wrong database password in `DATABASE_URL`. Reset it under Project Settings → Database. |
| `Access token not provided` from a supabase command | Run `npx supabase login` first (Step 3). That is the CLI signing in to your account, not the database password. |
| App loads but every screen is empty, no error | `viralradar` is probably missing from **Exposed schemas** (Step 4). |
| Logged in fine, but everything is empty and nothing saves | You are not on the allowlist (Step 6b). This is also exactly what a tracebug account sees. |
| `permission denied for schema viralradar` | Same as above, or the migrations have not been pushed. |
| Magic link email never arrives | Check spam, then **Authentication → URL Configuration** → Site URL and Redirect URLs must include your Netlify address. |
| Netlify build fails on a missing variable | `SUPABASE_URL` or `SUPABASE_ANON_KEY` is not set in **Site configuration → Environment variables**. |
| "Gemini daily limit reached" | Normal. It falls back to OpenRouter by itself. |
| Watcher says 401 | The import token was revoked or mistyped. Make a new one in Settings. |

When in doubt, paste the exact message to me — I would rather see the real error
than guess from a description.
