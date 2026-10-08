// Tests for the project-folder half of public/data.js.
//
// Same approach as data.test.js: the Supabase client is faked so the real
// query-building code runs in Node, and the fake records what it was asked for.
// This one also fakes the Storage API, because the order in which files and
// rows are written is the whole point of several of these tests — bytes with no
// row pointing at them would sit in a shared quota forever, which is exactly
// what this feature is careful about.
//
// What this cannot check is whether the database agrees. `npm run test:rls` does
// that, against the real policies.
const test = require('node:test');
const assert = require('node:assert/strict');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';

/**
 * A stand-in for the Supabase client, with Storage and rpc().
 *
 * `storage.events` is the thing most of these tests are about: it records every
 * upload and removal in order, so "which happened first" is something a test
 * can state.
 */
function fakeClient({ respond = () => ({ data: [], error: null }), rpc = () => ({ data: 0, error: null }), storage = {} } = {}) {
  const calls = [];
  const channels = [];
  const events = [];

  const from = (table) => {
    const call = { table, op: 'select', columns: null, payload: null, onConflict: null, filters: [], order: [], limit: null };
    const self = {
      select(columns) { call.columns = columns ?? null; return self; },
      insert(payload) { call.op = 'insert'; call.payload = payload; return self; },
      update(payload) { call.op = 'update'; call.payload = payload; return self; },
      upsert(payload, options) { call.op = 'upsert'; call.payload = payload; call.onConflict = options?.onConflict ?? null; return self; },
      delete() { call.op = 'delete'; return self; },
      eq(column, value) { call.filters.push(['eq', column, value]); return self; },
      in(column, values) { call.filters.push(['in', column, values]); return self; },
      ilike(column, pattern) { call.filters.push(['ilike', column, pattern]); return self; },
      is(column, value) { call.filters.push(['is', column, value]); return self; },
      order(column, options) { call.order.push([column, options?.ascending === false ? 'desc' : 'asc']); return self; },
      limit(n) { call.limit = n; return self; },
      then(onOk, onErr) {
        calls.push(call);
        events.push({ kind: 'db', op: call.op, table });
        return Promise.resolve(respond(call)).then(onOk, onErr);
      },
    };
    return self;
  };

  const client = {
    calls,
    channels,
    events,
    from,
    rpc(name, args) {
      calls.push({ table: `rpc:${name}`, op: 'rpc', payload: args ?? null, filters: [], order: [] });
      return Promise.resolve(rpc(name, args));
    },
    storage: {
      from(bucket) {
        return {
          async upload(path, file, options) {
            events.push({ kind: 'upload', bucket, path, size: file?.size, options });
            return storage.upload ? storage.upload(path, file, options) : { data: { path }, error: null };
          },
          async remove(paths) {
            events.push({ kind: 'remove', bucket, paths });
            return storage.remove ? storage.remove(paths) : { data: [], error: null };
          },
          async createSignedUrl(path, seconds) {
            events.push({ kind: 'sign', bucket, path, seconds });
            return storage.createSignedUrl
              ? storage.createSignedUrl(path, seconds)
              : { data: { signedUrl: `https://example.supabase.co/sign/${path}?token=t` }, error: null };
          },
        };
      },
    },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    functions: {
      invoked: [],
      async invoke(name, options) {
        this.invoked.push({ name, body: options?.body });
        return { data: { ok: true, deleted: 2, message: 'Deleted 2 files and freed 3.0 KB.' }, error: null };
      },
    },
    channel(name) {
      const record = { name, listeners: [], subscribed: false };
      channels.push(record);
      const ch = {
        on(type, filter, cb) { record.listeners.push({ type, filter, cb }); return ch; },
        subscribe() { record.subscribed = true; return ch; },
      };
      return ch;
    },
    removeChannel() { channels.removed = true; },
  };
  return client;
}

const load = async () => (await import('../public/data.js'));
const limits = async () => (await import('../shared/projects.mjs'));

/** A stand-in for a browser File. Only what the data layer actually touches. */
const fakeFile = (name, size, type = 'image/png') => ({
  name,
  size,
  type,
  arrayBuffer: async () => new Uint8Array(Math.min(size, 16)).buffer,
});

// ---------- reading ----------

test('the folder list reads projects and items once each, not once per folder', async () => {
  const { createData } = await load();
  const client = fakeClient({
    respond: (call) => {
      if (call.table === 'projects') {
        return { data: [{ id: PROJECT, title: 'Demo', status: 'active' }, { id: 'p2', title: 'Other', status: 'posted' }], error: null };
      }
      return {
        data: [
          { id: 'i2', project_id: PROJECT, kind: 'image', file_name: 'b.png', size_bytes: 200, created_at: '2026-10-08T10:00:00Z' },
          { id: 'i1', project_id: PROJECT, kind: 'text', content: 'a note', size_bytes: null, created_at: '2026-10-07T10:00:00Z' },
        ],
        error: null,
      };
    },
  });
  const list = await createData(client).projects.list();

  // Two reads for any number of folders. One query per folder would be a
  // request per card, which on a phone is what makes a screen feel broken.
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map((c) => c.table).sort(), ['project_items', 'projects']);

  assert.equal(list[0].item_count, 2);
  assert.equal(list[0].bytes, 200, 'a note has no size, and must not count as zero bytes of something');
  assert.equal(list[0].latest.id, 'i2', 'the newest item is the one shown on the card');
  assert.equal(list[1].item_count, 0, 'an empty folder is empty, not broken');
  assert.equal(list[1].bytes, 0);
  assert.equal(list[1].latest, null);

  // Folders newest first, matching every other screen.
  const projects = client.calls.find((c) => c.table === 'projects');
  assert.deepEqual(projects.order, [['origin_at', 'desc']]);
});

test('the folder list never asks for the text of every note', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await createData(client).projects.list();
  const items = client.calls.find((c) => c.table === 'project_items');
  // A card shows a preview, not a note. A note can be 20,000 characters, so
  // reading every one of them to draw a list of folders is megabytes over a
  // phone connection — hence the generated "preview" column.
  assert.match(items.columns, /\bpreview\b/, 'the card should read the generated preview');
  assert.ok(!/\bcontent\b/.test(items.columns), `the card must not pull whole notes: ${items.columns}`);
  assert.ok(!/storage_path|sha256|mime/.test(items.columns), `the card asked for too much: ${items.columns}`);
  assert.match(items.columns, /created_at/);
  assert.deepEqual(items.order, [['created_at', 'desc']]);
});

test('a folder shows what is in it newest first', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await createData(client).projects.items(PROJECT);
  const call = client.calls[0];
  assert.equal(call.table, 'project_items');
  assert.deepEqual(call.filters, [['eq', 'project_id', PROJECT]]);
  assert.deepEqual(call.order, [['created_at', 'desc']]);
});

// ---------- the Inbox ----------

test('the Inbox is created on first use, because no trigger does it', async () => {
  const { createData } = await load();
  let created = false;
  const client = fakeClient({
    respond: (call) => {
      if (call.op === 'insert') { created = true; return { data: [{ id: 'inbox-1', is_inbox: true }], error: null }; }
      return { data: created ? [{ id: 'inbox-1', is_inbox: true }] : [], error: null };
    },
  });
  const inbox = await createData(client).projects.inbox();

  assert.equal(created, true);
  assert.equal(inbox.id, 'inbox-1');
  const insert = client.calls.find((c) => c.op === 'insert');
  assert.equal(insert.payload.is_inbox, true);
  assert.equal(insert.payload.title, 'Inbox');
  // user_id is never sent: the column defaults to auth.uid(), so the browser
  // cannot get it wrong and cannot name someone else.
  assert.ok(!('user_id' in insert.payload), 'the owner comes from the database default, not from the browser');
});

test('an Inbox that already exists is not created again', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: [{ id: 'inbox-1', is_inbox: true }], error: null }) });
  await createData(client).projects.inbox();
  assert.equal(client.calls.filter((c) => c.op !== 'select').length, 0, 'finding the Inbox must not write anything');
});

test('two devices asking for the Inbox at once end up with one folder', async () => {
  const { createData } = await load();
  // What the partial unique index does when the second device loses the race.
  let attempted = false;
  const client = fakeClient({
    respond: (call) => {
      if (call.op === 'insert') {
        attempted = true;
        return { data: null, error: { message: 'duplicate key value violates unique constraint "projects_one_inbox_idx"' } };
      }
      // Empty the first time, then the winner's row.
      return { data: attempted ? [{ id: 'inbox-winner', is_inbox: true }] : [], error: null };
    },
  });
  const inbox = await createData(client).projects.inbox();
  assert.equal(inbox.id, 'inbox-winner', 'the loser of the race must read the winner\'s folder, not fail');
});

test('a failure that is not a lost race is not swallowed', async () => {
  const { createData } = await load();
  const client = fakeClient({
    respond: (call) => (call.op === 'insert'
      ? { data: null, error: { message: 'permission denied for table projects' } }
      : { data: [], error: null }),
  });
  await assert.rejects(() => createData(client).projects.inbox(), /not allowed to use ViralRadar/);
});

// ---------- folders for a script ----------

test('a script gets one folder, reused every time it is opened', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: [{ id: 'p-existing', script_id: 's1' }], error: null }) });
  const project = await createData(client).projects.forScript({ id: 's1', title: 'A script' });

  assert.equal(project.id, 'p-existing');
  assert.equal(client.calls.length, 1, 'an existing folder must not be looked for twice');
  assert.deepEqual(client.calls[0].filters, [['eq', 'script_id', 's1']]);
  assert.ok(!client.calls.some((c) => c.op === 'insert'), 'opening an existing folder must not create another');
});

test('a script with no folder yet gets one named after it', async () => {
  const { createData } = await load();
  const client = fakeClient({
    respond: (call) => (call.op === 'insert'
      ? { data: [{ id: 'p-new', title: 'Remove a background', script_id: 's1' }], error: null }
      : { data: [], error: null }),
  });
  await createData(client).projects.forScript({ id: 's1', title: 'Remove a background' });
  const insert = client.calls.find((c) => c.op === 'insert');
  assert.equal(insert.payload.title, 'Remove a background');
  assert.equal(insert.payload.script_id, 's1');
});

test('a folder already made under the script\'s title is linked, not duplicated', async () => {
  // A research pack imported before the script existed files into a folder
  // named after its topic (shared/import-projects.mjs). If "Open project"
  // on the script then made a second folder with the same title, the pack
  // and the script would end up in two different places with the same name.
  const { createData } = await load();
  const client = fakeClient({
    respond: (call) => {
      if (call.op === 'update') return { data: [{ id: 'p-imported', title: 'Remove a background', script_id: 's1' }], error: null };
      // Nothing is linked to the script yet, but an unlinked folder with its
      // title already exists — the one the import made.
      const isTitleLookup = call.filters.some(([op]) => op === 'ilike');
      return isTitleLookup
        ? { data: [{ id: 'p-imported', title: 'remove a background', script_id: null }], error: null }
        : { data: [], error: null };
    },
  });

  const project = await createData(client).projects.forScript({ id: 's1', title: 'Remove a background' });

  assert.equal(project.id, 'p-imported');
  assert.ok(!client.calls.some((c) => c.op === 'insert'), 'the existing folder must be reused, not duplicated');
  const update = client.calls.find((c) => c.op === 'update');
  assert.ok(update, 'the folder must be linked to the script once found');
  assert.equal(update.payload.script_id, 's1');
  assert.deepEqual(update.filters, [['eq', 'id', 'p-imported']]);

  const titleLookup = client.calls.find((c) => c.filters.some(([op]) => op === 'ilike'));
  assert.deepEqual(titleLookup.filters, [['is', 'script_id', null], ['ilike', 'title', 'Remove a background']]);
});

test('an unknown status never reaches the database', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await assert.rejects(() => createData(client).projects.setStatus(PROJECT, 'deleted'), /Unknown status/);
  assert.equal(client.calls.length, 0);
});

test('a folder has to be called something', async () => {
  const { createData } = await load();
  const client = fakeClient();
  for (const title of ['', '   ', null, undefined]) {
    await assert.rejects(() => createData(client).projects.create({ title }), /name/i);
    await assert.rejects(() => createData(client).projects.rename(PROJECT, title), /name/i);
  }
  assert.equal(client.calls.length, 0, 'nothing should have been sent');
});

// ---------- notes and links ----------

test('text that is only a link is stored as a link, and a sentence is not', async () => {
  const { createData } = await load();
  for (const [text, kind] of [['https://example.com/x', 'link'], ['look at https://example.com/x', 'text']]) {
    const client = fakeClient({ respond: () => ({ data: [{ id: 'i1' }], error: null }) });
    await createData(client).items.addText(PROJECT, text, 'Laptop');
    const insert = client.calls.find((c) => c.op === 'insert');
    assert.equal(insert.payload.kind, kind, `"${text}" should be a ${kind}`);
    assert.equal(insert.payload.content, text);
    assert.equal(insert.payload.project_id, PROJECT);
    assert.equal(insert.payload.from_device, 'Laptop');
    assert.ok(!('user_id' in insert.payload), 'the owner comes from the database default');
  }
});

test('an empty note, and an enormous one, are both refused here', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await assert.rejects(() => createData(client).items.addText(PROJECT, '   '), /Type something/);
  await assert.rejects(() => createData(client).items.addText(PROJECT, 'x'.repeat(20001)), /too long/);
  assert.equal(client.calls.length, 0);
});

// ---------- uploading ----------

test('a file over 25 MB is refused before a byte is sent', async () => {
  const { createData } = await load();
  const { MAX_FILE_BYTES } = await limits();
  const client = fakeClient();
  await assert.rejects(
    () => createData(client).items.addFile(PROJECT, fakeFile('huge.mp4', MAX_FILE_BYTES + 1), { userId: USER, usedBytes: 0 }),
    /at most 25 MB/,
  );
  assert.equal(client.events.length, 0, 'nothing should have been uploaded or written');
});

test('an upload past the 300 MB cap is refused before a byte is sent', async () => {
  const { createData } = await load();
  const { TOTAL_BYTES_CAP } = await limits();
  const client = fakeClient();
  await assert.rejects(
    () => createData(client).items.addFile(PROJECT, fakeFile('a.png', 2 * 1024 * 1024), { userId: USER, usedBytes: TOTAL_BYTES_CAP - 1024 }),
    /only .* free/,
  );
  assert.equal(client.events.length, 0);
});

test('the cap is read from the bucket when it has not been worked out already', async () => {
  const { createData } = await load();
  const { TOTAL_BYTES_CAP } = await limits();
  // No usedBytes passed in, so the data layer has to ask — and must then
  // refuse, rather than uploading because it did not know.
  const client = fakeClient({ rpc: () => ({ data: TOTAL_BYTES_CAP, error: null }) });
  await assert.rejects(
    () => createData(client).items.addFile(PROJECT, fakeFile('a.png', 1024), { userId: USER }),
    /only 0 B free|ViralRadar is using/,
  );
  assert.ok(client.calls.some((c) => c.table === 'rpc:storage_used'), 'it should have asked how full the bucket is');
  assert.ok(!client.events.some((e) => e.kind === 'upload'));
});

test('an upload with no session is refused rather than guessed at', async () => {
  const { createData } = await load();
  const client = fakeClient();
  // Without a user id there is no prefix to upload into, and inventing one
  // would produce a path the storage policies refuse for reasons nobody could
  // read off the screen.
  await assert.rejects(
    () => createData(client).items.addFile(PROJECT, fakeFile('a.png', 10), { usedBytes: 0 }),
    /Sign in again/,
  );
  assert.equal(client.events.length, 0);
});

test('the bytes go up before the row, and the row records what was sent', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: [{ id: 'i1' }], error: null }) });
  await createData(client).items.addFile(PROJECT, fakeFile('Shot 1.png', 2048), {
    userId: USER, fromDevice: 'Phone', usedBytes: 0,
  });

  // A row written first would describe a file that might never arrive, and the
  // folder would show a download button for nothing.
  const kinds = client.events.map((e) => e.kind);
  assert.equal(kinds[0], 'upload', `the upload must come first, got ${kinds.join(' then ')}`);
  assert.ok(kinds.indexOf('upload') < kinds.indexOf('db'));

  const upload = client.events.find((e) => e.kind === 'upload');
  assert.equal(upload.bucket, 'vr-project-files');
  assert.equal(upload.path, `${USER}/${PROJECT}/${upload.path.split('/')[2]}`);
  assert.match(upload.path, new RegExp(`^${USER}/${PROJECT}/[a-z0-9]+-Shot 1\\.png$`));
  assert.equal(upload.options.upsert, false, 'upsert would silently replace a file someone still wants');

  const insert = client.calls.find((c) => c.op === 'insert');
  assert.equal(insert.payload.kind, 'image');
  assert.equal(insert.payload.storage_path, upload.path);
  assert.equal(insert.payload.file_name, 'Shot 1.png');
  assert.equal(insert.payload.size_bytes, 2048);
  assert.equal(insert.payload.from_device, 'Phone');
  assert.match(insert.payload.sha256, /^[0-9a-f]{64}$/, 'the digest is what Part 2 will compare against');
});

test('a file whose row cannot be written is taken back out of the bucket', async () => {
  const { createData } = await load();
  const client = fakeClient({
    respond: (call) => (call.op === 'insert'
      ? { data: null, error: { message: 'permission denied for table project_items' } }
      : { data: [], error: null }),
  });
  await assert.rejects(
    () => createData(client).items.addFile(PROJECT, fakeFile('a.png', 100), { userId: USER, usedBytes: 0 }),
    /not allowed to use ViralRadar/,
  );

  // Otherwise the bytes sit in a shared quota with nothing pointing at them,
  // which is the one outcome this whole feature is trying to avoid.
  const removed = client.events.find((e) => e.kind === 'remove');
  assert.ok(removed, 'the orphaned file must be removed');
  assert.deepEqual(removed.paths, [client.events.find((e) => e.kind === 'upload').path]);
});

test('an upload refused by the policies is explained, not passed through', async () => {
  const { createData } = await load();
  // What Storage says when the 300 MB insert policy refuses: nothing a person
  // could act on, and misleading — it reads as though the account were wrong.
  const client = fakeClient({ storage: { upload: () => ({ data: null, error: { message: 'new row violates row-level security policy' } }) } });
  await assert.rejects(
    () => createData(client).items.addFile(PROJECT, fakeFile('a.png', 100), { userId: USER, usedBytes: 0 }),
    (e) => /300 MB/.test(e.message) && /Settings/.test(e.message),
  );
});

test('an oversized upload refused by Storage itself says which limit it was', async () => {
  const { createData } = await load();
  const client = fakeClient({ storage: { upload: () => ({ data: null, error: { message: 'The object exceeded the maximum allowed size' } }) } });
  await assert.rejects(
    () => createData(client).items.addFile(PROJECT, fakeFile('a.png', 100), { userId: USER, usedBytes: 0 }),
    /25 MB/,
  );
});

// ---------- reading and deleting files ----------

test('a file is reached through a short-lived signed URL, never a public one', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const url = await createData(client).items.fileUrl(`${USER}/${PROJECT}/a.png`);
  const sign = client.events.find((e) => e.kind === 'sign');
  assert.equal(sign.bucket, 'vr-project-files');
  assert.ok(sign.seconds > 0 && sign.seconds <= 3600, 'a long-lived URL outlives the reason it was made');
  assert.match(url, /token=/);
});

test('deleting an item removes the file first, then the row', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const path = `${USER}/${PROJECT}/a.png`;
  await createData(client).items.remove({ id: 'i1', storage_path: path });

  const kinds = client.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['remove', 'db']);
  assert.deepEqual(client.events[0].paths, [path]);
  assert.equal(client.calls[0].op, 'delete');
  assert.deepEqual(client.calls[0].filters, [['eq', 'id', 'i1']]);
});

test('a file that has already gone is not a reason to keep its row', async () => {
  const { createData } = await load();
  // The nightly cleanup deletes files and may fail before the rows go. The row
  // then points at nothing, and deleting it must still work.
  const client = fakeClient({ storage: { remove: () => ({ data: null, error: { message: 'Object not found' } }) } });
  await createData(client).items.remove({ id: 'i1', storage_path: `${USER}/${PROJECT}/gone.png` });
  assert.ok(client.calls.some((c) => c.op === 'delete'), 'the row should still have been deleted');
});

test('a note is deleted without going anywhere near Storage', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await createData(client).items.remove({ id: 'i1', storage_path: null });
  assert.ok(!client.events.some((e) => e.kind === 'remove'));
});

test('deleting a folder removes its files before the folder itself', async () => {
  const { createData } = await load();
  const client = fakeClient({
    respond: (call) => (call.table === 'project_items' && call.op === 'select'
      ? { data: [{ id: 'i1', storage_path: 'u/p/a.png' }, { id: 'i2', storage_path: null }, { id: 'i3', storage_path: 'u/p/b.png' }], error: null }
      : { data: [], error: null }),
  });
  await createData(client).projects.remove(PROJECT);

  const removed = client.events.find((e) => e.kind === 'remove');
  assert.deepEqual(removed.paths, ['u/p/a.png', 'u/p/b.png'], 'notes have no file, and must not be asked for');
  // The rows cascade from the folder, so one delete is enough — but it has to
  // come after the files, or there is nothing left to tell us what to remove.
  const deletes = client.calls.filter((c) => c.op === 'delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].table, 'projects');
  assert.ok(client.events.indexOf(removed) < client.events.findIndex((e) => e.kind === 'db' && e.op === 'delete'));
});

// ---------- usage ----------

test('usage comes from the bucket, not from adding up our own rows', async () => {
  const { createData } = await load();
  const client = fakeClient({ rpc: (name) => ({ data: name === 'storage_used' ? 1048576 : null, error: null }) });
  const usage = await createData(client).storage.usage();

  // An upload that succeeded while its row insert failed still occupies the
  // shared quota. Summing project_items.size_bytes could not see those bytes,
  // and the cap would quietly stop being a cap.
  assert.ok(client.calls.some((c) => c.table === 'rpc:storage_used'));
  assert.ok(!client.calls.some((c) => c.table === 'project_items'), 'our own rows are not the authority on how many bytes exist');
  assert.equal(usage.used, 1048576);
  assert.match(usage.text, /of 300 MB used/);
});

test('a failure reading usage is a readable message, not a zero', async () => {
  const { createData } = await load();
  // Reporting an unreadable total as 0 would let an upload past the cap.
  const client = fakeClient({ rpc: () => ({ data: null, error: { message: 'permission denied for function storage_used' } }) });
  await assert.rejects(() => createData(client).storage.used(), /not allowed to use ViralRadar/);
});

test('the cleanup is asked for by name, and reports what it did', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const result = await createData(client).storage.purge();
  assert.deepEqual(client.functions.invoked, [{ name: 'vr-purge-project-files', body: {} }]);
  assert.match(result.message, /Deleted 2 files/);
});

// ---------- realtime ----------

test('project folders are watched on their own channel, in the right schema', async () => {
  const { createData, PROJECT_LIVE_TABLES, LIVE_TABLES } = await load();
  const client = fakeClient();
  const seen = [];
  const stop = createData(client).liveProjects((change) => seen.push(change));

  const channel = client.channels[0];
  assert.equal(channel.subscribed, true);
  assert.notEqual(channel.name, 'viralradar-changes', 'sharing a channel name would replace the other subscription');
  assert.deepEqual(channel.listeners.map((l) => l.filter.table), PROJECT_LIVE_TABLES);
  for (const l of channel.listeners) {
    assert.equal(l.filter.schema, 'viralradar', 'the wrong schema would silently deliver nothing');
    assert.equal(l.filter.event, '*');
  }
  // The two sets must not overlap, or one change would be reported twice.
  assert.deepEqual(PROJECT_LIVE_TABLES.filter((t) => LIVE_TABLES.includes(t)), []);

  channel.listeners[1].cb({ eventType: 'INSERT', new: { id: 'i1', kind: 'text', content: 'hello', from_device: 'Laptop' } });
  assert.deepEqual(seen, [{ table: 'project_items', event: 'INSERT', row: { id: 'i1', kind: 'text', content: 'hello', from_device: 'Laptop' } }]);

  stop();
  assert.equal(client.channels.removed, true);
});

// ---------- backup ----------

test('a backup carries notes and links but not files, and says so', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const backup = await createData(client).backup.download();

  assert.ok('projects' in backup.tables);
  assert.ok('project_items' in backup.tables);
  // A backup is one JSON file, so it cannot carry the bytes. A row describing
  // a file that is not in the backup would restore as a download button
  // pointing at nothing.
  const items = client.calls.find((c) => c.table === 'project_items');
  assert.deepEqual(items.filters, [['in', 'kind', ['text', 'link']]]);
  assert.ok(backup.excludes.some((x) => /file/i.test(x)), 'what is missing from a backup has to be stated');
});

test('a restore makes folders before the items that point at them', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await createData(client).backup.restore({
    app: 'viralradar',
    tables: {
      project_items: [{ user_id: OTHER, id: 'i1', project_id: PROJECT, kind: 'text', content: 'a note' }],
      projects: [{ user_id: OTHER, id: PROJECT, title: 'Theirs', is_inbox: true }],
    },
  }, USER);

  const order = client.calls.map((c) => c.table);
  assert.ok(order.indexOf('projects') < order.indexOf('project_items'),
    'an item\'s foreign key is the pair (user_id, project_id), so its folder has to exist first');
  for (const call of client.calls) {
    assert.equal(call.op, 'upsert', 'a restore must never delete');
    for (const row of call.payload) assert.equal(row.user_id, USER);
  }
  // Two Inboxes cannot exist, and the one already here is the one the share
  // menu is pointed at.
  const projects = client.calls.find((c) => c.table === 'projects');
  assert.equal(projects.payload[0].is_inbox, false);
});

test('a restore skips file rows, whose paths no longer match their owner', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const counts = await createData(client).backup.restore({
    app: 'viralradar',
    tables: {
      projects: [{ user_id: OTHER, id: PROJECT, title: 'Theirs' }],
      project_items: [
        { user_id: OTHER, id: 'i1', project_id: PROJECT, kind: 'text', content: 'a note' },
        // From an older backup, when files were included. Its path starts with
        // the user id it was uploaded under, which the database checks, so
        // re-owning it would write a row that cannot be true.
        { user_id: OTHER, id: 'i2', project_id: PROJECT, kind: 'image', storage_path: `${OTHER}/${PROJECT}/a.png`, file_name: 'a.png' },
      ],
    },
  }, USER);

  assert.equal(counts.project_items, 1);
  const items = client.calls.find((c) => c.table === 'project_items');
  assert.equal(items.payload.length, 1);
  assert.equal(items.payload[0].id, 'i1');
});
