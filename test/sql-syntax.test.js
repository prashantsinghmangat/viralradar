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

// These are not user data, and they are locked down the opposite way: RLS on
// with NO policies, so they deny every signed-in user, and nothing is granted
// to anon or authenticated. Each has its own test below.
//   allowed_users  who may use the app at all
//   cron_config    where the morning refresh calls, and for whom
const CONTROL_TABLES = ['allowed_users', 'cron_config'];

/** Every migration, joined. Tables can be added by any of them, not just the first. */
const allMigrations = () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
};

// Pull the USING and WITH CHECK clauses out of a policy by balancing brackets.
// auth.uid() and is_allowed() contain brackets of their own, so a regex here
// silently matches only the clauses that are already correct.
function policyClauses(sql) {
  const out = [];
  const re = /(using|with check)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    out.push({ kind: m[1].toLowerCase(), body: sql.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

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
  // Every migration, not just the first: a table added by a later one would
  // otherwise never be checked, which is how cron_config slipped through once.
  const schema = allMigrations();
  const rls = allMigrations();

  const all = [...schema.matchAll(/create table viralradar\.(\w+)/g)].map((m) => m[1]);
  const tables = all.filter((t) => !CONTROL_TABLES.includes(t));
  assert.ok(tables.length >= 7, `expected at least 7 user tables, found ${tables.join(', ')}`);

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
    // The second gate: being signed in is not enough in a shared project.
    assert.ok(/\(select viralradar\.is_allowed\(\)\)/.test(p),
      `${name}: must also require viralradar.is_allowed(), or a user of the other app in this project could use ViralRadar`);
    // EVERY clause needs BOTH gates, not just the first one. An update policy
    // has two (USING and WITH CHECK) and it is easy to gate one and forget the
    // other, so the clauses are pulled apart by balancing brackets rather than
    // by a regex, which would only ever find the clauses that are already right.
    const clauses = policyClauses(p);
    assert.ok(clauses.length >= 1, `${name}: no USING or WITH CHECK clause found`);
    for (const c of clauses) {
      assert.ok(/user_id = auth\.uid\(\)/.test(c.body), `${name}: the ${c.kind.toUpperCase()} clause does not check the owner -> ${c.body}`);
      assert.ok(/is_allowed\(\)/.test(c.body), `${name}: the ${c.kind.toUpperCase()} clause is missing the allowlist gate -> ${c.body}`);
    }
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
  const chunks = schema.split(/create table viralradar\./).slice(1)
    .filter((c) => !CONTROL_TABLES.includes(c.match(/^(\w+)/)[1]));
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

// Being signed in to this Supabase project is not the same as being a
// ViralRadar user: auth.users is shared with another app that already has
// accounts in it. The allowlist is what closes that gap, so it gets its own
// test rather than being lumped in with the data tables.
test('the allowlist is locked down harder than the data tables', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const read = (match) => fs.readdirSync(dir).filter((f) => f.includes(match))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const schema = read('init');
  const rls = read('rls');

  assert.match(schema, /create table viralradar\.allowed_users/, 'the allowlist table must exist');
  assert.match(rls, /alter table viralradar\.allowed_users enable row level security/);

  // No policies at all: with RLS on, that denies every role except the owner
  // and roles that bypass RLS (service_role).
  assert.ok(!/create policy \w+ on viralradar\.allowed_users/.test(rls),
    'the allowlist must have NO policies: a signed-in user must not be able to read it or add themselves');
  assert.match(rls, /revoke all on table viralradar\.allowed_users from anon, authenticated;/,
    'anon and authenticated must have no privileges on the allowlist');
  assert.match(rls, /grant [\w, ]+ on table viralradar\.allowed_users to service_role;/);

  // The function the policies call has to be able to read a table the caller cannot.
  const fn = schema.slice(schema.indexOf('function viralradar.is_allowed'));
  assert.match(fn, /security definer/, 'is_allowed() must be SECURITY DEFINER to read a table the caller cannot');
  assert.match(fn, /set search_path = ''/, "is_allowed() must pin an empty search_path, or a SECURITY DEFINER function can be tricked");
  assert.match(fn, /\bstable\b/, 'is_allowed() should be STABLE so it is not re-run per row');
  assert.match(fn, /from viralradar\.allowed_users where user_id = auth\.uid\(\)/);
  assert.match(schema, /revoke all on function viralradar\.is_allowed\(\) from public;/);
  assert.match(schema, /grant execute on function viralradar\.is_allowed\(\) to authenticated, service_role;/);

  // The allowlist must not be reachable through the API either.
  assert.ok(!/alter publication supabase_realtime add table viralradar\.allowed_users/.test(rls),
    'the allowlist must never be published over realtime');
});

test('the schedule config is as shut as the allowlist, and holds no secret', () => {
  const sql = allMigrations();

  assert.match(sql, /create table viralradar\.cron_config/);
  assert.match(sql, /alter table viralradar\.cron_config enable row level security/);
  assert.ok(!/create policy \w+ on viralradar\.cron_config/.test(sql),
    'no policies: a signed-in browser has no business reading where the schedule calls');
  assert.match(sql, /revoke all on table viralradar\.cron_config from anon, authenticated;/);

  // The secret is in Vault. Having it in this table as well would mean reading
  // the table was enough to trigger a refresh for someone.
  const table = sql.slice(sql.indexOf('create table viralradar.cron_config'));
  const body = table.slice(0, table.indexOf(');'));
  // Column names only: "primary key" is not a secret, and matching raw text
  // said it was.
  const columns = body.split('\n').slice(1)
    .map((line) => (line.trim().match(/^(\w+)\s+\S/) || [])[1])
    .filter(Boolean);
  assert.ok(columns.length >= 3, `expected to find the columns, got ${columns.join(', ')}`);
  for (const column of columns) {
    assert.ok(!/secret|token|password/i.test(column),
      `cron_config.${column} looks like a secret; it belongs in Vault, not in a table`);
  }
  assert.match(sql, /vault\.decrypted_secrets/, 'the secret is read from Vault at the moment it is used');
});

test('the morning refresh is scheduled for 07:00 IST, under its own name', () => {
  const sql = allMigrations();
  const job = sql.match(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)'/);
  assert.ok(job, 'the schedule should be created by a migration, not by hand');

  const [, name, schedule] = job;
  // This project already has another app's job in it.
  assert.match(name, /^viralradar-/, 'the job name must not collide with the other app\'s');
  assert.equal(schedule, '30 1 * * *', '01:30 UTC');

  // Confirm that really is 07:00 in India, rather than trusting the comment.
  const [minute, hour] = schedule.split(' ');
  const ist = new Date(Date.UTC(2026, 0, 1, Number(hour), Number(minute)))
    .toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  assert.equal(ist, '07:00');

  assert.match(sql, /create extension if not exists pg_cron/);
  assert.match(sql, /create extension if not exists pg_net/, 'pg_cron alone cannot make an HTTP call');
});

test('counting usage cannot lose a count, and cannot be done for someone else', () => {
  const sql = allMigrations();
  const fn = sql.slice(sql.indexOf('function viralradar.add_usage'));
  const body = fn.slice(0, fn.indexOf('$$;') + 3);

  // Read-then-write loses a count when two refreshes overlap; one statement
  // with ON CONFLICT cannot.
  assert.match(body, /on conflict \(user_id, date, provider\) do update/);
  assert.ok(!/select .* into/i.test(body), 'reading the row first would make this racy');

  // SECURITY INVOKER means the policies still apply, so passing another user's
  // id is refused rather than quietly accepted.
  assert.match(body, /security invoker/);
  assert.ok(!/security definer/.test(body));
  assert.match(sql, /revoke all on function viralradar\.add_usage[^;]*from public;/);
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
