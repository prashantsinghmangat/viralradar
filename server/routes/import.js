const express = require('express');
const { importExport, ImportError } = require('../importer');
const { broadcast } = require('../events');

module.exports = (db) => {
  const r = express.Router();

  // Accepts application/json or text/plain (raw pasted text). ?method=paste|upload labels the log entry.
  r.post('/import', (req, res) => {
    const method = ['paste', 'upload', 'api'].includes(req.query.method) ? req.query.method : 'api';
    const body = typeof req.body === 'string' ? req.body : req.body && Object.keys(req.body).length ? req.body : '';
    try {
      const result = importExport(db, body, { method, filename: req.query.filename || null });
      broadcast('import', { ok: true, message: result.message, type: result.type });
      res.json(result);
    } catch (e) {
      res.status(e instanceof ImportError ? 400 : 500).json({ ok: false, error: e.message });
    }
  });

  r.get('/imports', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    res.json(db.prepare('SELECT * FROM imports_log ORDER BY id DESC LIMIT ?').all(limit));
  });

  return r;
};
