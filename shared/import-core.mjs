// Importing a Shorts Studio export into Postgres.
//
// All validation and row shaping is shared/contract.mjs, the same code the local
// SQLite importer uses, so both accept exactly the same files and produce exactly
// the same messages. What this file adds is the Postgres column mapping and the
// added/updated counting.
//
// Storage is injected as a `store` port rather than imported, so this runs
// unchanged against the real Supabase client in the Edge Function and against a
// fake one in the tests.

import { prepare, summarize, titleOf, TABLE } from './contract.mjs';
import { runProjectImport } from './import-projects.mjs';

// research and note do not have a flat table at all — see TABLE in
// shared/contract.mjs and shared/import-projects.mjs for where they do go.
const PROJECT_KINDS = new Set(['research', 'note']);

// The columns each table takes from an import.
//
// Deliberately absent:
//   status, stage   the pipeline columns. An import must never drag a script
//                   back from "posted" to "to_shoot", so they are left out of
//                   the upsert and keep whatever value the row already has.
//   created_at      the row's own timestamp, managed by the database. The
//                   export's created_at / logged_at live on in `raw`, and have
//                   already been folded into origin_at by the contract.
//   user_id, raw    added separately, for every kind.
export const COLUMNS = {
  idea: ['id', 'date', 'title', 'hook', 'tool', 'show', 'why', 'format', 'source', 'origin_at'],
  script: ['id', 'topic', 'title', 'beats', 'thumbnail_text', 'yt_title', 'ig_caption', 'fb_caption',
    'hashtags', 'pinned_comment', 'broll', 'audio', 'source', 'origin_at'],
  result: ['id', 'title', 'posted_on', 'platforms', 'format', 'hook', 'len', 'cta',
    'views', 'likes', 'comments', 'shares', 'saves', 'follows', 'script_id', 'source', 'origin_at'],
};

/** One neutral contract row plus its original item, as a Postgres row. */
export function toRow(kind, row, item, userId) {
  const out = { user_id: userId, raw: item };
  for (const c of COLUMNS[kind]) out[c] = row[c] ?? null;
  return out;
}

/**
 * Import a Shorts Studio export (string or parsed object).
 *
 * `store` must provide:
 *   userId                      whose rows these are
 *   findExisting(table, ids)    the subset of those ids this user already has
 *   upsert(table, rows)         insert or update, on conflict (user_id, id)
 *
 * For research and note items, which file into a project folder rather than a
 * flat table, `store` must also provide the project-items ports documented at
 * the top of shared/import-projects.mjs.
 *
 * Returns { ok, type, counts, titles, message }.
 * Throws ImportError, with a message meant to be read by a person, for bad input.
 * Nothing is written when it throws.
 */
export async function runImport(input, store) {
  const { type, entries, skipped } = prepare(input);

  const flatEntries = entries.filter((e) => !PROJECT_KINDS.has(e.kind));
  const projectEntries = entries.filter((e) => PROJECT_KINDS.has(e.kind));

  // An export can legitimately mention the same id twice. Postgres refuses to
  // update the same row twice in one statement, so the last one wins, which is
  // what a person would expect from a file read top to bottom.
  const byKind = new Map();
  for (const entry of flatEntries) {
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, new Map());
    byKind.get(entry.kind).set(entry.row.id, entry);
  }

  const counts = {};
  for (const [kind, unique] of byKind) {
    const table = TABLE[kind];
    const list = [...unique.values()];
    const ids = list.map((e) => e.row.id);

    // Which of these already exist decides added vs updated in the message.
    // Asked before the upsert, because afterwards they all exist.
    const existing = new Set(await store.findExisting(table, ids));

    await store.upsert(table, list.map((e) => toRow(kind, e.row, e.item, store.userId)));

    counts[kind] = { added: 0, updated: 0 };
    for (const id of ids) counts[kind][existing.has(id) ? 'updated' : 'added']++;
  }

  if (projectEntries.length) {
    Object.assign(counts, (await runProjectImport(projectEntries, store)).counts);
  }

  // Titles follow the order they appear in the file, so a one-item import names
  // the thing that was imported — flat and project kinds interleaved as given.
  const seen = new Set();
  const titles = [];
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(titleOf(entry.row));
  }

  return { ok: true, type, counts, titles, message: summarize(counts, titles, skipped) };
}
