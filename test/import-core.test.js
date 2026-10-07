// Tests for shared/import-core.mjs — the Postgres half of the importer.
//
// Storage is a fake that behaves like the real tables do: rows are keyed by
// (user_id, id), a row with no owner is refused the way the NOT NULL column
// refuses it, and one user's rows are invisible to another. That means these
// tests can check the rules the Edge Function depends on without a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runImport, toRow, COLUMNS } = require('../shared/import-core.mjs');
const { ImportError } = require('../shared/contract.mjs');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const wrap = (type, items, extra = {}) => ({ app: 'shorts-studio', schema: 1, type, exported_at: '2026-10-06T08:00:00Z', items, ...extra });

const script = (id, title = 'Free AI site that edits PDFs') => ({
  id, created_at: '2026-10-05T10:00:00Z', topic: 'pdf tool', title,
  beats: [{ t: '0-3s', say: 'Stop paying for PDF editors', screen: 'Face + logo' }],
  thumbnail_text: 'FREE PDF AI', yt_title: 'This free AI edits any PDF', ig_caption: 'Save this', fb_caption: 'Try it',
  hashtags: ['#ai', '#tools'], pinned_comment: 'Link in bio', broll: ['screen recording'], audio: 'lofi',
});
const result = (id, views = 1000) => ({
  id, logged_at: '2026-10-06T09:00:00Z', title: 'PDF AI', posted_on: '2026-10-05', platforms: ['yt', 'ig'],
  format: 'listicle', hook: 'question', len: '30s', cta: 'save', views, likes: 50, comments: 5, shares: 3, saves: 20, follows: 2,
});

/** A stand-in for the three tables, with the same ownership rules. */
function fakeDb() {
  const rows = { ideas: [], scripts: [], results: [] };
  const find = (table, userId, id) => rows[table].findIndex((r) => r.user_id === userId && r.id === id);
  return {
    rows,
    all: (table) => rows[table],
    mine: (table, userId) => rows[table].filter((r) => r.user_id === userId),
    get: (table, userId, id) => rows[table][find(table, userId, id)],
    // Stands in for a column the import never sends, like stage or status.
    setColumn(table, userId, id, column, value) {
      rows[table][find(table, userId, id)][column] = value;
    },
    storeFor(userId) {
      const calls = [];
      return {
        userId,
        calls,
        async findExisting(table, ids) {
          // Scoped to this user, exactly as RLS scopes it.
          return rows[table].filter((r) => r.user_id === userId && ids.includes(r.id)).map((r) => r.id);
        },
        async upsert(table, incoming) {
          calls.push({ table, rows: incoming });
          for (const r of incoming) {
            // The real column is NOT NULL; an ownerless row must be impossible.
            if (!r.user_id) throw new Error(`null value in column "user_id" violates not-null constraint`);
            const i = find(table, r.user_id, r.id);
            if (i === -1) rows[table].push({ ...r });
            else rows[table][i] = { ...rows[table][i], ...r }; // merge, so untouched columns survive
          }
        },
      };
    },
  };
}

test('a script import writes one row, owned by the importer, with the item kept whole', async () => {
  const db = fakeDb();
  const item = { ...script('s1'), future_field: 'keep me' };
  const r = await runImport(wrap('script', [item]), db.storeFor(USER_A));

  assert.equal(r.ok, true);
  assert.equal(r.type, 'script');
  assert.equal(r.message, 'Imported 1 script: Free AI site that edits PDFs');

  const row = db.get('scripts', USER_A, 's1');
  assert.equal(row.user_id, USER_A);
  assert.equal(row.yt_title, 'This free AI edits any PDF');
  assert.deepEqual(row.hashtags, ['#ai', '#tools']);
  assert.deepEqual(row.beats[0].screen, 'Face + logo');
  assert.equal(row.origin_at, '2026-10-05T10:00:00.000Z');
  assert.equal(row.source, 'shorts-studio');
  assert.equal(row.raw.future_field, 'keep me', 'a field we do not know about must survive in raw');
});

test('every row carries a user_id, on every table', async () => {
  const db = fakeDb();
  await runImport(wrap('bundle', [
    { ...script('s1'), kind: 'script' }, { ...result('r1'), kind: 'result' },
    { id: 'i1', kind: 'idea', title: 'Idea' },
  ]), db.storeFor(USER_A));

  for (const table of ['ideas', 'scripts', 'results']) {
    assert.ok(db.all(table).length > 0, `${table} got no rows`);
    for (const row of db.all(table)) {
      assert.equal(row.user_id, USER_A, `${table}: row ${row.id} has the wrong owner`);
    }
  }
});

test('an import never sends the pipeline columns, so stage and status survive', async () => {
  const db = fakeDb();
  const store = db.storeFor(USER_A);
  await runImport(wrap('script', [script('s1', 'Old title')]), store);
  db.setColumn('scripts', USER_A, 's1', 'stage', 'posted');
  await runImport(wrap('ideas', [{ id: 'i1', title: 'Idea' }]), store);
  db.setColumn('ideas', USER_A, 'i1', 'status', 'picked');

  const again = await runImport(wrap('script', [script('s1', 'New title')]), store);
  assert.match(again.message, /1 updated/);
  await runImport(wrap('ideas', [{ id: 'i1', title: 'Idea renamed' }]), store);

  assert.equal(db.get('scripts', USER_A, 's1').title, 'New title');
  assert.equal(db.get('scripts', USER_A, 's1').stage, 'posted', 'a re-import must not drag a script back to "to shoot"');
  assert.equal(db.get('ideas', USER_A, 'i1').title, 'Idea renamed');
  assert.equal(db.get('ideas', USER_A, 'i1').status, 'picked');

  // Belt and braces: the columns are not even in the payload.
  for (const call of store.calls) {
    for (const row of call.rows) {
      assert.equal('stage' in row, false, 'stage must never be sent by an import');
      assert.equal('status' in row, false, 'status must never be sent by an import');
      assert.equal('created_at' in row, false, 'created_at belongs to the database');
      assert.equal('updated_at' in row, false, 'updated_at belongs to the trigger');
    }
  }
});

test('re-importing updates in place and never duplicates', async () => {
  const db = fakeDb();
  const store = db.storeFor(USER_A);
  await runImport(wrap('results', [result('r1', 1000)]), store);
  const second = await runImport(wrap('results', [result('r1', 5400)]), store);

  assert.equal(db.all('results').length, 1);
  assert.equal(db.get('results', USER_A, 'r1').views, 5400);
  assert.deepEqual(second.counts, { result: { added: 0, updated: 1 } });
  assert.equal(second.message, 'Imported 1 result (1 updated): PDF AI');
});

test('two users importing the same ids keep entirely separate rows', async () => {
  const db = fakeDb();
  await runImport(wrap('script', [script('s1', "A's script")]), db.storeFor(USER_A));
  const forB = await runImport(wrap('script', [script('s1', "B's script")]), db.storeFor(USER_B));

  // B's import is an addition, not an update: it must not see A's row.
  assert.deepEqual(forB.counts, { script: { added: 1, updated: 0 } });
  assert.equal(db.all('scripts').length, 2);
  assert.equal(db.get('scripts', USER_A, 's1').title, "A's script");
  assert.equal(db.get('scripts', USER_B, 's1').title, "B's script");
});

test('the same id twice in one file is one row, with the last one winning', async () => {
  const db = fakeDb();
  const r = await runImport(wrap('results', [result('r1', 100), result('r1', 999)]), db.storeFor(USER_A));
  // Postgres refuses to update the same row twice in one statement, so this
  // has to be collapsed before it is sent.
  assert.equal(db.all('results').length, 1);
  assert.equal(db.get('results', USER_A, 'r1').views, 999);
  assert.deepEqual(r.counts, { result: { added: 1, updated: 0 } });
});

test('a bundle writes to all three tables in one go', async () => {
  const db = fakeDb();
  const r = await runImport(wrap('bundle', [
    { ...script('s1'), kind: 'script' }, { ...result('r1'), kind: 'result' }, { ...result('r2'), kind: 'result' },
  ]), db.storeFor(USER_A));
  assert.deepEqual(r.counts, { script: { added: 1, updated: 0 }, result: { added: 2, updated: 0 } });
  assert.equal(r.message, 'Imported 1 script, 2 results');
  assert.equal(db.all('scripts').length, 1);
  assert.equal(db.all('results').length, 2);
});

test('bad input is refused and nothing at all is written', async () => {
  const db = fakeDb();
  const store = db.storeFor(USER_A);
  const bad = [
    [{ ...wrap('script', [script('s1')]), app: 'other-tool' }, /Wrong app/],
    [wrap('script', [script('s1')], { schema: 2 }), /Schema mismatch/],
    [wrap('video', [script('s1')]), /Unknown export type/],
    [wrap('script', [{ title: 'no id' }]), /has no "id"/],
    ['{ not json', /not valid JSON/],
    [wrap('bundle', [{ ...script('s1'), kind: 'script' }, { id: 'x', kind: 'video' }]), /kind "video"/],
  ];
  for (const [input, expected] of bad) {
    await assert.rejects(() => runImport(input, store), (e) => e instanceof ImportError && expected.test(e.message));
  }
  assert.equal(store.calls.length, 0, 'nothing should have reached the database');
  for (const table of ['ideas', 'scripts', 'results']) assert.equal(db.all(table).length, 0);
});

test('a store that refuses an ownerless row is not worked around', async () => {
  const db = fakeDb();
  const store = db.storeFor(undefined); // as if the caller failed to resolve a user
  await assert.rejects(() => runImport(wrap('script', [script('s1')]), store), /not-null constraint/);
  assert.equal(db.all('scripts').length, 0);
});

test('the column lists cover the contract and nothing more', () => {
  // Anything in COLUMNS has to be a real column, and the ones that must never
  // appear are the pipeline and timestamp columns the database owns.
  const forbidden = ['status', 'stage', 'created_at', 'updated_at', 'user_id', 'raw', 'logged_at'];
  for (const [kind, cols] of Object.entries(COLUMNS)) {
    assert.ok(cols.includes('id'), `${kind}: id is missing`);
    assert.ok(cols.includes('origin_at'), `${kind}: origin_at is missing`);
    assert.ok(cols.includes('source'), `${kind}: source is missing`);
    for (const f of forbidden) assert.ok(!cols.includes(f), `${kind}: must not import ${f}`);
    assert.equal(new Set(cols).size, cols.length, `${kind}: duplicate column`);
  }
  // toRow fills every listed column, so a missing field becomes null rather
  // than being left out, which would make the upsert keep a stale value.
  const row = toRow('result', { id: 'r1' }, { id: 'r1' }, USER_A);
  for (const c of COLUMNS.result) assert.ok(c in row, `toRow left out ${c}`);
  assert.equal(row.views, null);
  assert.equal(row.user_id, USER_A);
  assert.deepEqual(row.raw, { id: 'r1' });
});

// These exact strings came out of the local SQLite importer, captured before
// that code was moved off this branch. They are the contract: the same file
// imported through the cloud path must say the same words it always said, so
// nothing about the migration changes what a person reads on screen.
//
// The messages are built by shared/contract.mjs, which both importers used.
// If one of these changes, it changed for everyone.
const GOLDEN = {
  script: 'Imported 1 script: Free AI site that edits PDFs',
  ideas_one: 'Imported 1 idea: Idea',
  ideas_two: 'Imported 2 ideas',
  results: 'Imported 1 result: PDF AI',
  bundle: 'Imported 1 script, 2 results',
  script_again: 'Imported 1 script (1 updated): Free AI site that edits PDFs',
};

const GOLDEN_ERRORS = {
  wrong_app: 'Wrong app: expected "app": "shorts-studio" but got "other-tool". Only Shorts Studio exports can be imported.',
  schema: 'Schema mismatch: this app understands schema 1 but the file has schema 2. Update ViralRadar or re-export from Shorts Studio.',
  type: 'Unknown export type "video". Expected one of: script, ideas, results, bundle.',
  no_id: 'Item #1 has no "id".',
  empty: 'The export has no items in it.',
  kind: 'Bundle item #1 (id x) has kind "video"; expected "script" or "result".',
};

test('the words a person sees are the ones the local app always used', async () => {
  const cases = {
    script: wrap('script', [script('s1')]),
    ideas_one: wrap('ideas', [{ id: 'i1', title: 'Idea' }]),
    ideas_two: wrap('ideas', [{ id: 'i1', title: 'One' }, { id: 'i2', title: 'Two' }]),
    results: wrap('results', [{ ...result('r1'), title: 'PDF AI' }]),
    bundle: wrap('bundle', [{ ...script('s1'), kind: 'script' }, { ...result('r1'), kind: 'result' }, { ...result('r2'), kind: 'result' }]),
  };
  for (const [name, input] of Object.entries(cases)) {
    const { message } = await runImport(input, fakeDb().storeFor(USER_A));
    assert.equal(message, GOLDEN[name], `the ${name} message changed`);
  }

  // And the wording for a re-import, which is where the counting shows.
  const store = fakeDb().storeFor(USER_A);
  await runImport(wrap('script', [script('s1')]), store);
  const again = await runImport(wrap('script', [script('s1')]), store);
  assert.equal(again.message, GOLDEN.script_again);
});

test('the refusals are word for word what they always were', async () => {
  const bad = {
    wrong_app: { ...wrap('script', [script('s1')]), app: 'other-tool' },
    schema: wrap('script', [script('s1')], { schema: 2 }),
    type: wrap('video', [script('s1')]),
    no_id: wrap('script', [{ title: 'no id' }]),
    empty: wrap('ideas', []),
    kind: wrap('bundle', [{ id: 'x', kind: 'video' }]),
  };
  for (const [name, input] of Object.entries(bad)) {
    let message = null;
    try { await runImport(input, fakeDb().storeFor(USER_A)); } catch (e) { message = e.message; }
    assert.equal(message, GOLDEN_ERRORS[name], `the ${name} refusal changed`);
  }
});
