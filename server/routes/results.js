// Results list + the analytics the Results screen draws.
const express = require('express');
const { resultStats, streaks } = require('../../shared/stats.mjs');

module.exports = (db, { today }) => {
  const r = express.Router();

  r.get('/results', (req, res) => {
    const rows = db.prepare('SELECT * FROM results ORDER BY posted_on DESC, logged_at DESC').all();
    for (const row of rows) {
      try { row.platforms = JSON.parse(row.platforms || '[]'); } catch { row.platforms = []; }
      delete row.raw_json;
    }
    res.json(rows);
  });

  r.get('/results/stats', (req, res) => {
    res.json(resultStats(db.prepare('SELECT * FROM results').all(), today()));
  });

  return r;
};

module.exports.streaks = streaks;
