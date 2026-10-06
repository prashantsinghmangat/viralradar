// Runs every trend source independently, dedupes by URL, stores today's trends.
const cron = require('node-cron');
const config = require('../config');
const { getSetting, setSetting } = require('../db');
const { broadcast } = require('../events');
const { fetchYouTube, istDay } = require('../sources/youtube');
const { fetchHackerNews } = require('../sources/hackernews');
const { fetchReddit } = require('../sources/reddit');
const { fetchGitHub } = require('../sources/github');

let running = null;

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const p of [...url.searchParams.keys()]) if (/^utm_|^ref$|^si$/.test(p)) url.searchParams.delete(p);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'; // also catches "page/\" which the parser turns into "page//"
    return url.toString().replace('://www.', '://').replace(/^http:/, 'https:');
  } catch {
    return u;
  }
}

async function runRadar(db, { reason = 'manual' } = {}) {
  if (running) return running; // a second click joins the run already in progress
  running = (async () => {
    const started = new Date();
    const keywords = getSetting(db, 'keywords', config.DEFAULT_KEYWORDS);
    const sources = {
      youtube: () => fetchYouTube(db, keywords),
      hackernews: () => fetchHackerNews(),
      reddit: () => fetchReddit(config.SUBREDDITS),
      github: () => fetchGitHub(),
    };
    const names = Object.keys(sources);
    const settled = await Promise.allSettled(names.map((n) => sources[n]()));

    const status = {};
    const byUrl = new Map();
    settled.forEach((r, i) => {
      const name = names[i];
      if (r.status === 'rejected') {
        status[name] = { ok: false, count: 0, error: r.reason && r.reason.message };
        return;
      }
      const { items, notes, skipped } = Array.isArray(r.value) ? { items: r.value, notes: [] } : r.value;
      status[name] = { ok: true, count: items.length, notes, ...(skipped && { skipped: true }) };
      for (const it of items) {
        if (!it.url || !it.title) continue;
        const key = normalizeUrl(it.url);
        const prev = byUrl.get(key);
        if (!prev || (it.score || 0) > (prev.score || 0)) byUrl.set(key, { ...it, url: key });
      }
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
      for (const it of byUrl.values()) {
        upsert.run({
          url: it.url, source: it.source, title: it.title, summary: it.summary || null, thumbnail: it.thumbnail || null,
          views: it.views ?? null, score: it.score ?? 0, published_at: it.published_at || null,
          keyword: it.keyword || null, fetched_at: now, run_date: day,
        });
      }
      // Keep the table small: drop trends older than 14 days.
      db.prepare("DELETE FROM trends WHERE run_date < date(?, '-14 days')").run(day);
    })();

    const summary = { at: now, reason, day, total: byUrl.size, sources: status };
    setSetting(db, 'radar_last_run', summary);
    const failed = names.filter((n) => !status[n].ok);
    console.log(`[radar] ${byUrl.size} trends (${reason})${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    broadcast('radar', { message: `Radar refreshed: ${byUrl.size} trends${failed.length ? ` (${failed.join(', ')} failed)` : ''}`, ok: true });
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
