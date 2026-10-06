const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  date TEXT, title TEXT, hook TEXT, tool TEXT, show TEXT, why TEXT, format TEXT,
  status TEXT NOT NULL DEFAULT 'new',          -- new | picked | skipped
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  created_at TEXT, topic TEXT, title TEXT,
  beats TEXT,                                  -- JSON array
  thumbnail_text TEXT, yt_title TEXT, ig_caption TEXT, fb_caption TEXT,
  hashtags TEXT,                               -- JSON array
  pinned_comment TEXT,
  broll TEXT,                                  -- JSON array
  audio TEXT,
  stage TEXT NOT NULL DEFAULT 'to_shoot',      -- to_shoot | shot | edited | posted
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  logged_at TEXT, title TEXT, posted_on TEXT,
  platforms TEXT,                              -- JSON array
  format TEXT, hook TEXT, len TEXT, cta TEXT,
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, follows INTEGER,
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trends (
  url TEXT PRIMARY KEY,
  source TEXT NOT NULL, title TEXT, summary TEXT, thumbnail TEXT,
  views INTEGER, score REAL, published_at TEXT, keyword TEXT,
  fetched_at TEXT NOT NULL, run_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trends_run_date ON trends(run_date);
CREATE TABLE IF NOT EXISTS imports_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, method TEXT NOT NULL, filename TEXT,
  ok INTEGER NOT NULL, type TEXT, message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quota_usage (
  day TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// Tables included in backup/restore, in restore order.
const BACKUP_TABLES = ['ideas', 'scripts', 'results', 'trends', 'imports_log', 'settings', 'quota_usage'];

function exportAll(db) {
  const tables = {};
  for (const t of BACKUP_TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return { app: 'viralradar', backup_version: 1, exported_at: new Date().toISOString(), tables };
}

function restoreAll(db, backup) {
  if (!backup || backup.app !== 'viralradar' || !backup.tables) {
    throw new Error('Not a ViralRadar backup file (expected "app": "viralradar").');
  }
  const tx = db.transaction(() => {
    for (const t of BACKUP_TABLES) {
      const rows = backup.tables[t];
      if (!Array.isArray(rows)) continue;
      db.prepare(`DELETE FROM ${t}`).run();
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const stmt = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of rows) stmt.run(cols.map((c) => (r[c] === undefined ? null : r[c])));
    }
  });
  tx();
  const counts = {};
  for (const t of BACKUP_TABLES) counts[t] = Array.isArray(backup.tables[t]) ? backup.tables[t].length : 0;
  return counts;
}

module.exports = { openDb, getSetting, setSetting, exportAll, restoreAll };
