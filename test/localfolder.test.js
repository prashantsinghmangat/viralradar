// Tests for shared/localfolder.mjs — naming, generated-file content, the
// never-touch-anything-else rule, the checklist, and the directory-handle
// driver functions, all run against a fake FileSystemDirectoryHandle since a
// real one cannot exist in Node.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../shared/localfolder.mjs');

// ---------- a fake FileSystemDirectoryHandle ----------
//
// Shaped exactly like the real API: getDirectoryHandle/getFileHandle take
// {create}, values() is an async iterator over child handles, a file handle
// has getFile() (-> {size, text()}) and createWritable() (-> {write, close,
// abort}), and removeEntry(name) removes a child. Nothing in
// shared/localfolder.mjs needs anything beyond this shape.

function fakeFile(name, content = '') {
  let text = content;
  return {
    kind: 'file',
    name,
    async getFile() {
      return { size: Buffer.byteLength(text, 'utf8'), text: async () => text };
    },
    async createWritable() {
      let buf = '';
      return {
        write: async (chunk) => { buf += chunk; },
        close: async () => { text = buf; },
        abort: async () => {},
      };
    },
  };
}

function fakeDir(name = '') {
  const children = new Map();
  return {
    kind: 'directory',
    name,
    children, // exposed so tests can seed/inspect without going through the API
    async getDirectoryHandle(child, { create = false } = {}) {
      const existing = children.get(child);
      if (existing) {
        if (existing.kind !== 'directory') throw new Error(`${child} is a file`);
        return existing;
      }
      if (!create) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      const made = fakeDir(child);
      children.set(child, made);
      return made;
    },
    async getFileHandle(child, { create = false } = {}) {
      const existing = children.get(child);
      if (existing) {
        if (existing.kind !== 'file') throw new Error(`${child} is a directory`);
        return existing;
      }
      if (!create) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      const made = fakeFile(child);
      children.set(child, made);
      return made;
    },
    async removeEntry(child) {
      if (!children.has(child)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      children.delete(child);
    },
    async *values() {
      for (const child of children.values()) yield child;
    },
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
  };
}

// ---------- naming ----------

test('sanitizeFolderName strips every character Windows forbids', async () => {
  const { sanitizeFolderName } = await load();
  assert.equal(sanitizeFolderName('Free 3D Photo Tool: Fake ya Real?'), 'Free 3D Photo Tool Fake ya Real');
  assert.equal(sanitizeFolderName('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(sanitizeFolderName('trailing dot.'), 'trailing dot');
  assert.equal(sanitizeFolderName('trailing dots...'), 'trailing dots');
  assert.equal(sanitizeFolderName('trailing space  '), 'trailing space');
  assert.equal(sanitizeFolderName(''), 'Untitled');
  assert.equal(sanitizeFolderName('   '), 'Untitled');
  assert.equal(sanitizeFolderName(null), 'Untitled');
});

test('sanitizeFolderName avoids reserved Windows device names', async () => {
  const { sanitizeFolderName } = await load();
  for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
    const safe = sanitizeFolderName(reserved);
    assert.notEqual(safe.toUpperCase(), reserved.toUpperCase());
  }
  // A reserved name is still reserved with an extension-looking suffix.
  assert.notEqual(sanitizeFolderName('CON.md').split('.')[0].toUpperCase(), 'CON');
  // An ordinary name that merely starts the same way is untouched.
  assert.equal(sanitizeFolderName('Connect the dots'), 'Connect the dots');
});

test('sanitizeFolderName caps length without crashing on a long title', async () => {
  const { sanitizeFolderName, MAX_NAME_LENGTH } = await load();
  const long = sanitizeFolderName('x'.repeat(400));
  assert.ok(long.length <= MAX_NAME_LENGTH);
});

test('projectFolderName is the date and the sanitised title, together', async () => {
  const { projectFolderName } = await load();
  assert.equal(
    projectFolderName({ title: 'Free 3D Photo Tool: Fake ya Real?', date: '2026-10-09' }),
    '2026-10-09 Free 3D Photo Tool Fake ya Real',
  );
  assert.equal(projectFolderName({ title: '', date: '2026-10-09' }), '2026-10-09 Untitled');
});

// ---------- content ----------

test('researchPackMarkdown tags every claim with how sure it is', async () => {
  const { researchPackMarkdown } = await load();
  const md = researchPackMarkdown({
    topic: 'a background remover',
    main_tool: { name: 'Bgless', url: 'https://bgless.example', what_it_does: 'removes backgrounds' },
    fact_check: [
      { claim: 'free tier gives 5 images a day', status: 'verified', source_url: 'https://bgless.example' },
      { claim: 'no watermark', status: 'unverified', source_url: 'https://bgless.example' },
      { claim: 'exports at 4K', status: 'unchecked', source_url: 'https://bgless.example' },
    ],
    sources: ['https://bgless.example'],
  });
  assert.match(md, /# Research: a background remover/);
  assert.match(md, /\[VERIFIED\] free tier gives 5 images a day/);
  assert.match(md, /\[UNVERIFIED\] no watermark/);
  assert.match(md, /\[NOT CHECKED\] exports at 4K/);
  assert.match(md, /## Sources/);
});

test('noteMarkdown renders a text note and a link note differently', async () => {
  const { noteMarkdown } = await load();
  const text = noteMarkdown({ kind: 'text', content: 'remember the watermark', created_at: '2026-10-08T09:00:00Z', from_device: 'Phone' });
  assert.match(text, /remember the watermark/);
  assert.match(text, /from Phone/);
  const link = noteMarkdown({ kind: 'link', content: 'https://example.com/tool', created_at: '2026-10-08T09:00:00Z' });
  assert.match(link, /<https:\/\/example\.com\/tool>/);
});

test('scriptMarkdown carries the beats, each with its timestamp', async () => {
  const { scriptMarkdown } = await load();
  const md = scriptMarkdown({
    title: 'Free background remover',
    topic: 'bgless',
    beats: [
      { t: '0-3s', say: 'Stop paying for this', screen: 'Face + logo' },
      { t: '3-10s', say: 'Here is how it works', screen: '' },
    ],
  });
  assert.match(md, /# Free background remover/);
  assert.match(md, /## 0-3s/);
  assert.match(md, /Stop paying for this/);
  assert.match(md, /🎥 Face \+ logo/);
  assert.match(md, /## 3-10s/);
});

test('captionsText gives every platform its own block, hashtags normalised', async () => {
  const { captionsText } = await load();
  const text = captionsText({
    thumbnail_text: 'FREE AI TOOL', yt_title: 'This free tool removes backgrounds',
    ig_caption: 'Save this', fb_caption: 'Try it', hashtags: ['ai', '#tools'], pinned_comment: 'Link in bio',
  });
  assert.match(text, /YouTube title:\nThis free tool removes backgrounds/);
  assert.match(text, /Hashtags:\n#ai #tools/);
  assert.match(text, /Pinned comment:\nLink in bio/);
});

test('editPlanFileText is empty with no plan, and readable with one', async () => {
  const { editPlanFileText } = await load();
  assert.equal(editPlanFileText({ title: 'x' }), '');
  const withPlan = editPlanFileText({
    raw: { edit_plan: { total_sec: 30, timeline: [{ at: '0-3s', action: 'hook' }], checklist: ['charge the battery'] } },
  });
  assert.match(withPlan, /EDIT PLAN/);
  assert.match(withPlan, /charge the battery/);
});

// ---------- which files should exist ----------

test('wantedFiles names one research pack file, or numbers them if there is more than one', async () => {
  const { wantedFiles } = await load();
  const one = wantedFiles({ items: [{ id: 'r1', kind: 'research', created_at: '2026-10-08', content: '{"topic":"a"}' }] });
  assert.deepEqual(one.map((f) => f.name), ['research-pack.md']);

  const two = wantedFiles({ items: [
    { id: 'r1', kind: 'research', created_at: '2026-10-01', content: '{"topic":"old"}' },
    { id: 'r2', kind: 'research', created_at: '2026-10-08', content: '{"topic":"new"}' },
  ] });
  const names = two.map((f) => f.name);
  assert.ok(names.includes('research-pack.md'), 'the most recent pack keeps the plain name');
  assert.ok(names.includes('research-pack-1.md'), 'an older one is numbered rather than overwritten');
});

test('wantedFiles makes one file per note, named after the item so edits overwrite it', async () => {
  const { wantedFiles, noteFileName } = await load();
  const item = { id: 'n1', kind: 'text', content: 'hello', created_at: '2026-10-08' };
  const files = wantedFiles({ items: [item] });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, noteFileName(item));
  assert.equal(files[0].subfolder, '01-research');
});

test('wantedFiles includes the script, its captions and its edit plan when a script is given', async () => {
  const { wantedFiles } = await load();
  const files = wantedFiles({
    items: [],
    script: { title: 'x', beats: [{ t: '0-3s', say: 'hi' }], raw: { edit_plan: { checklist: ['check mic'] } } },
  });
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.equal(byName['script.md'].subfolder, '02-script');
  assert.equal(byName['captions.txt'].subfolder, '02-script');
  assert.equal(byName['edit-plan.md'].subfolder, '04-edit');
});

test('wantedFiles writes no edit-plan.md when the script carries no plan', async () => {
  const { wantedFiles } = await load();
  const files = wantedFiles({ items: [], script: { title: 'x', beats: [] } });
  assert.ok(!files.some((f) => f.name === 'edit-plan.md'));
});

// ---------- the one rule that matters most: never touch what it did not make ----------

test('isGeneratedName recognises only the exact names this module writes', async () => {
  const { isGeneratedName } = await load();
  assert.ok(isGeneratedName('01-research', 'research-pack.md'));
  assert.ok(isGeneratedName('01-research', 'research-pack-1.md'));
  assert.ok(isGeneratedName('01-research', 'note-abc-123.md'));
  assert.ok(isGeneratedName('02-script', 'script.md'));
  assert.ok(isGeneratedName('02-script', 'captions.txt'));
  assert.ok(isGeneratedName('04-edit', 'edit-plan.md'));

  // A person's own files, including ones that merely look similar.
  for (const [sub, name] of [
    ['01-research', 'research-notes-from-meeting.docx'],
    ['01-research', 'notebook.md'],
    ['02-script', 'final-script-v2.md'],
    ['02-script', 'script.md.bak'],
    ['04-edit', 'edit-plan-old.md'],
    ['03-raw', 'script.md'],
    ['05-final', 'research-pack.md'],
    ['06-cover', 'captions.txt'],
  ]) {
    assert.ok(!isGeneratedName(sub, name), `${sub}/${name} must not be treated as generated`);
  }
  // 03-raw, 05-final and 06-cover never match anything at all, by design —
  // there is nothing this module ever generates in them.
  for (const sub of ['03-raw', '05-final', '06-cover']) {
    assert.ok(!isGeneratedName(sub, 'anything.txt'));
  }
});

test('diffGeneratedFiles deletes a stale generated file but keeps every file it did not make', async () => {
  const { diffGeneratedFiles } = await load();
  const { toWrite, toDelete } = diffGeneratedFiles({
    subfolder: '01-research',
    existingNames: ['research-pack.md', 'note-old.md', 'my-own-notes.docx', 'screenshot.png'],
    wanted: [{ subfolder: '01-research', name: 'research-pack.md', content: 'x' }],
  });
  assert.deepEqual(toWrite.map((f) => f.name), ['research-pack.md']);
  assert.deepEqual(toDelete, ['note-old.md'], 'only the stale generated file is removed');
  assert.ok(!toDelete.includes('my-own-notes.docx'));
  assert.ok(!toDelete.includes('screenshot.png'));
});

// ---------- the checklist ----------

test('projectChecklist reports the raw count and bytes, and offers the move only when it is true', async () => {
  const { projectChecklist } = await load();
  const scan = { research: true, script: true, editPlan: false, raw: { count: 3, bytes: 500 }, final: true, cover: false };

  assert.equal(projectChecklist(scan, { scriptStage: 'shot' }).offerMoveToEdited, true);
  assert.equal(projectChecklist(scan, { scriptStage: 'edited' }).offerMoveToEdited, false, 'already edited');
  assert.equal(projectChecklist(scan, { scriptStage: 'posted' }).offerMoveToEdited, false, 'already posted');
  assert.equal(projectChecklist({ ...scan, final: false }, { scriptStage: 'shot' }).offerMoveToEdited, false, 'no final video yet');

  const checklist = projectChecklist(scan);
  assert.equal(checklist.raw.count, 3);
  assert.equal(checklist.raw.bytes, 500);
  assert.equal(checklist.research, true);
  assert.equal(checklist.cover, false);
});

test('projectChecklist copes with an empty scan', async () => {
  const { projectChecklist } = await load();
  const checklist = projectChecklist();
  assert.equal(checklist.research, false);
  assert.deepEqual(checklist.raw, { count: 0, bytes: 0 });
  assert.equal(checklist.offerMoveToEdited, false);
});

// ---------- the 30-day raw cleanup offer ----------

test('rawCleanupDue is true only 30 days after posting, and only once posted', async () => {
  const { rawCleanupDue, LOCAL_RAW_RETENTION_DAYS } = await load();
  assert.equal(LOCAL_RAW_RETENTION_DAYS, 30);
  const postedAt = '2026-09-01T00:00:00Z';

  assert.equal(rawCleanupDue({ status: 'posted', posted_at: postedAt }, new Date('2026-09-29T00:00:00Z')), false);
  // Exactly 29 days — one day short of the 30-day retention. A threshold that
  // drifted to 29 would wrongly say yes here, which the pair above cannot
  // catch: both of those are still right on either side of a boundary at 29.
  assert.equal(rawCleanupDue({ status: 'posted', posted_at: postedAt }, new Date('2026-09-30T00:00:00Z')), false);
  assert.equal(rawCleanupDue({ status: 'posted', posted_at: postedAt }, new Date('2026-10-01T00:00:00Z')), true);
  assert.equal(rawCleanupDue({ status: 'active', posted_at: postedAt }, new Date('2026-10-01T00:00:00Z')), false, 'not posted');
  assert.equal(rawCleanupDue({ status: 'posted', posted_at: null }, new Date('2026-10-01T00:00:00Z')), false, 'no posted_at');
  assert.equal(rawCleanupDue(null, new Date()), false);
});

// ---------- the directory-handle driver functions ----------

test('ensureProjectFolder makes the project folder and all six subfolders', async () => {
  const { ensureProjectFolder, SUBFOLDERS } = await load();
  const root = fakeDir();
  const project = await ensureProjectFolder(root, '2026-10-09 A tool');
  assert.equal(root.children.get('2026-10-09 A tool'), project);
  for (const sub of SUBFOLDERS) assert.ok(project.children.has(sub), `${sub} was not created`);

  // Calling it again must not recreate anything or throw.
  const again = await ensureProjectFolder(root, '2026-10-09 A tool');
  assert.equal(again, project);
});

test('syncGeneratedFiles writes the wanted files and leaves an unrelated file alone', async () => {
  const { syncGeneratedFiles, ensureProjectFolder } = await load();
  const root = fakeDir();
  const project = await ensureProjectFolder(root, 'P');
  const research = project.children.get('01-research');
  research.children.set('my-own-notes.docx', fakeFile('my-own-notes.docx', 'do not touch me'));

  await syncGeneratedFiles(root, 'P', [
    { subfolder: '01-research', name: 'research-pack.md', content: '# hello' },
  ]);

  assert.ok(research.children.has('my-own-notes.docx'), 'a file the app did not make must survive a sync');
  assert.equal(await (await research.children.get('my-own-notes.docx').getFile()).text(), 'do not touch me');
  const written = research.children.get('research-pack.md');
  assert.ok(written);
  assert.equal(await (await written.getFile()).text(), '# hello');
});

test('syncGeneratedFiles removes a generated file that is no longer wanted', async () => {
  const { syncGeneratedFiles, ensureProjectFolder } = await load();
  const root = fakeDir();
  const project = await ensureProjectFolder(root, 'P');
  project.children.get('01-research').children.set('note-gone.md', fakeFile('note-gone.md', 'bye'));

  await syncGeneratedFiles(root, 'P', []); // the note was deleted, so nothing wants it any more

  assert.ok(!project.children.get('01-research').children.has('note-gone.md'));
});

test('syncGeneratedFiles rewrites a file whose content changed', async () => {
  const { syncGeneratedFiles, ensureProjectFolder } = await load();
  const root = fakeDir();
  await ensureProjectFolder(root, 'P');

  await syncGeneratedFiles(root, 'P', [{ subfolder: '02-script', name: 'script.md', content: 'v1' }]);
  await syncGeneratedFiles(root, 'P', [{ subfolder: '02-script', name: 'script.md', content: 'v2' }]);

  const file = root.children.get('P').children.get('02-script').children.get('script.md');
  assert.equal(await (await file.getFile()).text(), 'v2');
});

test('scanProject reads back the generated files, the raw count and bytes, and the final/cover flags', async () => {
  const { scanProject, syncGeneratedFiles, ensureProjectFolder } = await load();
  const root = fakeDir();
  const project = await ensureProjectFolder(root, 'P');

  await syncGeneratedFiles(root, 'P', [
    { subfolder: '01-research', name: 'research-pack.md', content: 'x' },
    { subfolder: '02-script', name: 'script.md', content: 'x' },
  ]);
  project.children.get('03-raw').children.set('clip1.mp4', fakeFile('clip1.mp4', 'a'.repeat(100)));
  project.children.get('03-raw').children.set('clip2.mp4', fakeFile('clip2.mp4', 'b'.repeat(50)));
  project.children.get('05-final').children.set('final.mp4', fakeFile('final.mp4', 'done'));

  const scan = await scanProject(root, 'P');
  assert.equal(scan.research, true);
  assert.equal(scan.script, true);
  assert.equal(scan.editPlan, false);
  assert.deepEqual(scan.raw, { count: 2, bytes: 150 });
  assert.equal(scan.final, true);
  assert.equal(scan.cover, false);
});

test('scanProject copes with a project folder that does not exist yet', async () => {
  const { scanProject } = await load();
  const root = fakeDir();
  const scan = await scanProject(root, 'never made');
  assert.deepEqual(scan.raw, { count: 0, bytes: 0 });
  assert.equal(scan.research, false);
});

test('rawSink writes straight into 03-raw, in the shape pickSink() returns', async () => {
  const { rawSink, ensureProjectFolder } = await load();
  const root = fakeDir();
  await ensureProjectFolder(root, 'P');

  const sink = rawSink(root, 'P', 'fallback.mp4');
  assert.equal(sink.kind, 'disk');
  await sink.open({ name: 'clip.mp4' });
  await sink.write('hello ');
  await sink.write('world');
  const name = await sink.close();
  assert.equal(name, 'clip.mp4');

  const file = root.children.get('P').children.get('03-raw').children.get('clip.mp4');
  assert.equal(await (await file.getFile()).text(), 'hello world');
});

test('rawSink falls back to the suggested name when no meta name arrives', async () => {
  const { rawSink, ensureProjectFolder } = await load();
  const root = fakeDir();
  await ensureProjectFolder(root, 'P');
  const sink = rawSink(root, 'P', 'fallback.mp4');
  await sink.open({});
  await sink.write('x');
  assert.equal(await sink.close(), 'fallback.mp4');
});

test('deleteRawFiles clears only 03-raw and reports what it freed, leaving 05-final untouched', async () => {
  const { deleteRawFiles, ensureProjectFolder } = await load();
  const root = fakeDir();
  const project = await ensureProjectFolder(root, 'P');
  project.children.get('03-raw').children.set('a.mp4', fakeFile('a.mp4', 'x'.repeat(10)));
  project.children.get('03-raw').children.set('b.mp4', fakeFile('b.mp4', 'y'.repeat(20)));
  project.children.get('05-final').children.set('final.mp4', fakeFile('final.mp4', 'keep me'));

  const result = await deleteRawFiles(root, 'P');
  assert.deepEqual(result, { count: 2, bytes: 30 });
  assert.equal(project.children.get('03-raw').children.size, 0);
  assert.ok(project.children.get('05-final').children.has('final.mp4'), '05-final must never be touched by this');
});

test('deleteRawFiles on a project with no raw folder yet does nothing and reports zero', async () => {
  const { deleteRawFiles } = await load();
  const root = fakeDir();
  assert.deepEqual(await deleteRawFiles(root, 'never made'), { count: 0, bytes: 0 });
});

// ---------- permission ----------

test('checkPermission and requestPermission ask the handle itself, read-write', async () => {
  const { checkPermission, requestPermission } = await load();
  const calls = [];
  const handle = {
    queryPermission: async (opts) => { calls.push(['query', opts]); return 'prompt'; },
    requestPermission: async (opts) => { calls.push(['request', opts]); return 'granted'; },
  };
  assert.equal(await checkPermission(handle), 'prompt');
  assert.equal(await requestPermission(handle), 'granted');
  assert.deepEqual(calls, [['query', { mode: 'readwrite' }], ['request', { mode: 'readwrite' }]]);
});
