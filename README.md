# ViralRadar

Your ideas, scripts and results — on your laptop and your phone, anywhere.

ViralRadar keeps the work you export from **Shorts Studio**, finds trending
short-video and tech links every morning, and can write fresh ideas and scripts
for you. It is a personal app for one person, running entirely on free tiers.

**Open it: https://ytshortradar.netlify.app** — sign in, and it is also
installable on your phone's home screen like an app.

- **Install it on your phone:** open the site in Chrome → menu → *Add to Home
  screen*. On iPhone use Safari → Share → *Add to Home Screen*.
- **Your data is yours.** Every table is protected row by row, so even with the
  site's public key in hand nobody else can read a thing. API keys never leave
  the server.

---

## The screens

- **Radar** — today's trends, fastest-growing first, refreshed automatically at
  **7:00 AM IST**. *Copy for Shorts Studio* copies a title, link and one-line
  summary ready to paste.
- **Ideas** — your ideas by day. Mark each **Picked** or **Skip**. *Write ideas
  with AI* adds fresh ones for your niche.
- **Scripts** — a board running *To shoot → Shot → Edited → Posted*. Drag cards
  on the laptop, tap the arrow on the phone. Open one for the big-text
  **teleprompter**, one-tap copy for every caption and hashtag, and the **edit
  plan**: a shot-by-shot timeline with captions, music and a checklist.
- **Results** — totals, posting streak, your top 5, and what actually works
  broken down by format, hook, length and CTA.
- **Import** — paste or upload a Shorts Studio export.
- **Settings** — niche keywords, language, script length, which AI to use,
  today's quota, and **Test AI** to check both providers are answering.

Everything syncs. An import on the laptop appears on the phone a second or two
later, with no refresh.

---

## Getting your content in

Three ways, all of which **update** rather than duplicate — re-importing an item
keeps your pipeline column and your Picked/Skipped choices:

1. **Paste** — tap *📋 Paste from Shorts Studio*, on **Ideas**, **Scripts** or
   **Import**. It reads your clipboard, so copying in Shorts Studio and tapping
   once is the whole job. Works on the phone.
2. **Upload** — on **Import**, tap *Upload .json file…*.
3. **Automatically** — an optional watcher on the laptop that imports exports as
   they land in Downloads. Not built yet; the first two need nothing installed.

There are sample exports in [samples/](samples/) to try it with.

---

## Writing with AI

**Ideas**, **Scripts** and the **edit plan** can each be written for you, using
your niche keywords, language and target length from Settings.

It asks **Gemini** first and falls back to **OpenRouter** if Gemini is busy or
over its daily limit — so a 429 from one provider is not a dead end. Both are
free tiers. **Settings → Test AI** tells you which are answering, and how fast.

> Free models come and go: one of the defaults here was retired and another
> stopped being free during the few days this was built. Both are plain Settings
> fields for exactly that reason — if generating starts failing, Test AI will
> say so, and a different model name fixes it with no deploy.

---

## How it is built

No build step, no framework, no bundler: vanilla JavaScript talking to Supabase
directly.

```
Netlify  — the site, static files, installable as a PWA
Supabase — Postgres (your data), Auth (your login), and three Edge Functions
             vr-import          takes a Shorts Studio export
             vr-generate        holds the AI keys
             vr-refresh-trends  holds the YouTube and GitHub keys
           pg_cron runs the trend refresh at 01:30 UTC = 07:00 IST
```

The browser reads and writes your rows directly; **Row Level Security** is what
makes that safe. Anything that needs an API key, or a site that refuses a
request from a browser, happens in an Edge Function instead.

**More detail:** [PROJECT.md](PROJECT.md) — architecture, the data model, the
security model, decisions, mistakes worth knowing, and current status.

---

## Running it yourself

[SETUP.md](SETUP.md) is every manual step in order: database, login, API keys,
deploys and the phone. It assumes nothing and says why each step exists.

```
npm install
npm test            # 247 tests. No network, no database, no keys needed.
npm run build       # builds the site into dist/ (Netlify runs this)
```

Other commands:

| | |
|---|---|
| `npm run test:rls` | 193 assertions against the real database, proving nobody can read your rows |
| `npm run inspect:db` | what the live database actually looks like right now |
| `npm run sync:shared` | copies `shared/` out to the function and browser folders |
| `npm run icons` | regenerates the app icons |

`shared/` is the interesting part of the layout: the import contract, the trend
fetching, the AI calls and the prompts all live there as plain `.mjs` with no
imports of their own, so the **same file** runs in Node for the tests, in Deno
inside the Edge Functions, and in the browser. `npm run sync:shared` copies it,
and a test fails if a copy ever drifts.

---

## The local version

ViralRadar started as a local-only app — Express and SQLite, one laptop, phone
on the same Wi-Fi. It still works, unchanged, on the **`local-sqlite`** branch
(tag `v1-local`):

```
git switch local-sqlite
npm install
npm start
```

Its own README is on that branch. Nothing needs migrating between the two: the
cloud version was never fed from a local database, because there was never any
data in one.

---

## Notes

- Each trend source runs on its own with a 10-second timeout. If one fails the
  others still show, and the Radar names the one that failed.
- Reddit sometimes blocks its JSON feed; ViralRadar falls back to its RSS feed,
  which has no upvote counts, so those cards are ranked by position instead.
- Radar scores are per-hour speed **within** each source (views/hr, points/hr,
  stars/hr). Use the source filter to compare like with like.
- The YouTube key is capped at 25 searches a day — 2,500 of the free 10,000
  units — so the quota cannot run out by accident.
