// Parses every SQL file with the real PostgreSQL parser (libpg-query is the
// server's own grammar, compiled to WebAssembly), so a typo in a migration is
// caught here instead of halfway through `supabase db push`.
//
// This checks syntax, not meaning: it cannot know whether a table or a policy
// behaves correctly. `npm run test:rls` does that, against the real database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SQL_DIRS = [path.join(ROOT, 'supabase', 'migrations'), path.join(ROOT, 'supabase', 'tests')];

const sqlFiles = SQL_DIRS.flatMap((dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => path.join(dir, f))
  : []));

test('there are SQL files to check', () => {
  assert.ok(sqlFiles.length >= 3, `expected the migrations and the RLS test, found ${sqlFiles.length} file(s)`);
});

for (const file of sqlFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  test(`${rel} parses as valid PostgreSQL`, async () => {
    const { parse } = await import('libpg-query');
    const sql = fs.readFileSync(file, 'utf8');
    let result;
    try {
      result = await parse(sql);
    } catch (e) {
      // Point at the line, so a typo is quick to find.
      const upto = e.cursorPosition ? sql.slice(0, e.cursorPosition) : '';
      const line = upto ? upto.split('\n').length : null;
      assert.fail(`${rel}${line ? ` line ${line}` : ''}: ${e.message}`);
    }
    assert.ok(result.stmts.length > 0, `${rel} has no statements`);
  });
}

test('the plpgsql inside every function and DO block compiles', async () => {
  const { parsePlPgSQL } = await import('libpg-query');
  for (const file of sqlFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const sql = fs.readFileSync(file, 'utf8');
    if (!/language plpgsql|^do \$/im.test(sql)) continue;
    try {
      await parsePlPgSQL(sql);
    } catch (e) {
      assert.fail(`${rel}: the plpgsql does not compile: ${e.message}`);
    }
  }
});

// This Supabase project is shared with another app, so the migrations must stay
// strictly inside their own schema. These checks are the guard rail: if a future
// migration reaches into public or auth, or drops something, it fails here
// rather than on someone else's data.
test('the migrations touch nothing outside the viralradar schema', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

    assert.ok(!/create (table|view|materialized view) (?!viralradar\.)/i.test(code),
      `${f}: creates a table or view outside the viralradar schema`);
    // An index name is never schema-qualified: it lives wherever its table lives,
    // so what matters is the table it is attached to.
    for (const m of code.matchAll(/create index \w+ on (\S+)/gi)) {
      assert.match(m[1], /^viralradar\./, `${f}: indexes a table outside the viralradar schema (${m[1]})`);
    }
    for (const m of code.matchAll(/create trigger \w+[\s\S]{0,60}?on (\S+)/gi)) {
      assert.match(m[1], /^viralradar\./, `${f}: puts a trigger on a table outside the viralradar schema (${m[1]})`);
    }
    assert.ok(!/\bcreate (or replace )?function (?!viralradar\.)/i.test(code),
      `${f}: creates a function outside the viralradar schema`);
    // A trigger on auth.users would fire for the other app's signups too.
    assert.ok(!/create trigger[\s\S]{0,120}?on auth\./i.test(code),
      `${f}: puts a trigger on an auth table, which the other app in this project shares`);
    assert.ok(!/\bdrop (table|schema|function|trigger|index)\b/i.test(code),
      `${f}: a migration must never drop anything in a shared project`);
    assert.ok(!/\btruncate\b|\bdelete from\b/i.test(code),
      `${f}: a migration must never remove rows in a shared project`);
    // auth may only be read from: auth.users for the foreign key, auth.uid()
    // for the owner default and the policies. Nothing else.
    for (const m of code.match(/auth\.\w+/g) || []) {
      assert.ok(['auth.users', 'auth.uid'].includes(m),
        `${f}: only auth.users and auth.uid() may be referenced, found ${m}`);
    }
    assert.ok(!/\balter table auth\.|\binsert into auth\./i.test(code), `${f}: must not write to auth`);
  }
});

test('the schema is created and hidden from anon', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const schema = fs.readdirSync(dir).filter((f) => f.includes('init'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(schema, /create schema if not exists viralradar;/);
  assert.match(schema, /grant usage on schema viralradar to authenticated, service_role;/);
  assert.match(schema, /revoke all on schema viralradar from anon;/);
});

test('settings rows are created by the app, not by a trigger on shared auth', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const schema = fs.readdirSync(dir).filter((f) => f.includes('init'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!/handle_new_user|on_auth_user_created/.test(schema),
    'the signup trigger must be gone: it would fire for the other app in this project');
  // Every settings column needs a default, so "insert (user_id) values (...)" is enough.
  const body = schema.split('create table viralradar.settings')[1].slice(0, schema.split('create table viralradar.settings')[1].indexOf(');'));
  const columns = body.split('\n').map((l) => l.trim()).filter((l) => /^\w+\s+\S/.test(l) && !l.startsWith('primary key'));
  for (const col of columns) {
    const name = col.match(/^(\w+)/)[1];
    if (name === 'user_id') continue;
    assert.match(col, /default /, `settings.${name} has no default, so first-use creation would fail`);
  }
});

test('migrations run in a sensible order and are named for the CLI', () => {
  const names = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));
  for (const n of names) {
    assert.match(n, /^\d{14}_[a-z0-9_]+\.sql$/, `${n}: the Supabase CLI expects <14-digit timestamp>_name.sql`);
  }
  assert.deepEqual([...names].sort(), names, 'the file list must already be in timestamp order');
  // Tables have to exist before policies can be attached to them.
  const init = names.findIndex((n) => n.includes('init'));
  const rls = names.findIndex((n) => n.includes('rls'));
  assert.ok(init !== -1 && rls !== -1 && init < rls, 'the schema migration must come before the RLS migration');
});

test('every table created in the schema is locked down in the RLS migration', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const read = (match) => fs.readdirSync(dir).filter((f) => f.includes(match))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const schema = read('init');
  const rls = read('rls');

  const tables = [...schema.matchAll(/create table viralradar\.(\w+)/g)].map((m) => m[1]);
  assert.ok(tables.length >= 7, `expected at least 7 tables, found ${tables.join(', ')}`);

  for (const t of tables) {
    assert.ok(new RegExp(`alter table viralradar\\.${t} enable row level security`).test(rls),
      `${t}: row level security is never enabled`);
    // One policy per verb, so a mistake can only ever widen one of them.
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      assert.ok(new RegExp(`create policy ${t}_${verb}_own on viralradar\\.${t}`).test(rls),
        `${t}: no ${verb} policy`);
    }
    assert.ok(new RegExp(`revoke all on table[\\s\\S]*?viralradar\\.${t}[\\s\\S]*?from anon`).test(rls),
      `${t}: anon is never revoked`);
  }

  // Every policy must be scoped to the signed-in user, with nothing left open.
  const policies = [...rls.matchAll(/create policy (\w+)[\s\S]*?;/g)].map((m) => m[0]);
  for (const p of policies) {
    const name = p.match(/create policy (\w+)/)[1];
    assert.match(p, /to authenticated/, `${name}: must be limited to the authenticated role`);
    assert.ok(/user_id = auth\.uid\(\)/.test(p), `${name}: must compare user_id with auth.uid()`);
    assert.ok(!/using \(true\)|with check \(true\)/.test(p), `${name}: must not allow every row`);
  }
  // Updates need both halves: USING to find the row, WITH CHECK to stop it being given away.
  for (const p of policies.filter((x) => /for update/.test(x))) {
    const name = p.match(/create policy (\w+)/)[1];
    const using = p.indexOf('using (');
    const check = p.indexOf('with check (');
    assert.ok(using !== -1, `${name}: an update policy needs USING`);
    assert.ok(check !== -1, `${name}: an update policy needs WITH CHECK, or a row can be given away`);
    assert.ok(using < check, `${name}: USING must come before WITH CHECK`);
  }
});

test('every user-owned table defaults user_id to auth.uid() and refuses a null owner', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const schema = fs.readdirSync(dir).filter((f) => f.includes('init'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

  // Split the file into one chunk per CREATE TABLE so each is checked on its own.
  const chunks = schema.split(/create table viralradar\./).slice(1);
  assert.ok(chunks.length >= 7);
  for (const chunk of chunks) {
    const table = chunk.match(/^(\w+)/)[1];
    const body = chunk.slice(0, chunk.indexOf(');'));
    assert.match(body, /user_id\s+uuid\s+(not null|primary key)/, `${table}: user_id must be uuid and never null`);
    assert.match(body, /default auth\.uid\(\)/, `${table}: user_id must default to auth.uid()`);
    assert.match(body, /references auth\.users \(id\) on delete cascade/, `${table}: user_id must reference auth.users and cascade`);
    assert.match(body, /updated_at\s+timestamptz not null default now\(\)/, `${table}: needs an updated_at column`);
    assert.match(body, /created_at\s+timestamptz not null default now\(\)/, `${table}: needs a created_at column`);
    assert.ok(new RegExp(`create trigger ${table}_touch_updated_at`).test(schema), `${table}: needs the updated_at trigger`);
  }
});

test('ideas, scripts and results have the indexed origin_at the UI sorts by', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const schema = fs.readdirSync(dir).filter((f) => f.includes('init'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const t of ['ideas', 'scripts', 'results']) {
    assert.match(schema, new RegExp(`create index ${t}_origin_at_idx on viralradar\\.${t} \\(user_id, origin_at desc\\)`),
      `${t}: origin_at must be indexed for the sort the UI does`);
  }
  // The source values the app can write, and nothing else.
  const sources = [...schema.matchAll(/check \(source in \(([^)]*)\)\)/g)].map((m) => m[1]);
  assert.ok(sources.length >= 3, 'ideas, scripts and results each need a source check');
  for (const s of sources) {
    for (const v of ['claude', 'gemini', 'openrouter', 'shorts-studio', 'manual']) {
      assert.ok(s.includes(`'${v}'`), `the source check is missing ${v}`);
    }
  }
});

test('ideas, scripts and results upsert on (user_id, id) so imports never duplicate', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const schema = fs.readdirSync(dir).filter((f) => f.includes('init'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const t of ['ideas', 'scripts', 'results']) {
    const body = schema.split(`create table viralradar.${t}`)[1];
    assert.match(body.slice(0, body.indexOf(');')), /primary key \(user_id, id\)/, `${t}: primary key must be (user_id, id)`);
  }
  // Trends are one row per URL per user.
  const trends = schema.split('create table viralradar.trends')[1];
  assert.match(trends.slice(0, trends.indexOf(');')), /primary key \(user_id, url\)/);
});

test('realtime only publishes the three tables the app subscribes to', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const rls = fs.readdirSync(dir).filter((f) => f.includes('rls'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const published = [...rls.matchAll(/alter publication supabase_realtime add table viralradar\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(published.sort(), ['ideas', 'results', 'scripts']);
});
