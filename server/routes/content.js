// Ideas and Scripts: list, open, change status/stage, delete.
const express = require('express');

const STAGES = ['to_shoot', 'shot', 'edited', 'posted'];
const IDEA_STATUS = ['new', 'picked', 'skipped'];
const JSON_COLS = ['beats', 'hashtags', 'broll'];

function hydrate(row) {
  if (!row) return row;
  for (const c of JSON_COLS) {
    if (!(c in row)) continue;
    try { row[c] = JSON.parse(row[c] || '[]'); } catch { row[c] = []; }
  }
  if ('raw_json' in row) {
    try { row.raw = JSON.parse(row.raw_json); } catch { row.raw = null; }
    delete row.raw_json;
  }
  return row;
}

module.exports = (db) => {
  const r = express.Router();

  r.get('/ideas', (req, res) => {
    res.json(db.prepare('SELECT * FROM ideas ORDER BY date DESC, imported_at DESC').all().map(hydrate));
  });
  r.patch('/ideas/:id', (req, res) => {
    const { status } = req.body || {};
    if (!IDEA_STATUS.includes(status)) return res.status(400).json({ error: `status must be one of ${IDEA_STATUS.join(', ')}` });
    const info = db.prepare('UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Idea not found' });
    res.json(hydrate(db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id)));
  });

  r.get('/scripts', (req, res) => {
    res.json(db.prepare('SELECT id, created_at, topic, title, yt_title, thumbnail_text, stage, updated_at FROM scripts ORDER BY created_at DESC').all());
  });
  r.get('/scripts/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Script not found' });
    res.json(hydrate(row));
  });
  r.patch('/scripts/:id', (req, res) => {
    const { stage } = req.body || {};
    if (!STAGES.includes(stage)) return res.status(400).json({ error: `stage must be one of ${STAGES.join(', ')}` });
    const info = db.prepare('UPDATE scripts SET stage = ?, updated_at = ? WHERE id = ?').run(stage, new Date().toISOString(), req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Script not found' });
    res.json({ id: req.params.id, stage });
  });

  for (const table of ['ideas', 'scripts', 'results']) {
    r.delete(`/${table}/:id`, (req, res) => {
      const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
      res.status(info.changes ? 200 : 404).json({ deleted: info.changes });
    });
  }

  return r;
};
