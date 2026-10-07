// Tests for public/data.js — every read and write the browser does.
//
// The Supabase client is faked, which lets the real query-building code run in
// Node: what table, which filters, which order, and crucially what is sent. The
// fake records each call so a test can assert on it.
//
// What this cannot check is whether the database agrees — that is what
// `npm run test:rls` is for. What it can check is that the browser asks for the
// right thing, and never sends something it should not.
const test = require('node:test');
const assert = require('node:assert/strict');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/**
 * A stand-in for the Supabase client. Each query records what it was asked for
 * and resolves to whatever `respond` returns.
 */
function fakeClient({ respond = () => ({ data: [], error: null }), auth = {} } = {}) {
  const calls = [];
  const channels = [];

  const from = (table) => {
    const call = { table, op: 'select', columns: null, payload: null, onConflict: null, filters: [], order: [], limit: null };
    const self = {
      select(columns) { call.columns = columns ?? null; if (call.op === 'select') call.op = 'select'; return self; },
      insert(payload) { call.op = 'insert'; call.payload = payload; return self; },
      update(payload) { call.op = 'update'; call.payload = payload; return self; },
      upsert(payload, options) { call.op = 'upsert'; call.payload = payload; call.onConflict = options?.onConflict ?? null; return self; },
      delete() { call.op = 'delete'; return self; },
      eq(column, value) { call.filters.push(['eq', column, value]); return self; },
      in(column, values) { call.filters.push(['in', column, values]); return self; },
      order(column, options) { call.order.push([column, options?.ascending === false ? 'desc' : 'asc']); return self; },
      limit(n) { call.limit = n; return self; },
      then(onOk, onErr) {
        calls.push(call);
        return Promise.resolve(respond(call)).then(onOk, onErr);
      },
    };
    return self;
  };

  return {
    calls,
    channels,
    from,
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signInWithOtp: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      ...auth,
    },
    functions: {
      invoked: [],
      async invoke(name, options) {
        this.invoked.push({ name, body: options?.body });
        return { data: { ok: true, message: 'Imported 1 script: X' }, error: null };
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
    removeChannel(/* channel */) { channels.removed = true; },
  };
}

const load = async () => (await import('../public/data.js'));
const lastCall = (client) => client.calls[client.calls.length - 1];

test('ideas are listed newest first by origin_at, which is what the UI sorts on', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: [{ id: 'i1' }], error: null }) });
  const rows = await createData(client).ideas.list();

  assert.deepEqual(rows, [{ id: 'i1' }]);
  const call = lastCall(client);
  assert.equal(call.table, 'ideas');
  assert.equal(call.op, 'select');
  assert.deepEqual(call.order, [['origin_at', 'desc']]);
});

test('an unknown idea status never reaches the database', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await assert.rejects(() => createData(client).ideas.setStatus('i1', 'deleted'), /Unknown status/);
  assert.equal(client.calls.length, 0, 'it should not have asked the database anything');
});

test('changing a status that no longer exists says so plainly', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: [], error: null }) });
  await assert.rejects(() => createData(client).ideas.setStatus('gone', 'picked'), /no longer there/);
});

test('the scripts board asks only for the columns it draws', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await createData(client).scripts.list();

  const call = lastCall(client);
  assert.equal(call.table, 'scripts');
  // beats and raw can be large; the board shows none of it.
  assert.ok(!/beats|raw|ig_caption/.test(call.columns), `the board asked for too much: ${call.columns}`);
  assert.match(call.columns, /stage/);
  assert.deepEqual(call.order, [['origin_at', 'desc']]);
});

test('an unknown script stage never reaches the database', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await assert.rejects(() => createData(client).scripts.setStage('s1', 'published'), /Unknown stage/);
  assert.equal(client.calls.length, 0);
});

test('the Results numbers are worked out in the browser from the rows', async () => {
  const { createData } = await load();
  const rows = [
    { id: 'a', title: 'A', views: 10000, saves: 500, posted_on: '2026-10-06', format: 'demo', hook: 'question', len: '30s', cta: 'save' },
    { id: 'b', title: 'B', views: 2000, saves: 40, posted_on: '2026-10-05', format: 'listicle', hook: 'claim', len: '45s', cta: 'follow' },
  ];
  const client = fakeClient({ respond: () => ({ data: rows, error: null }) });
  const stats = await createData(client).results.stats('2026-10-06');

  assert.equal(stats.count, 2);
  assert.equal(stats.total_views, 12000);
  assert.equal(stats.save_rate, 4.5);
  assert.equal(stats.streak.current, 2);
  assert.equal(stats.top[0].id, 'a');
  // One read, not two: the stats come from the same rows the table shows.
  assert.equal(client.calls.length, 1);
});

test('the radar finds the most recent day, then reads only that day', async () => {
  const { createData } = await load();
  const client = fakeClient({
    respond: (call) => (call.columns === 'fetched_on'
      ? { data: [{ fetched_on: '2026-10-07' }], error: null }
      : { data: [{ url: 'https://a/1', score: 9 }], error: null }),
  });
  const { day, trends } = await createData(client).trends.list('youtube');

  assert.equal(day, '2026-10-07');
  assert.equal(trends.length, 1);
  const call = lastCall(client);
  assert.deepEqual(call.filters, [['eq', 'fetched_on', '2026-10-07'], ['eq', 'source', 'youtube']]);
  assert.deepEqual(call.order, [['score', 'desc']]);
});

test('an empty radar is a quiet empty result, not an error', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: [], error: null }) });
  assert.deepEqual(await createData(client).trends.list(), { day: null, trends: [] });
});

test('settings are created on first use, because no trigger does it', async () => {
  const { createData } = await load();
  let created = false;
  const client = fakeClient({
    respond: (call) => {
      if (call.op === 'upsert') { created = true; return { data: null, error: null }; }
      return { data: created ? [{ user_id: USER, language: 'English' }] : [], error: null };
    },
  });
  const row = await createData(client).settings.get(USER);

  assert.equal(created, true, 'the missing row should have been created');
  assert.equal(row.user_id, USER);
  const upsert = client.calls.find((c) => c.op === 'upsert');
  assert.equal(upsert.table, 'settings');
  assert.deepEqual(upsert.payload, { user_id: USER });
  assert.equal(upsert.onConflict, 'user_id');
});

test('settings that already exist are not written again', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: [{ user_id: USER }], error: null }) });
  await createData(client).settings.get(USER);
  assert.equal(client.calls.filter((c) => c.op !== 'select').length, 0, 'reading settings must not write anything');
});

test('creating an import token stores the hash and never the token', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const token = 'vr_' + 'a'.repeat(43);
  const hash = 'b'.repeat(64);
  const returned = await createData(client).tokens.create(USER, 'laptop', token, hash);

  assert.equal(returned, token, 'the token is handed back once, to show the person');
  const call = lastCall(client);
  assert.equal(call.table, 'import_tokens');
  assert.equal(call.op, 'insert');
  assert.equal(call.payload.token_hash, hash);
  assert.equal(call.payload.user_id, USER);
  const sent = JSON.stringify(call.payload);
  assert.ok(!sent.includes(token), 'the token itself must never be sent to the database');
});

test('the token list never asks for the hash', async () => {
  const { createData } = await load();
  const client = fakeClient();
  await createData(client).tokens.list();
  assert.ok(!/token_hash/.test(lastCall(client).columns), 'there is no reason for the browser to hold the hash');
});

test('an import sends the text through untouched', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const text = '{ "app": "shorts-studio", "schema": 1, "type": "ideas", "items": [] }';
  const result = await createData(client).imports.send(text);

  assert.deepEqual(client.functions.invoked, [{ name: 'vr-import', body: text }]);
  assert.equal(result.message, 'Imported 1 script: X');
});

test('a failing function shows its own message, not a generic one', async () => {
  const { createData } = await load();
  const client = fakeClient();
  client.functions.invoke = async () => ({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'Wrong app: expected "app": "shorts-studio"' }) } },
  });
  await assert.rejects(() => createData(client).imports.send('{}'), /Wrong app/);
});

test('live updates cover the three tables, in the right schema', async () => {
  const { createData, LIVE_TABLES } = await load();
  const client = fakeClient();
  const seen = [];
  const stop = createData(client).live((change) => seen.push(change));

  const channel = client.channels[0];
  assert.equal(channel.subscribed, true);
  assert.deepEqual(channel.listeners.map((l) => l.filter.table), LIVE_TABLES);
  for (const l of channel.listeners) {
    assert.equal(l.filter.schema, 'viralradar', 'the wrong schema would silently deliver nothing');
    assert.equal(l.filter.event, '*');
  }

  // An insert arriving from the other device.
  channel.listeners[0].cb({ eventType: 'INSERT', new: { id: 'i1' } });
  assert.deepEqual(seen, [{ table: 'ideas', event: 'INSERT', row: { id: 'i1' } }]);

  stop();
  assert.equal(client.channels.removed, true, 'leaving the page should drop the subscription');
});

test('a restore re-owns every row and never deletes anything', async () => {
  const { createData } = await load();
  const client = fakeClient();
  const file = {
    app: 'viralradar',
    tables: {
      // A backup taken from another account, restored into this one.
      ideas: [{ user_id: OTHER, id: 'i1', title: 'An idea' }],
      trends: [{ user_id: OTHER, url: 'https://a/1' }],
      settings: [{ user_id: OTHER, language: 'Hindi' }],
    },
  };
  const counts = await createData(client).backup.restore(file, USER);

  assert.equal(counts.ideas, 1);
  for (const call of client.calls) {
    assert.equal(call.op, 'upsert', 'a restore must never delete: it adds and updates');
    for (const row of call.payload) {
      assert.equal(row.user_id, USER, 'every restored row must belong to whoever is restoring it');
    }
  }
  const byTable = Object.fromEntries(client.calls.map((c) => [c.table, c.onConflict]));
  assert.equal(byTable.ideas, 'user_id,id');
  assert.equal(byTable.trends, 'user_id,url', 'trends are one row per URL per user');
  assert.equal(byTable.settings, 'user_id');
});

test('a file that is not a ViralRadar backup is refused before anything is written', async () => {
  const { createData } = await load();
  const client = fakeClient();
  for (const bad of [null, {}, { app: 'something-else', tables: {} }, { app: 'viralradar' }]) {
    await assert.rejects(() => createData(client).backup.restore(bad, USER), /not a ViralRadar backup/);
  }
  assert.equal(client.calls.length, 0);
});

test('sign-in checks the address and does not create accounts', async () => {
  const { createData } = await load();
  let sent = null;
  const client = fakeClient({ auth: { signInWithOtp: async (opts) => { sent = opts; return { error: null }; } } });
  const data = createData(client);

  await assert.rejects(() => data.auth.signIn('not-an-email'), /does not look like an email/);
  assert.equal(sent, null);

  await data.auth.signIn('  me@example.com  ', 'https://ytshortradar.netlify.app');
  assert.equal(sent.email, 'me@example.com', 'the address should be trimmed');
  assert.equal(sent.options.shouldCreateUser, false, 'signing in must never quietly create an account');
  assert.equal(sent.options.emailRedirectTo, 'https://ytshortradar.netlify.app');
});

test('sign-in failures are explained in plain words', async () => {
  const { createData } = await load();
  const cases = [
    ['Signups not allowed for otp', /does not have an account here/],
    ['email rate limit exceeded', /Wait a minute/],
  ];
  for (const [message, expected] of cases) {
    const client = fakeClient({ auth: { signInWithOtp: async () => ({ error: { message } }) } });
    await assert.rejects(() => createData(client).auth.signIn('me@example.com'), expected);
  }
});

test('database errors are turned into something worth reading', async () => {
  const { readable } = await load();
  const cases = [
    [{ message: 'TypeError: Failed to fetch' }, /No internet connection/],
    [{ message: 'JWT expired' }, /session has expired/],
    [{ message: 'permission denied for table ideas' }, /not allowed to use ViralRadar/],
    [{ message: 'The schema must be one of the following: public' }, /Exposed schemas/],
    // What PostgREST actually says when the schema is not exposed. The first
    // version of this only matched the other wording, so the real failure came
    // through as a raw database message on every screen.
    [{ message: 'Invalid schema: viralradar' }, /Exposed schemas/],
    [{ code: 'PGRST106', message: 'Invalid schema: viralradar' }, /not switched on in Supabase/],
    [{ message: 'something odd' }, /Could not load your ideas: something odd/],
  ];
  for (const [error, expected] of cases) {
    assert.match(readable(error, 'load your ideas'), expected);
  }
  assert.equal(readable(null, 'x'), null);
});

test('a database error on a read surfaces as a readable failure, not empty data', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: null, error: { message: 'permission denied for table ideas' } }) });
  await assert.rejects(() => createData(client).ideas.list(), /not allowed to use ViralRadar/);
});

test('signing in with a password sends exactly what was typed, trimmed', async () => {
  const { createData } = await load();
  let sent = null;
  const client = fakeClient({ auth: { signInWithPassword: async (o) => { sent = o; return { data: { session: { user: { id: USER } } }, error: null }; } } });
  const session = await createData(client).auth.signInWithPassword('  me@example.com  ', 'a real password');

  assert.deepEqual(sent, { email: 'me@example.com', password: 'a real password' });
  assert.equal(session.user.id, USER);
});

test('a wrong password and an unknown address give the same answer', async () => {
  const { createData } = await load();
  // Different wording would let someone work out which accounts exist.
  const client = fakeClient({ auth: { signInWithPassword: async () => ({ data: null, error: { message: 'Invalid login credentials' } }) } });
  await assert.rejects(() => createData(client).auth.signInWithPassword('me@example.com', 'wrong'), /Wrong email or password./);
});

test('the other sign-in failures are explained rather than passed through', async () => {
  const { createData } = await load();
  const cases = [
    ['Email not confirmed', /not confirmed yet/],
    ['Request rate limit reached', /Wait a minute/],
  ];
  for (const [message, expected] of cases) {
    const client = fakeClient({ auth: { signInWithPassword: async () => ({ data: null, error: { message } }) } });
    await assert.rejects(() => createData(client).auth.signInWithPassword('me@example.com', 'x'), expected);
  }
});

test('an empty email or password never reaches the server', async () => {
  const { createData } = await load();
  let called = false;
  const client = fakeClient({ auth: { signInWithPassword: async () => { called = true; return { data: null, error: null }; } } });
  const auth = createData(client).auth;
  await assert.rejects(() => auth.signInWithPassword('', 'pw'), /Enter your email/);
  await assert.rejects(() => auth.signInWithPassword('me@example.com', ''), /Enter your password/);
  assert.equal(called, false);
});

test('an error is turned into a sentence once, not wrapped twice', async () => {
  const { createData } = await load();
  const client = fakeClient({ respond: () => ({ data: null, error: { message: 'Invalid schema: viralradar' } }) });
  let message = null;
  try { await createData(client).settings.get(USER); } catch (e) { message = e.message; }

  assert.ok(message, 'the read should have failed');
  // Passing an already-readable Error back through readable() is what produced
  // "Could not read your settings: Could not read your settings: ..." on screen.
  const first = message.indexOf('Could not');
  assert.equal(message.indexOf('Could not', first + 1), -1, `the message is wrapped twice: ${message}`);
});

test('a function that is not deployed says so, and how to deploy it', async () => {
  const { createData } = await load();
  const client = fakeClient();
  // What supabase-js reports when the function does not exist: the gateway's
  // 404 carries no CORS headers, so the browser only sees a failed request.
  client.functions.invoke = async () => ({
    data: null,
    error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' },
  });

  await assert.rejects(
    () => createData(client).imports.send('{}'),
    (e) => /vr-import.*not deployed yet/s.test(e.message) && /functions deploy vr-import --use-api/.test(e.message),
  );
});

test('a function that answers with its own error keeps that error', async () => {
  const { createData } = await load();
  const client = fakeClient();
  // A real refusal from the function must not be replaced by the generic
  // "not deployed" wording, or a bad file would look like a missing function.
  client.functions.invoke = async () => ({
    data: null,
    error: {
      message: 'Edge Function returned a non-2xx status code',
      context: { json: async () => ({ error: 'Schema mismatch: this app understands schema 1' }) },
    },
  });
  await assert.rejects(() => createData(client).imports.send('{}'), /Schema mismatch/);
});
