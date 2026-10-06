const express = require('express');
const config = require('../config');
const { getSetting } = require('../db');
const { runRadar, isRunning } = require('../jobs/radar');
const { getUsage } = require('../sources/youtube');

module.exports = (db) => {
  const r = express.Router();

  r.get('/radar', (req, res) => {
    const latest = db.prepare('SELECT MAX(run_date) AS d FROM trends').get().d;
    const params = [latest];
    let sql = 'SELECT * FROM trends WHERE run_date = ?';
    if (req.query.source) { sql += ' AND source = ?'; params.push(req.query.source); }
    sql += ' ORDER BY score DESC LIMIT 300';
    res.json({
      day: latest,
      running: isRunning(),
      last_run: getSetting(db, 'radar_last_run', null),
      youtube: { configured: !!config.YOUTUBE_API_KEY, ...getUsage(db), search_cap: config.YT_DAILY_SEARCH_CAP, unit_quota: config.YT_DAILY_UNIT_QUOTA },
      trends: latest ? db.prepare(sql).all(...params) : [],
    });
  });

  r.post('/radar/refresh', async (req, res) => {
    try {
      res.json(await runRadar(db, { reason: 'manual' }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
};
