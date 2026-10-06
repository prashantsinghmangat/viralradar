const fs = require('fs');
const express = require('express');
const config = require('../config');
const { getSetting, setSetting, exportAll, restoreAll } = require('../db');
const { getUsage } = require('../sources/youtube');

module.exports = (db, { watcher, lanUrls }) => {
  const r = express.Router();

  const current = () => ({
    watch_dir: getSetting(db, 'watch_dir', config.WATCH_DIR),
    watch_dir_default: config.WATCH_DIR,
    watch_active: watcher.active,
    keywords: getSetting(db, 'keywords', config.DEFAULT_KEYWORDS),
    youtube: {
      configured: !!config.YOUTUBE_API_KEY,
      ...getUsage(db),
      search_cap: config.YT_DAILY_SEARCH_CAP,
      unit_quota: config.YT_DAILY_UNIT_QUOTA,
    },
    github_token: !!config.GITHUB_TOKEN,
    radar_schedule: `${config.RADAR_CRON} (${config.TIMEZONE})`,
    radar_last_run: getSetting(db, 'radar_last_run', null),
    lan_urls: lanUrls,
  });

  r.get('/settings', (req, res) => res.json(current()));

  r.put('/settings', async (req, res) => {
    const { watch_dir, keywords } = req.body || {};
    if (keywords !== undefined) {
      const list = (Array.isArray(keywords) ? keywords : String(keywords).split(/[\n,]/))
        .map((k) => String(k).trim()).filter(Boolean);
      if (!list.length) return res.status(400).json({ error: 'Add at least one keyword.' });
      setSetting(db, 'keywords', [...new Set(list)].slice(0, 25));
    }
    if (watch_dir !== undefined) {
      const dir = String(watch_dir).trim() || config.WATCH_DIR;
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return res.status(400).json({ error: `Folder not found: ${dir}` });
      }
      setSetting(db, 'watch_dir', dir);
      await watcher.start(dir);
    }
    res.json(current());
  });

  r.get('/backup', (req, res) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.set('Content-Disposition', `attachment; filename="viralradar-backup-${stamp}.json"`);
    res.json(exportAll(db));
  });

  r.post('/restore', (req, res) => {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const counts = restoreAll(db, body);
      res.json({ ok: true, counts });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  return r;
};
