// YouTube Data API v3: search recent Shorts per keyword, then fetch stats. Tracks quota units in SQLite.
const { getJson, hoursSince } = require('./http');
const config = require('../config');

const SEARCH_COST = 100;
const VIDEOS_COST = 1;

// Quota resets at midnight Pacific, but we track per IST day to keep things simple and predictable.
function istDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.TIMEZONE }).format(d);
}

function getUsage(db, day = istDay()) {
  return db.prepare('SELECT units, searches FROM quota_usage WHERE day = ?').get(day) || { units: 0, searches: 0 };
}

function addUsage(db, units, searches) {
  db.prepare(`INSERT INTO quota_usage (day, units, searches) VALUES (?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET units = units + excluded.units, searches = searches + excluded.searches`)
    .run(istDay(), units, searches);
}

async function fetchYouTube(db, keywords, apiKey = config.YOUTUBE_API_KEY) {
  if (!apiKey) return { items: [], notes: ['No YOUTUBE_API_KEY in .env'], skipped: true };
  const publishedAfter = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const out = [];
  const notes = [];

  for (const keyword of keywords) {
    const usage = getUsage(db);
    if (usage.searches >= config.YT_DAILY_SEARCH_CAP) {
      notes.push(`daily cap of ${config.YT_DAILY_SEARCH_CAP} searches reached; skipped "${keyword}" and later keywords`);
      break;
    }
    if (usage.units + SEARCH_COST + VIDEOS_COST > config.YT_DAILY_UNIT_QUOTA) {
      notes.push('daily unit quota nearly used up');
      break;
    }

    const q = new URLSearchParams({
      part: 'snippet', q: keyword, type: 'video', videoDuration: 'short', order: 'viewCount',
      publishedAfter, regionCode: 'IN', maxResults: '10', key: apiKey,
    });
    addUsage(db, SEARCH_COST, 1); // count it even if it fails: YouTube charges failed calls too
    const search = await getJson(`https://www.googleapis.com/youtube/v3/search?${q}`);
    const ids = (search.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
    if (!ids.length) continue;

    const v = new URLSearchParams({ part: 'statistics,snippet', id: ids.join(','), key: apiKey });
    addUsage(db, VIDEOS_COST, 0);
    const videos = await getJson(`https://www.googleapis.com/youtube/v3/videos?${v}`);
    for (const vid of videos.items || []) {
      const views = Number(vid.statistics && vid.statistics.viewCount) || 0;
      const sn = vid.snippet || {};
      const thumbs = sn.thumbnails || {};
      out.push({
        url: `https://www.youtube.com/shorts/${vid.id}`,
        source: 'youtube',
        title: sn.title,
        summary: `${sn.channelTitle || 'YouTube'} · "${keyword}"${sn.description ? ` · ${sn.description.split('\n')[0].slice(0, 120)}` : ''}`,
        thumbnail: (thumbs.high || thumbs.medium || thumbs.default || {}).url || null,
        views,
        score: Math.round(views / hoursSince(sn.publishedAt)),
        published_at: sn.publishedAt,
        keyword,
      });
    }
  }
  return { items: out, notes };
}

module.exports = { fetchYouTube, getUsage, istDay, SEARCH_COST };
