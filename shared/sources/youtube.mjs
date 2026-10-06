// YouTube Data API v3: search recent Shorts per keyword, then fetch stats.
// Quota is tracked through an injected `usage` port so the same code works
// against SQLite (local) and Postgres (Edge Function).
import { getJson } from '../http.mjs';
import { hoursSince } from '../time.mjs';

export const SEARCH_COST = 100;
export const VIDEOS_COST = 1;
export const DAILY_SEARCH_CAP = 25;
export const DAILY_UNIT_QUOTA = 10000;

/**
 * @param {object} o
 * @param {string} o.apiKey              YouTube Data API v3 key ('' to skip the source)
 * @param {string[]} o.keywords          niche keywords, one search each
 * @param {{get:Function, add:Function}} o.usage  today's quota counters (may be async)
 * @param {number} [o.searchCap]         max searches per day
 * @param {number} [o.unitQuota]         max units per day
 */
export async function fetchYouTube({ apiKey, keywords, usage, searchCap = DAILY_SEARCH_CAP, unitQuota = DAILY_UNIT_QUOTA }) {
  if (!apiKey) return { items: [], notes: ['No YouTube API key set'], skipped: true };
  const publishedAfter = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const out = [];
  const notes = [];

  for (const keyword of keywords) {
    const used = await usage.get();
    if (used.searches >= searchCap) {
      notes.push(`daily cap of ${searchCap} searches reached; skipped "${keyword}" and later keywords`);
      break;
    }
    if (used.units + SEARCH_COST + VIDEOS_COST > unitQuota) {
      notes.push('daily unit quota nearly used up');
      break;
    }

    const q = new URLSearchParams({
      part: 'snippet', q: keyword, type: 'video', videoDuration: 'short', order: 'viewCount',
      publishedAfter, regionCode: 'IN', maxResults: '10', key: apiKey,
    });
    await usage.add(SEARCH_COST, 1); // count it even if it fails: YouTube charges failed calls too
    const search = await getJson(`https://www.googleapis.com/youtube/v3/search?${q}`);
    const ids = (search.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
    if (!ids.length) continue;

    const v = new URLSearchParams({ part: 'statistics,snippet', id: ids.join(','), key: apiKey });
    await usage.add(VIDEOS_COST, 0);
    const videos = await getJson(`https://www.googleapis.com/youtube/v3/videos?${v}`);
    for (const vid of videos.items || []) {
      const views = Number(vid.statistics && vid.statistics.viewCount) || 0;
      const sn = vid.snippet || {};
      const thumbs = sn.thumbnails || {};
      const perHour = Math.round(views / hoursSince(sn.publishedAt));
      out.push({
        url: `https://www.youtube.com/shorts/${vid.id}`,
        source: 'youtube',
        title: sn.title,
        summary: `${sn.channelTitle || 'YouTube'} · "${keyword}"${sn.description ? ` · ${sn.description.split('\n')[0].slice(0, 120)}` : ''}`,
        thumbnail: (thumbs.high || thumbs.medium || thumbs.default || {}).url || null,
        views,
        views_per_hour: perHour,
        score: perHour,
        published_at: sn.publishedAt,
        keyword,
      });
    }
  }
  return { items: out, notes };
}
