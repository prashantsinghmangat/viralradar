// Local radar job: runs the shared sources, then stores today's trends in SQLite.
const cron = require('node-cron');
const config = require('../config');
const { getSetting, setSetting } = require('../db');
const { broadcast } = require('../events');
const { collect, normalizeUrl, failedSources } = require('../../shared/radar.mjs');
const { istDay } = require('../../shared/time.mjs');
const { fetchYouTube } = require('../sources/youtube');
const { fetchHackerNews } = require('../../shared/sources/hackernews.mjs');
const { fetchReddit } = require('../../shared/sources/reddit.mjs');
const { fetchGitHub } = require('../../shared/sources/github.mjs');

let running = null;

async function runRadar(db, { reason = 'manual' } = {}) {
  if (running) return running; // a second click joins the run already in progress
  running = (async () => {
    const started = new Date();
    const keywords = getSetting(db, 'keywords', config.DEFAULT_KEYWORDS);
    const { items, status, names, total } = await collect({
      youtube: () => fetchYouTube(db, keywords),
      hackernews: () => fetchHackerNews(),
      reddit: () => fetchReddit(config.SUBREDDITS),
      github: () => fetchGitHub({ token: config.GITHUB_TOKEN }),
    });

    const day = istDay(started);
    const now = started.toISOString();
    const upsert = db.prepare(`
      INSERT INTO trends (url, source, title, summary, thumbnail, views, score, published_at, keyword, fetched_at, run_date)
      VALUES (@url, @source, @title, @summary, @thumbnail, @views, @score, @published_at, @keyword, @fetched_at, @run_date)
      ON CONFLICT(url) DO UPDATE SET source=excluded.source, title=excluded.title, summary=excluded.summary,
        thumbnail=excluded.thumbnail, views=excluded.views, score=excluded.score, published_at=excluded.published_at,
        keyword=excluded.keyword, fetched_at=excluded.fetched_at, run_date=excluded.run_date`);
    db.transaction(() => {
      // A source that succeeded replaces its own rows for today; a failed source keeps what it had.
      const clear = db.prepare('DELETE FROM trends WHERE run_date = ? AND source = ?');
      for (const n of names) if (status[n].ok) clear.run(day, n);
      for (const it of items) {
        upsert.run({
          url: it.url, source: it.source, title: it.title, summary: it.summary || null, thumbnail: it.thumbnail || null,
          views: it.views ?? null, score: it.score ?? 0, published_at: it.published_at || null,
          keyword: it.keyword || null, fetched_at: now, run_date: day,
        });
      }
      // Keep the table small: drop trends older than 14 days.
      db.prepare("DELETE FROM trends WHERE run_date < date(?, '-14 days')").run(day);
    })();

    const summary = { at: now, reason, day, total, sources: status };
    setSetting(db, 'radar_last_run', summary);
    const failed = failedSources(status);
    console.log(`[radar] ${total} trends (${reason})${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    broadcast('radar', { message: `Radar refreshed: ${total} trends${failed.length ? ` (${failed.join(', ')} failed)` : ''}`, ok: true });
    return summary;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

function scheduleRadar(db) {
  return cron.schedule(config.RADAR_CRON, () => {
    runRadar(db, { reason: 'daily' }).catch((e) => console.warn(`[radar] ${e.message}`));
  }, { timezone: config.TIMEZONE });
}

module.exports = { runRadar, scheduleRadar, normalizeUrl, isRunning: () => !!running };
