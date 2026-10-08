// A real "Export everything" file — the shape Shorts Studio (or a Claude
// chat) actually produces when it hands over everything at once: a script,
// its logged result, a research pack and a note, all in one bundle. Every
// other test exercises these kinds one at a time with hand-built fixtures;
// this one proves the real, mixed file imports correctly end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runImport } = require('../shared/import-core.mjs');

const USER_A = '11111111-1111-4111-8111-111111111111';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'export-everything.json'), 'utf8'));

/** The same two fakes import-core.test.js uses, combined into one store. */
function fakeStore(userId) {
  const flat = { ideas: [], scripts: [], results: [] };
  const projects = [];
  const items = [];
  let nextId = 1;
  const find = (table, id) => flat[table].findIndex((r) => r.user_id === userId && r.id === id);

  return {
    flat, projects, items,
    store: {
      userId,
      async findExisting(table, ids) {
        return flat[table].filter((r) => r.user_id === userId && ids.includes(r.id)).map((r) => r.id);
      },
      async upsert(table, rows) {
        for (const r of rows) {
          const i = find(table, r.id);
          if (i === -1) flat[table].push({ ...r });
          else flat[table][i] = { ...flat[table][i], ...r };
        }
      },
      async findProject(id) { return projects.find((p) => p.user_id === userId && p.id === id) ?? null; },
      async findProjectByTitle(title) {
        const low = title.toLowerCase();
        return projects.find((p) => p.user_id === userId && p.title.toLowerCase() === low) ?? null;
      },
      async findProjectByScriptId(scriptId) { return projects.find((p) => p.user_id === userId && p.script_id === scriptId) ?? null; },
      async createProject({ title, scriptId }) {
        const row = { user_id: userId, id: `proj-${nextId++}`, title, script_id: scriptId ?? null, is_inbox: false };
        projects.push(row);
        return row;
      },
      async inbox() {
        const found = projects.find((p) => p.user_id === userId && p.is_inbox);
        if (found) return found;
        const row = { user_id: userId, id: `proj-${nextId++}`, title: 'Inbox', script_id: null, is_inbox: true };
        projects.push(row);
        return row;
      },
      async findExistingItems(ids) {
        return items.filter((i) => i.user_id === userId && ids.includes(i.external_id)).map((i) => i.external_id);
      },
      async upsertItems(rows) {
        for (const r of rows) {
          const i = items.findIndex((x) => x.user_id === r.user_id && x.external_id === r.external_id);
          if (i === -1) items.push({ ...r });
          else items[i] = { ...items[i], ...r };
        }
      },
    },
  };
}

test('a real "Export everything" file imports every kind in it, filed correctly', async () => {
  const db = fakeStore(USER_A);
  const r = await runImport(FIXTURE, db.store);

  assert.equal(r.ok, true);
  assert.deepEqual(r.counts.script, { added: 1, updated: 0 });
  assert.deepEqual(r.counts.result, { added: 1, updated: 0 });
  assert.deepEqual(r.counts.research, { added: 1, updated: 0 });
  assert.deepEqual(r.counts.note, { added: 1, updated: 0 });
  assert.doesNotMatch(r.message, /Skipped/, 'a real export has no unknown kinds in it');

  // ---- the two flat-table rows ----
  const script = db.flat.scripts.find((s) => s.id === 'scr_pdf_001');
  assert.ok(script);
  assert.equal(script.yt_title, 'This free AI edits any PDF');
  assert.deepEqual(script.beats[1].say, 'Upload any PDF and it edits itself');

  const result = db.flat.results.find((s) => s.id === 'res_pdf_001');
  assert.ok(result);
  assert.equal(result.script_id, 'scr_pdf_001', 'the result links back to the script it came from');
  assert.equal(result.views, 12400);

  // ---- the research pack and the note, sharing one folder by title ----
  assert.equal(db.projects.length, 1, 'both named the same project.title, so one folder, not two');
  const folder = db.projects[0];
  assert.equal(folder.title, 'Background remover video');
  assert.equal(folder.is_inbox, false);

  const pack = db.items.find((i) => i.external_id === 'rp_bgless_001');
  assert.ok(pack);
  assert.equal(pack.project_id, folder.id);
  assert.equal(pack.kind, 'research');
  assert.equal(pack.from_device, 'Claude chat');

  const stored = JSON.parse(pack.content);
  assert.equal(stored.checked, false, 'nothing here has been fetched by this app yet');
  assert.equal(stored.main_tool.reachable, null);
  assert.equal(stored.main_tool.name, 'Bgless');
  assert.equal(stored.unchecked_count, 2, 'both claims are unchecked, whatever they were claimed as');
  assert.deepEqual(stored.sources, ['https://bgless.example']);

  const note = db.items.find((i) => i.external_id === 'note_watermark_001');
  assert.ok(note);
  assert.equal(note.project_id, folder.id, 'the note names the same folder as the pack');
  assert.equal(note.kind, 'text');
  assert.match(note.content, /Double check the watermark claim/);
  assert.match(note.content, /https:\/\/bgless\.example\/pricing/, 'the URL rides along on its own line');

  // ---- re-importing the same file must not duplicate anything ----
  const again = await runImport(FIXTURE, db.store);
  assert.equal(db.flat.scripts.length, 1);
  assert.equal(db.flat.results.length, 1);
  assert.equal(db.items.length, 2);
  assert.equal(db.projects.length, 1);
  assert.match(again.message, /1 updated/);
});
