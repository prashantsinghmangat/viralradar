// SQLite storage adapter for the Shorts Studio import contract.
// All validation and row shaping lives in shared/contract.mjs, which the
// Supabase "import" Edge Function uses too — so both paths accept exactly the
// same files and produce exactly the same messages.
const { prepare, summarize, titleOf, TABLE, ImportError } = require('../shared/contract.mjs');

// Columns this SQLite schema actually has, per kind. The shared row carries a
// few extra fields (source, origin_at, script_id) that only Postgres stores.
const COLUMNS = {
  idea: ['id', 'date', 'title', 'hook', 'tool', 'show', 'why', 'format'],
  script: ['id', 'created_at', 'topic', 'title', 'beats', 'thumbnail_text', 'yt_title', 'ig_caption',
    'fb_caption', 'hashtags', 'pinned_comment', 'broll', 'audio'],
  result: ['id', 'logged_at', 'title', 'posted_on', 'platforms', 'format', 'hook', 'len', 'cta',
    'views', 'likes', 'comments', 'shares', 'saves', 'follows'],
};
// Arrays are stored as JSON text in SQLite.
const JSON_COLUMNS = new Set(['beats', 'hashtags', 'broll', 'platforms']);

function sqliteParams(kind, row) {
  const out = {};
  for (const c of COLUMNS[kind]) out[c] = JSON_COLUMNS.has(c) ? JSON.stringify(row[c] ?? []) : row[c];
  return out;
}

function statementFor(db, kind) {
  const cols = COLUMNS[kind];
  const table = TABLE[kind];
  const insertCols = [...cols, 'raw_json', 'imported_at', 'updated_at'];
  const values = [...cols.map((c) => `@${c}`), '@raw_json', '@now', '@now'];
  // "id" identifies the row; everything else is refreshed. imported_at and the
  // pipeline columns (status / stage) are deliberately left alone on update.
  const updates = [...cols.filter((c) => c !== 'id'), 'raw_json'].map((c) => `${c}=excluded.${c}`);
  return db.prepare(`
    INSERT INTO ${table} (${insertCols.join(', ')})
    VALUES (${values.join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}, updated_at=@now`);
}

function logImport(db, entry) {
  db.prepare('INSERT INTO imports_log (at, method, filename, ok, type, message) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), entry.method || 'api', entry.filename || null, entry.ok ? 1 : 0, entry.type || null, entry.message);
}

/**
 * Import a Shorts Studio export (string or parsed object) into SQLite.
 * Returns { ok, type, counts: {kind: {added, updated}}, titles, message }.
 * Throws ImportError (with a human-readable message) for bad input; nothing is written in that case.
 */
function importExport(db, input, { method = 'api', filename = null, log = true } = {}) {
  let type;
  try {
    const prepared = prepare(input);
    type = prepared.type;
    const stmts = {};
    const exists = {};
    for (const k of Object.keys(TABLE)) {
      stmts[k] = statementFor(db, k);
      exists[k] = db.prepare(`SELECT 1 FROM ${TABLE[k]} WHERE id = ?`);
    }

    const counts = {};
    const titles = [];
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const { kind, item, row } of prepared.entries) {
        const had = !!exists[kind].get(row.id);
        stmts[kind].run({ ...sqliteParams(kind, row), raw_json: JSON.stringify(item), now });
        counts[kind] = counts[kind] || { added: 0, updated: 0 };
        counts[kind][had ? 'updated' : 'added']++;
        titles.push(titleOf(row));
      }
    })();

    const message = summarize(counts, titles);
    if (log) logImport(db, { method, filename, ok: true, type, message });
    return { ok: true, type, counts, titles, message };
  } catch (err) {
    const message = err instanceof ImportError ? err.message : `Import failed: ${err.message}`;
    if (log) logImport(db, { method, filename, ok: false, type, message });
    const e = new ImportError(message);
    e.cause = err;
    throw e;
  }
}

module.exports = { importExport, ImportError, validate: require('../shared/contract.mjs').validate, parse: require('../shared/contract.mjs').parse };
