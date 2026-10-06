// Local wiring for the shared YouTube source: config for the key, SQLite for the quota counters.
const { fetchYouTube: fetch_, SEARCH_COST } = require('../../shared/sources/youtube.mjs');
const { istDay } = require('../../shared/time.mjs');
const config = require('../config');

function getUsage(db, day = istDay()) {
  return db.prepare('SELECT units, searches FROM quota_usage WHERE day = ?').get(day) || { units: 0, searches: 0 };
}

function addUsage(db, units, searches) {
  db.prepare(`INSERT INTO quota_usage (day, units, searches) VALUES (?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET units = units + excluded.units, searches = searches + excluded.searches`)
    .run(istDay(), units, searches);
}

const fetchYouTube = (db, keywords, apiKey = config.YOUTUBE_API_KEY) => fetch_({
  apiKey,
  keywords,
  usage: { get: () => getUsage(db), add: (units, searches) => addUsage(db, units, searches) },
  searchCap: config.YT_DAILY_SEARCH_CAP,
  unitQuota: config.YT_DAILY_UNIT_QUOTA,
});

module.exports = { fetchYouTube, getUsage, istDay, SEARCH_COST };
