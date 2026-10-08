// GENERATED FILE - DO NOT EDIT.
// Copied from shared/import-projects.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// Filing a "research" or "note" import into a project folder, rather than a
// flat table. Both kinds carry an optional `project` ({ id?, title? }), and
// the filing rule is the same for both, applied in order:
//
//   1. project.id,    if it names a folder this user owns
//   2. project.title, matched case-insensitively and trimmed; made if no
//      folder has it yet
//   3. a default, which depends on the kind:
//        research  a folder named after the topic (the same folder
//                  vr-research itself files a fresh pack into)
//        script    the folder already linked to that script, made if there
//                  is none yet (not reachable from this importer today —
//                  scripts are written straight to the scripts table — but
//                  kept here so the rule has one home when that changes)
//        anything else (note included)   the Inbox
//
// Storage is injected as a `store` port, the same pattern shared/import-core.mjs
// uses, so this runs unchanged against the real Supabase client and against a
// fake one in tests.
//
// A research pack's field names match vr-research's own output exactly — see
// shared/research.mjs — which is what lets an imported one be run through
// normalisePack({ checked: false }) below rather than stored as whatever the
// sender claimed. The sender's own `reachable` and `status` values are not
// this app's to trust; normalisePack() replaces them with "not checked yet"
// regardless of what arrived, the same enforcement a fresh fetch gets.
//
// `store` must provide:
//   userId
//   findProject(id)                 the project, or null if it is not this user's
//   findProjectByTitle(title)        case-insensitively, or null
//   findProjectByScriptId(scriptId)  or null
//   createProject({ title, scriptId })
//   inbox()
//   findExistingItems(externalIds)   the subset already imported, by external_id
//   upsertItems(rows)                insert or update, on conflict (user_id, external_id)

import { normalisePack } from './research.mjs';

const normalizeTitle = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Where one research or note item belongs. Never throws: every kind has a default. */
export async function resolveProject({ store, project, kind, topic, scriptId }) {
  const ref = project && typeof project === 'object' ? project : null;

  if (ref?.id) {
    const found = await store.findProject(String(ref.id));
    if (found) return found;
  }

  const title = normalizeTitle(ref?.title);
  if (title) {
    const found = await store.findProjectByTitle(title);
    if (found) return found;
    return store.createProject({ title });
  }

  if (kind === 'research') {
    const fallback = normalizeTitle(topic) || 'Research';
    const found = await store.findProjectByTitle(fallback);
    if (found) return found;
    return store.createProject({ title: fallback });
  }

  if (kind === 'script' && scriptId) {
    const found = await store.findProjectByScriptId(String(scriptId));
    if (found) return found;
    return store.createProject({ title: `Script ${scriptId}`, scriptId: String(scriptId) });
  }

  return store.inbox();
}

/**
 * A research row (shared/contract.mjs's ROW.research output) as a project_items row.
 *
 * Run through normalisePack() with no pages fetched, so every "reachable" and
 * "verified" the sender claimed is replaced with "not checked yet" rather than
 * taken on trust — exactly the enforcement a fresh vr-research fetch gets,
 * just with nothing yet fetched. "Re-check links" (vr-research's `recheck`
 * mode) later calls normalisePack() again, this time with real fetches, using
 * these same claims as the ones to confirm or downgrade.
 */
export function researchItemRow(row, projectId, userId) {
  const pack = normalisePack({ pack: row.pack, pages: [], topic: row.topic, checked: false });
  return {
    user_id: userId,
    project_id: projectId,
    external_id: row.id,
    kind: 'research',
    content: JSON.stringify(pack),
    storage_path: null,
    file_name: null,
    from_device: row.source === 'claude-chat' ? 'Claude chat' : 'Shorts Studio',
  };
}

/**
 * A note row as a project_items row.
 *
 * A note with no text at all but a URL is filed as a link; anything with text
 * is filed as text, with the URL appended on its own line when there is one —
 * the existing 'text' and 'link' kinds already draw both correctly, so a note
 * does not need a kind of its own in the database.
 */
export function noteItemRow(row, projectId, userId) {
  const text = String(row.text ?? '').trim();
  const url = String(row.url ?? '').trim();
  const isLink = !text && url;
  return {
    user_id: userId,
    project_id: projectId,
    external_id: row.id,
    kind: isLink ? 'link' : 'text',
    content: isLink ? url : [text, url].filter(Boolean).join('\n'),
    storage_path: null,
    file_name: null,
    from_device: row.source === 'claude-chat' ? 'Claude chat' : 'Shorts Studio',
  };
}

const BUILD = { research: researchItemRow, note: noteItemRow };

/**
 * Import every research/note entry, filing each into its own folder.
 *
 * Returns { counts: { research?, note? } }. Titles are built by the caller
 * (shared/import-core.mjs), which needs them interleaved with the flat-table
 * kinds in the file's own order.
 */
export async function runProjectImport(entries, store) {
  if (!entries.length) return { counts: {} };

  // An export can mention the same external id twice; the last one wins, the
  // same rule shared/import-core.mjs applies to the flat tables.
  const byKind = new Map();
  for (const entry of entries) {
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, new Map());
    byKind.get(entry.kind).set(entry.row.id, entry);
  }

  const counts = {};
  for (const [kind, unique] of byKind) {
    const list = [...unique.values()];
    const ids = list.map((e) => e.row.id);
    const existing = new Set(await store.findExistingItems(ids));

    const rows = [];
    for (const entry of list) {
      const project = await resolveProject({
        store, project: entry.row.project, kind, topic: entry.row.topic,
      });
      rows.push(BUILD[kind](entry.row, project.id, store.userId));
    }
    await store.upsertItems(rows);

    counts[kind] = { added: 0, updated: 0 };
    for (const id of ids) counts[kind][existing.has(id) ? 'updated' : 'added']++;
  }

  return { counts };
}
