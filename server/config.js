const path = require('path');
const os = require('os');
const { DEFAULT_KEYWORDS, SUBREDDITS } = require('../shared/defaults.mjs');
const { DEFAULT_TIMEZONE } = require('../shared/time.mjs');
const { DAILY_SEARCH_CAP, DAILY_UNIT_QUOTA } = require('../shared/sources/youtube.mjs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data', 'viralradar.db'),
  // WATCH_DIR from .env is the default; Settings can override it (stored in DB).
  WATCH_DIR: process.env.WATCH_DIR || path.join(os.homedir(), 'Downloads'),
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || '',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  RADAR_CRON: process.env.RADAR_CRON || '0 7 * * *',
  TIMEZONE: DEFAULT_TIMEZONE,
  YT_DAILY_SEARCH_CAP: DAILY_SEARCH_CAP,
  YT_DAILY_UNIT_QUOTA: DAILY_UNIT_QUOTA,
  DEFAULT_KEYWORDS,
  SUBREDDITS,
};
