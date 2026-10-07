// Collecting trends and turning them into rows.
//
// The sources themselves are shared/sources/*, already used by the local app
// and already tested. What this adds is the part that only the cloud version
// needs: counting YouTube quota against the usage table, shaping rows for
// Postgres, and deciding what a run should replace.
//
// Storage is injected, so the whole thing runs in Node against a fake store.

import { collect, failedSources } from './radar.mjs';
import { istDay } from './time.mjs';
import { fetchYouTube } from './sources/youtube.mjs';
import { fetchHackerNews } from './sources/hackernews.mjs';
import { fetchReddit } from './sources/reddit.mjs';
import { fetchGitHub } from './sources/github.mjs';
import { DEFAULT_KEYWORDS, SUBREDDITS, TREND_RETENTION_DAYS } from './defaults.mjs';

/** One collected item as a row of viralradar.trends. */
export function toRow(item, { userId, day, fetchedAt }) {
  const extra = {};
  if (item.keyword) extra.keyword = item.keyword;
  return {
    user_id: userId,
    url: item.url,
    title: item.title,
    source: item.source,
    summary: item.summary ?? null,
    thumbnail: item.thumbnail ?? null,
    views: item.views ?? null,
    views_per_hour: item.views_per_hour ?? null,
    published_at: item.published_at ?? null,
    score: item.score ?? 0,
    fetched_on: day,
    extra,
    updated_at: fetchedAt,
  };
}

/**
 * A quota counter backed by the usage table, in the shape the YouTube source
 * expects. YouTube charges for failed calls too, so this is written before the
 * call, not after.
 */
export function usagePort(store, provider = 'youtube') {
  return {
    get: () => store.getUsage(provider),
    add: (units, requests) => store.addUsage(provider, units, requests),
  };
}

/**
 * Run every source, dedupe, and store the result.
 *
 * `store` must provide:
 *   userId
 *   getUsage(provider)                   -> { units, requests }
 *   addUsage(provider, units, requests)
 *   replaceDay(day, sources, rows)       swap in this run's rows for the
 *                                        sources that succeeded
 *   prune(before)                        drop runs older than this date
 */
export async function runRefresh(store, {
  keywords = DEFAULT_KEYWORDS,
  subreddits = SUBREDDITS,
  youtubeKey = '',
  githubToken = '',
  now = new Date(),
  sources: override = null,
} = {}) {
  const day = istDay(now);
  const fetchedAt = now.toISOString();

  const sources = override || {
    youtube: () => fetchYouTube({ apiKey: youtubeKey, keywords, usage: usagePort(store) }),
    hackernews: () => fetchHackerNews(),
    reddit: () => fetchReddit(subreddits),
    github: () => fetchGitHub({ token: githubToken }),
  };

  const { items, status, names, total } = await collect(sources);

  // Only replace the rows of sources that actually answered. A source that
  // failed keeps whatever it found earlier, rather than having its section of
  // the radar wiped because Reddit happened to be rate limiting.
  const succeeded = names.filter((n) => status[n].ok);
  const rows = items.map((item) => toRow(item, { userId: store.userId, day, fetchedAt }));

  await store.replaceDay(day, succeeded, rows);

  // Keep the table small. Nobody looks at a two-week-old radar.
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - TREND_RETENTION_DAYS * 86400000)
    .toISOString().slice(0, 10);
  await store.prune(cutoff);

  return {
    at: fetchedAt,
    day,
    total,
    stored: rows.length,
    sources: status,
    failed: failedSources(status),
  };
}
