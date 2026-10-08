// GENERATED FILE - DO NOT EDIT.
// Copied from shared/contract.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// The Shorts Studio export contract: parsing, validation and row shaping.
// Runtime-agnostic on purpose — the local SQLite importer, the Supabase
// "import" Edge Function and the tests all share this one file, so error
// messages and import summaries are identical everywhere.
//
// Contract: { app: "shorts-studio", schema: 1, type: "script"|"ideas"|"results"|"bundle"|"research"|"note", exported_at, items: [...] }
//
// "research" and "note" items currently arrive inside a bundle; a standalone
// export of either type is accepted too, for whenever Shorts Studio or a
// Claude chat starts sending one on its own. Both go into a project folder
// rather than a flat table — see shared/import-projects.mjs — so they carry
// no TABLE entry here.

export const TYPES = ['script', 'ideas', 'results', 'bundle', 'research', 'note'];
export const KINDS = ['script', 'idea', 'result', 'research', 'note'];
// Where an item came from. Imports are "shorts-studio" or "claude-chat"; the
// generate function writes "gemini"/"openrouter"/"claude"; "manual" is for
// rows typed by hand.
export const SOURCES = ['claude', 'claude-chat', 'gemini', 'openrouter', 'shorts-studio', 'manual'];
export const TABLE = { idea: 'ideas', script: 'scripts', result: 'results' };

export class ImportError extends Error {}

const str = (v) => (v === undefined || v === null ? null : String(v));
const int = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
// Native array: adapters decide whether to JSON-stringify (SQLite) or pass through (Postgres).
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// An ISO timestamp, or null if the value is missing or unparseable.
// Accepts "2026-10-06" (becomes UTC midnight) as well as full timestamps.
export function ts(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Just the date part, or null.
 *
 * `date` and `posted_on` are real date columns, so anything that is not a date
 * makes Postgres reject the whole import. A tool exporting a date gets this
 * right; a language model writing one does not always — one returned
 * "2026-10-08 (today)", having copied the placeholder from the prompt, and the
 * import failed with "invalid input syntax for type date". A value that cannot
 * be a date is dropped rather than being allowed to sink everything with it.
 */
export function dateOnly(v) {
  if (v === undefined || v === null || v === '') return null;
  const text = String(v).trim();
  // Take a leading YYYY-MM-DD if there is one, so trailing noise is survivable.
  const leading = text.match(/^\d{4}-\d{2}-\d{2}\b/);
  const parsed = ts(leading ? leading[0] : text);
  if (!parsed) return null;
  const day = parsed.slice(0, 10);
  // JavaScript rolls an impossible date forward — new Date('2026-02-31') is
  // 3 March — where Postgres rejects it. Keeping the silent shift would put a
  // date nobody wrote into the row, so a value that did not survive the round
  // trip is dropped instead.
  if (leading && day !== leading[0]) return null;
  return day;
}

// origin_at: when the item came into being according to the export, so the UI
// can sort by it. Falls back to import time when the export carries no date.
const origin = (...candidates) => {
  for (const c of candidates) {
    const t = ts(c);
    if (t) return t;
  }
  return new Date().toISOString();
};

const source = (it) => (SOURCES.includes(it.source) ? it.source : 'shorts-studio');

export function parse(input) {
  if (typeof input !== 'string') return input;
  const text = input.replace(/^﻿/, '').trim();
  if (!text) throw new ImportError('Nothing to import: the text is empty.');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ImportError(`This is not valid JSON (${e.message}). Copy the whole export from Shorts Studio and try again.`);
  }
}

export function validate(data) {
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
  const kindFor = { script: 'script', ideas: 'idea', results: 'result', research: 'research', note: 'note' };
  const entries = [];
  const skipped = [];
  data.items.forEach((item, i) => {
    if (!item || typeof item !== 'object') throw new ImportError(`Item #${i + 1} is not an object.`);
    if (item.id === undefined || item.id === null || item.id === '') throw new ImportError(`Item #${i + 1} has no "id".`);
    let kind = kindFor[data.type];
    if (data.type === 'bundle') {
      kind = item.kind;
      if (!KINDS.includes(kind)) {
        // Forward compatibility: a kind this version does not understand yet
        // (a newer Shorts Studio sending something new) must not sink the
        // items around it in the same file. It is counted and reported
        // instead — see summarize() — and simply left out of entries.
        skipped.push(String(kind ?? '(none)'));
        return;
      }
    }
    entries.push({ kind, item });
  });
  return { entries, skipped };
}

// Neutral rows: contract field names, native arrays, ISO timestamps.
// Each storage adapter picks the columns its own table has.
export const ROW = {
  idea: (it) => ({
    id: str(it.id), date: dateOnly(it.date), title: str(it.title), hook: str(it.hook), tool: str(it.tool),
    show: str(it.show), why: str(it.why), format: str(it.format),
    source: source(it), origin_at: origin(it.date, it.created_at),
  }),
  script: (it) => ({
    id: str(it.id), created_at: str(it.created_at), topic: str(it.topic), title: str(it.title),
    beats: list(it.beats), thumbnail_text: str(it.thumbnail_text), yt_title: str(it.yt_title),
    ig_caption: str(it.ig_caption), fb_caption: str(it.fb_caption), hashtags: list(it.hashtags),
    pinned_comment: str(it.pinned_comment), broll: list(it.broll), audio: str(it.audio),
    source: source(it), origin_at: origin(it.created_at, it.date),
  }),
  result: (it) => ({
    id: str(it.id), logged_at: str(it.logged_at), title: str(it.title), posted_on: dateOnly(it.posted_on),
    platforms: list(it.platforms), format: str(it.format), hook: str(it.hook), len: str(it.len), cta: str(it.cta),
    views: int(it.views), likes: int(it.likes), comments: int(it.comments), shares: int(it.shares),
    saves: int(it.saves), follows: int(it.follows), script_id: str(it.script_id),
    source: source(it), origin_at: origin(it.logged_at, it.posted_on),
  }),
  // research and note do not go into a flat table — they go into a project
  // folder as a project_item, which shared/import-projects.mjs builds from
  // this neutral row. `project` is kept as given (id / title / neither) so
  // the filing rule can decide where each one lands.
  research: (it) => ({
    id: str(it.id), topic: str(it.topic), created_at: str(it.created_at),
    source: source(it), project: (it.project && typeof it.project === 'object') ? it.project : null,
    pack: (it.pack && typeof it.pack === 'object') ? it.pack : {},
  }),
  note: (it) => ({
    id: str(it.id), text: str(it.text), url: str(it.url), created_at: str(it.created_at),
    source: source(it), project: (it.project && typeof it.project === 'object') ? it.project : null,
  }),
};

// The title shown in the import summary ("Imported 1 script: <title>").
export const titleOf = (row) => row.title || row.yt_title || row.topic || row.text || row.id;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The noun a count is read against. Plain English rather than the wire kind:
// "1 research" reads as a typo, "1 research pack" does not.
const LABEL = { script: 'script', idea: 'idea', result: 'result', research: 'research pack', note: 'note' };

export function summarize(counts, titles, skipped = []) {
  const parts = [];
  for (const k of ['script', 'idea', 'result', 'research', 'note']) {
    if (!counts[k]) continue;
    const c = counts[k];
    const label = plural(c.added + c.updated, LABEL[k]);
    const extra = c.updated ? ` (${c.updated} updated)` : '';
    parts.push(label + extra);
  }
  let msg = parts.length ? `Imported ${parts.join(', ')}` : 'Imported nothing';
  if (parts.length && titles.length === 1 && titles[0]) msg += `: ${titles[0]}`;

  // Grouped by kind, so three unrelated unknown kinds in one file read as
  // three sentences rather than one unreadable count.
  const byKind = new Map();
  for (const kind of skipped) byKind.set(kind, (byKind.get(kind) || 0) + 1);
  for (const [kind, n] of byKind) {
    msg += `. Skipped ${n} ${n === 1 ? 'item' : 'items'} of unknown kind '${kind}'`;
  }
  return msg;
}

/**
 * Validate an export and shape every item, without touching any database.
 * Returns { type, entries: [{ kind, item, row }] }.
 * Throws ImportError with a human-readable message for bad input.
 */
export function prepare(input) {
  const data = parse(input);
  const { entries, skipped } = validate(data);
  return { type: data.type, entries: entries.map(({ kind, item }) => ({ kind, item, row: ROW[kind](item) })), skipped };
}
