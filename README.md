# ViralRadar

> **This README describes the local-only version** (branch `main`): Express +
> SQLite, one laptop, same Wi-Fi for the phone. It still works, unchanged.
>
> The cloud version lives on branch `cloud`. Start with:
> - **[PROJECT.md](PROJECT.md)** — what it is, how it is built, and where it has got to
> - **[SETUP.md](SETUP.md)** — every step you do by hand, in order

A small app that runs on your laptop. It keeps the ideas, scripts and results you export from **Shorts Studio**, and each morning it finds trending Shorts and tech posts for your niche. You can open it on your laptop and on your phone over the same Wi-Fi.

- No AI inside. Everything comes from Shorts Studio exports or free public APIs.
- Your data stays on your laptop in one file: `data/viralradar.db`.

---

## 1. Install Node.js (one time)

1. Go to https://nodejs.org and download the **LTS** version (20 or newer).
2. Run the installer. Click Next until it finishes.
3. Open a new terminal (Windows: press Start, type **PowerShell**, press Enter) and check it works:
   ```
   node -v
   ```
   You should see something like `v20.x` or higher.

## 2. Install ViralRadar (one time)

In the terminal, go to the ViralRadar folder and install:

```
cd D:\Project\viralradar
npm install
```

## 3. Get a free YouTube API key (optional but recommended)

Without a key, the Radar still works with Hacker News, Reddit and GitHub. With a key, you also get trending YouTube Shorts.

1. Open https://console.cloud.google.com and sign in with your Google account.
2. At the top, click the project dropdown → **New Project**. Name it `ViralRadar` → **Create**. Make sure it is selected.
3. In the search bar at the top, type **YouTube Data API v3**, open it, and click **Enable**.
4. In the left menu, go to **APIs & Services → Credentials**.
5. Click **+ Create credentials → API key**. Copy the key it shows.
6. (Recommended) Click **Edit API key** → under *API restrictions* choose **Restrict key** → tick **YouTube Data API v3** → **Save**.

It's free. You get 10,000 units per day. One keyword search costs 100 units, and ViralRadar stops at 25 searches a day (2,500 units), so you will not hit the limit.

## 4. Set up the `.env` file

In the ViralRadar folder there is a file called `.env` (if not, copy `.env.example` to `.env`). Open it in Notepad and fill in:

```
YOUTUBE_API_KEY=paste-your-key-here
WATCH_DIR=
PORT=3000
```

- **WATCH_DIR**: leave it empty to watch your Downloads folder. Or put a folder path, e.g. `WATCH_DIR=C:\Users\you\Downloads`.
- **PORT**: change it only if 3000 is already used.
- **GITHUB_TOKEN** (optional): a GitHub personal access token with no permissions. It only raises GitHub's rate limit.

Save the file. Restart the app after any change to `.env`.

## 5. Run it

```
npm start
```

The terminal shows:

```
  ViralRadar is running
  Laptop:  http://localhost:3000
  Network: http://192.168.x.x:3000
```

…and a QR code.

- **Laptop:** open http://localhost:3000
- **Phone:** connect the phone to the **same Wi-Fi**, then scan the QR code with the camera (or type the `Network` address).

Keep the terminal open while you use the app. Press `Ctrl + C` to stop it.

> **Phone can't connect?** The first time you run it, Windows may ask whether to allow Node.js on networks. Choose **Private networks → Allow**. If you missed it, search Start for "Allow an app through Windows Firewall" and tick Node.js for Private. Also make sure your Wi-Fi is set to *Private* network, not *Public*.

## 6. Getting your content in

There are three ways:

1. **Automatic (easiest):** export from Shorts Studio. When the file `viralradar-….json` lands in your Downloads folder, ViralRadar imports it within a couple of seconds and shows a pop-up in any open tab. The file then moves to `Downloads\viralradar-imported\`. If a file is broken, it goes to `Downloads\viralradar-failed\` with a `.error.txt` note beside it explaining why.
2. **Paste:** open **Import**, paste the export text, tap **Import**. This works on your phone too.
3. **Upload:** on **Import**, tap **Upload .json file…**.

Importing the same item again **updates** it and never creates duplicates. For results, the newest numbers replace the old ones. Your pipeline column (To shoot / Shot / …) and Picked/Skipped choices are kept.

Try it now with the sample files in the `samples/` folder.

## 7. The screens

- **Radar**: today's trends, fastest-growing first. Runs every day at **7:00 AM IST**, or tap **Refresh now**. **Copy for Shorts Studio** copies the title, link and a one-line summary, ready to paste into Shorts Studio's *Write script* box.
- **Ideas**: imported ideas grouped by day. Mark each as **Picked** or **Skip**.
- **Scripts**: a board with *To shoot → Shot → Edited → Posted*. Drag cards on the laptop, or tap the arrow on the phone. Open a script for the big-text **Teleprompter** (tap the text to start or stop scrolling) and one-tap **Copy** for every caption, title, hashtag and more.
- **Results**: totals, posting streak, top 5 videos, and charts of average views and save rate by format, hook, length and CTA.
- **Import**: paste box, upload, and a log of recent imports.
- **Settings**: watch folder, niche keywords, YouTube quota used today, phone address, and **backup / restore**.

## 8. Backup

**Settings → Download backup** saves everything as one JSON file. **Restore from file…** replaces all data with a backup. Do a backup now and then, or just copy the `data` folder.

## For automations

`POST http://<laptop>:3000/api/import` with the Shorts Studio export as the body (`application/json` or `text/plain`). You get back `{ ok, type, counts, message }`, or `400 { ok: false, error }` if something is wrong.

## Tests

```
npm test
```

## Notes

- Reddit sometimes blocks its JSON feed. ViralRadar then falls back to Reddit's RSS feed, which has no upvote counts, so Reddit cards are ranked by their position in that day's top list.
- Each source runs on its own with a 10-second timeout. If one fails, the rest still show, and the Radar tells you which one failed.
- Radar scores are "per hour" speed within each source (views/hr, points/hr, stars/hr). Use the source filter to compare like with like.
