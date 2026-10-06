// Validates Shorts Studio exports and upserts their items into SQLite.
// Contract: { app: "shorts-studio", schema: 1, type: "script"|"ideas"|"results"|"bundle", exported_at, items: [...] }

const TYPES = ['script', 'ideas', 'results', 'bundle'];

class ImportError extends Error {}

const str = (v) => (v === undefined || v === null ? null : String(v));
const int = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const arr = (v) => JSON.stringify(Array.isArray(v) ? v : v == null ? [] : [v]);

function parse(input) {
  if (typeof input !== 'string') return input;
  const text = input.replace(/^﻿/, '').trim();
  if (!text) throw new ImportError('Nothing to import: the text is empty.');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ImportError(`This is not valid JSON (${e.message}). Copy the whole export from Shorts Studio and try again.`);
  }
}

function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ImportError('Expected one JSON object exported from Shorts Studio.');
  }
  if (data.app !== 'shorts-studio') {
    throw new ImportError(`Wrong app: expected "app": "shorts-studio" but got ${JSON.stringify(data.app ?? null)}. Only Shorts Studio exports can be imported.`);
  }
  if (data.schema !== 1) {
    throw new ImportError(`Schema mismatch: this app understands schema 1 but the file has schema ${JSON.stringify(data.schema ?? null)}. Update ViralRadar or re-export from Shorts Studio.`);
  }
  if (!TYPES.includes(data.type)) {
    throw new ImportError(`Unknown export type ${JSON.stringify(data.type ?? null)}. Expected one of: ${TYPES.join(', ')}.`);
  }
  if (!Array.isArray(data.items)) throw new ImportError('The export has no "items" array.');
  if (data.items.length === 0) throw new ImportError('The export has no items in it.');

  // Resolve each item to a concrete kind; validate everything before writing anything.
  const kindFor = { script: 'script', ideas: 'idea', results: 'result' };
  return data.items.map((item, i) => {
    if (!item || typeof item !== 'object') throw new ImportError(`Item #${i + 1} is not an object.`);
    if (item.id === undefined || item.id === null || item.id === '') throw new ImportError(`Item #${i + 1} has no "id".`);
    let kind = kindFor[data.type];
    if (data.type === 'bundle') {
      kind = item.kind;
      if (!['script', 'result', 'idea'].includes(kind)) {
        throw new ImportError(`Bundle item #${i + 1} (id ${item.id}) has kind ${JSON.stringify(kind ?? null)}; expected "script" or "result".`);
      }
    }
    return { kind, item };
  });
}

function makeStatements(db) {
  return {
    idea: db.prepare(`
      INSERT INTO ideas (id, date, title, hook, tool, show, why, format, raw_json, imported_at, updated_at)
      VALUES (@id, @date, @title, @hook, @tool, @show, @why, @format, @raw_json, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        date=excluded.date, title=excluded.title, hook=excluded.hook, tool=excluded.tool, show=excluded.show,
        why=excluded.why, format=excluded.format, raw_json=excluded.raw_json, updated_at=excluded.updated_at`),
    script: db.prepare(`
      INSERT INTO scripts (id, created_at, topic, title, beats, thumbnail_text, yt_title, ig_caption, fb_caption,
        hashtags, pinned_comment, broll, audio, raw_json, imported_at, updated_at)
      VALUES (@id, @created_at, @topic, @title, @beats, @thumbnail_text, @yt_title, @ig_caption, @fb_caption,
        @hashtags, @pinned_comment, @broll, @audio, @raw_json, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        created_at=excluded.created_at, topic=excluded.topic, title=excluded.title, beats=excluded.beats,
        thumbnail_text=excluded.thumbnail_text, yt_title=excluded.yt_title, ig_caption=excluded.ig_caption,
        fb_caption=excluded.fb_caption, hashtags=excluded.hashtags, pinned_comment=excluded.pinned_comment,
        broll=excluded.broll, audio=excluded.audio, raw_json=excluded.raw_json, updated_at=excluded.updated_at`),
    result: db.prepare(`
      INSERT INTO results (id, logged_at, title, posted_on, platforms, format, hook, len, cta,
        views, likes, comments, shares, saves, follows, raw_json, imported_at, updated_at)
      VALUES (@id, @logged_at, @title, @posted_on, @platforms, @format, @hook, @len, @cta,
        @views, @likes, @comments, @shares, @saves, @follows, @raw_json, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        logged_at=excluded.logged_at, title=excluded.title, posted_on=excluded.posted_on, platforms=excluded.platforms,
        format=excluded.format, hook=excluded.hook, len=excluded.len, cta=excluded.cta,
        views=excluded.views, likes=excluded.likes, comments=excluded.comments, shares=excluded.shares,
        saves=excluded.saves, follows=excluded.follows, raw_json=excluded.raw_json, updated_at=excluded.updated_at`),
  };
}

const ROW = {
  idea: (it) => ({
    id: str(it.id), date: str(it.date), title: str(it.title), hook: str(it.hook), tool: str(it.tool),
    show: str(it.show), why: str(it.why), format: str(it.format),
  }),
  script: (it) => ({
    id: str(it.id), created_at: str(it.created_at), topic: str(it.topic), title: str(it.title),
    beats: arr(it.beats), thumbnail_text: str(it.thumbnail_text), yt_title: str(it.yt_title),
    ig_caption: str(it.ig_caption), fb_caption: str(it.fb_caption), hashtags: arr(it.hashtags),
    pinned_comment: str(it.pinned_comment), broll: arr(it.broll), audio: str(it.audio),
  }),
  result: (it) => ({
    id: str(it.id), logged_at: str(it.logged_at), title: str(it.title), posted_on: str(it.posted_on),
    platforms: arr(it.platforms), format: str(it.format), hook: str(it.hook), len: str(it.len), cta: str(it.cta),
    views: int(it.views), likes: int(it.likes), comments: int(it.comments), shares: int(it.shares),
    saves: int(it.saves), follows: int(it.follows),
  }),
};

const TABLE = { idea: 'ideas', script: 'scripts', result: 'results' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summarize(counts, titles) {
  const parts = [];
  for (const k of ['script', 'idea', 'result']) {
    if (!counts[k]) continue;
    const c = counts[k];
    const label = plural(c.added + c.updated, k);
    const extra = c.updated ? ` (${c.updated} updated)` : '';
    parts.push(label + extra);
  }
  let msg = `Imported ${parts.join(', ')}`;
  if (titles.length === 1 && titles[0]) msg += `: ${titles[0]}`;
  return msg;
}

function logImport(db, entry) {
  db.prepare('INSERT INTO imports_log (at, method, filename, ok, type, message) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), entry.method || 'api', entry.filename || null, entry.ok ? 1 : 0, entry.type || null, entry.message);
}

/**
 * Import a Shorts Studio export (string or parsed object).
 * Returns { ok, type, counts: {kind: {added, updated}}, titles, message }.
 * Throws ImportError (with a human-readable message) for bad input; nothing is written in that case.
 */
function importExport(db, input, { method = 'api', filename = null, log = true } = {}) {
  let data;
  try {
    data = parse(input);
    const entries = validate(data);
    const stmts = makeStatements(db);
    const exists = {};
    for (const k of Object.keys(TABLE)) exists[k] = db.prepare(`SELECT 1 FROM ${TABLE[k]} WHERE id = ?`);

    const counts = {};
    const titles = [];
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const { kind, item } of entries) {
        const row = ROW[kind](item);
        const had = !!exists[kind].get(row.id);
        stmts[kind].run({ ...row, raw_json: JSON.stringify(item), now });
        counts[kind] = counts[kind] || { added: 0, updated: 0 };
        counts[kind][had ? 'updated' : 'added']++;
        titles.push(row.title || row.yt_title || row.topic || row.id);
      }
    })();

    const message = summarize(counts, titles);
    if (log) logImport(db, { method, filename, ok: true, type: data.type, message });
    return { ok: true, type: data.type, counts, titles, message };
  } catch (err) {
    const message = err instanceof ImportError ? err.message : `Import failed: ${err.message}`;
    if (log) logImport(db, { method, filename, ok: false, type: data && data.type, message });
    const e = new ImportError(message);
    e.cause = err;
    throw e;
  }
}

module.exports = { importExport, ImportError, validate, parse };
