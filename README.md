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
- **Projects** — a folder per video, and the quickest way to get something from
  your phone to your laptop or back. Drop in the reference screenshots, the link
  to the tool, the thumbnail draft, and the line you thought of on the bus.
  Whatever you add appears on your other device a second later, saying which
  device it came from. **Open project** on any script makes its folder. Videos
  go device to device from here, with the copy checked byte for byte.
- **Results** — totals, posting streak, your top 5, and what actually works
  broken down by format, hook, length and CTA.
- **Import** — paste or upload a Shorts Studio export.
- **Settings** — niche keywords, language, script length, which AI to use,
  today's quota, **Test AI** to check both providers are answering, what to call
  this device, and how much of your project-file space is used.

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

## Phone to laptop, and back

Open **Projects** and make a folder per video — or tap *📁 Open project* on a
script and get one named after it. Inside a folder there is a box to send a note
or a link, and a button to add files or images. Everything appears on your other
device a second or two later, with a toast saying *New from Laptop: …* so you
know where it came from. Give each device a name in **Settings**.

**From your phone's Share menu.** Once ViralRadar is installed on your home
screen, it appears in Android's Share sheet. Share a screenshot, a link or a
line of text into it from any app and it lands in your **Inbox** folder, ready
on the laptop. If your phone has no signal it waits and arrives the next time
you open the app.

**When the video is up**, mark the folder **Posted**. Its files are deleted
fourteen days later, automatically — the notes and links stay. That is what keeps
this inside the free tier.

**The limits, and why.** ViralRadar shares its database with another app, and
the free tier gives the pair of them about 1 GB of file space. So ViralRadar
takes a fixed slice: **25 MB per file**, **300 MB in total**. Settings shows how
full it is, and an upload past either limit is refused with a message saying
which limit and by how much.

**Raw video is never uploaded.** A single export is bigger than the whole slice.
Video goes straight from one device to the other instead — see below.

---

## Sending a video to your other device

Inside a project folder there is **Send a video**. Pick the export, pick which
of your devices to send it to, and the file goes **straight from one device to
the other** — it never touches a server, so its size does not matter and nothing
is re-encoded, resized or compressed.

Both devices need to be:

- signed in to the same account, with ViralRadar open
- **on the same network.** Mobile data almost never works — it needs a relay
  server in the middle and there is no free one. Same Wi-Fi is the usual answer;
  with no Wi-Fi to hand, **connect your laptop to your phone's hotspot** — then
  the two devices are on the same network by definition. If they cannot find
  each other within fifteen seconds ViralRadar says so, suggests both of those,
  and points at [LocalSend](https://localsend.org) as a last resort.

### "Identical to the original" is checked, not claimed

As the file goes past, both ends work out its real **SHA-256** and compare them.
If every byte matches you get **✓ Identical to original**; if a single byte is
wrong the file is thrown away and it says so. Nothing half-right is ever saved —
a video that is 99.9% right is a video that stops playing in the middle.

The digest is the file's actual SHA-256, so you can check it yourself:

```
Windows   certutil -hashfile video.mp4 SHA256
macOS     shasum -a 256 video.mp4
Linux     sha256sum video.mp4
```

### While it runs

A progress bar with the speed and the time left, and a **Stop** button that
works immediately. Stopping is clean: the part-written file is discarded and
nothing is recorded. It does not resume, though — starting again starts from the
beginning.

The panel stays put while you move between screens, so tapping **Radar** half
way through a twenty-minute transfer does not kill it.

### Where it lands

- **On a laptop** the video is written straight to the file you chose, a piece
  at a time, so a 4 GB file needs no more memory than a 4 KB one.
- **On Android** there is no such API, so the whole file has to be held in
  memory and then downloaded. ViralRadar warns before sending anything over 1 GB
  to a phone, because that is where it tends to fail.

Afterwards the folder holds a note — the name, the size, the digest and which
devices have it. **Not the video.** That is the whole point.

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
Supabase — Postgres (your data), Auth (your login), Storage (project files),
           and four Edge Functions
             vr-import               takes a Shorts Studio export
             vr-generate             holds the AI keys
             vr-refresh-trends       holds the YouTube and GitHub keys
             vr-purge-project-files  deletes files from projects posted 14 days ago
           pg_cron runs the trend refresh at 01:30 UTC = 07:00 IST
                   and the file cleanup at 02:00 UTC = 07:30 IST
```

The browser reads and writes your rows directly; **Row Level Security** is what
makes that safe. Anything that needs an API key, or a site that refuses a
request from a browser, happens in an Edge Function instead.

Project files sit in a private bucket where the same rules apply by path: a file
lives at `<your id>/<project id>/<name>`, and the policies refuse anything that
is not under your own id. There is no public URL — the app asks for a
short-lived signed one each time it shows you a file.

The service worker does one thing beyond making the app open fast: it answers
the POST that Android makes when you share something into ViralRadar. The site
is static and has no server, so without the worker there would be nothing to
receive it.

A video transfer involves no server at all. The two devices exchange a few
kilobytes of handshake over a private Realtime channel — one per account, and
the database policies tie it to your own user id — and then open a **WebRTC data
channel** and talk to each other directly. Google's public STUN servers help
them work out their own addresses; no video goes anywhere near them. There is
deliberately no TURN relay, which is why both devices have to be on the same
network.

**More detail:** [PROJECT.md](PROJECT.md) — architecture, the data model, the
security model, decisions, mistakes worth knowing, and current status.

---

## Running it yourself

[SETUP.md](SETUP.md) is every manual step in order: database, login, API keys,
deploys and the phone. It assumes nothing and says why each step exists.

```
npm install
npm test            # 379 tests. No network, no database, no keys needed.
npm run build       # builds the site into dist/ (Netlify runs this)
```

Other commands:

| | |
|---|---|
| `npm run test:rls` | 309 assertions against the real database, proving nobody can read your rows |
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
