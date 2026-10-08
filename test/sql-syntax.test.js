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

    // Storage is shared the same way auth is: one storage.objects table and
    // one set of policies for every app in the project. Files need three
    // things from it and nothing else — the objects (for policies and for
    // totalling bytes), the bucket row, and the function that splits a path.
    for (const m of code.match(/storage\.\w+/g) || []) {
      assert.ok(['storage.objects', 'storage.buckets', 'storage.foldername'].includes(m),
        `${f}: only storage.objects, storage.buckets and storage.foldername() may be referenced, found ${m}`);
    }
    // Realtime is shared the same way. Two things are needed from it: the
    // messages table, to put a policy on, and the function that says which
    // channel is being joined.
    for (const m of code.match(/realtime\.\w+/g) || []) {
      assert.ok(['realtime.messages', 'realtime.topic'].includes(m),
        `${f}: only realtime.messages and realtime.topic() may be referenced, found ${m}`);
    }
    // The schemas and tables are the extensions'. Adding a policy is additive
    // and safe; changing the table is not.
    assert.ok(!/\balter table (storage|realtime)\.|\bcreate schema (storage|realtime)\b/i.test(code),
      `${f}: must not alter Storage's or Realtime's own tables`);
    assert.ok(!/\b(alter|drop) policy\b/i.test(code),
      `${f}: must not change or remove a policy, which in storage.objects may belong to the other app`);
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
  //
  // Policies on storage.objects are checked separately, below: that table has
  // no user_id column, so ownership is the first folder of the path instead.
  // Lumping the two together would mean either weakening this check or
  // exempting the storage ones, and both of those lose a real guarantee.
  const allPolicies = [...rls.matchAll(/create policy (\w+)[\s\S]*?;/g)].map((m) => m[0]);
  const policies = allPolicies.filter((p) => /on viralradar\./.test(p));
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
  for (const p of allPolicies.filter((x) => /for update/.test(x))) {
    const name = p.match(/create policy (\w+)/)[1];
    const using = p.indexOf('using (');
    const check = p.indexOf('with check (');
    assert.ok(using !== -1, `${name}: an update policy needs USING`);
    assert.ok(check !== -1, `${name}: an update policy needs WITH CHECK, or a row can be given away`);
    assert.ok(using < check, `${name}: USING must come before WITH CHECK`);
  }

  // Nothing may have a policy except the viralradar tables and the two shared
  // extension tables the features genuinely need — storage.objects for files,
  // realtime.messages for the private signalling channel. This is the line that
  // stops a future migration quietly attaching a policy to something the other
  // app owns. Each of the two has its own test below, with its own rules.
  const SHARED_TABLES = ['storage.objects', 'realtime.messages'];
  for (const p of allPolicies) {
    const target = p.match(/create policy \w+ on ([\w.]+)/);
    assert.ok(target, `could not read what this policy is on: ${p.slice(0, 60)}`);
    assert.ok(SHARED_TABLES.includes(target[1]) || target[1].startsWith('viralradar.'),
      `a policy is attached to ${target[1]}, which is not ViralRadar's to change`);
    // On a shared table, an unprefixed name could collide with the other app's.
    if (SHARED_TABLES.includes(target[1])) {
      assert.match(p.match(/create policy (\w+)/)[1], /^vr_/,
        `a policy on the shared ${target[1]} must be prefixed vr_`);
    }
  }
});

// The two devices have to exchange WebRTC offers, answers and ICE candidates
// before they can connect, and those carry both devices' IP addresses. The
// channel they go over is therefore a private one, and these policies are the
// only thing that makes "private" mean anything.
test('the signalling channel is one per user, and nobody else can be on it', () => {
  const sql = allMigrations();
  const policies = [...sql.matchAll(/create policy (\w+) on realtime\.messages[\s\S]*?;/g)].map((m) => m[0]);
  assert.equal(policies.length, 2, 'one to read the channel, one to write to it');

  const verbs = policies.map((p) => p.match(/for (select|insert)/)[1]).sort();
  assert.deepEqual(verbs, ['insert', 'select'],
    'reading without writing is a device that cannot answer; writing without reading is one that cannot hear');

  for (const p of policies) {
    const name = p.match(/create policy (\w+)/)[1];
    assert.match(name, /^vr_/, `${name}: realtime.messages is shared, so the name must be prefixed`);
    assert.match(p, /to authenticated/, `${name}: a channel for your own devices needs a session`);
    assert.ok(!/using \(true\)|with check \(true\)/.test(p), `${name}: must not allow every topic`);

    const clauses = policyClauses(p);
    assert.ok(clauses.length >= 1, `${name}: no USING or WITH CHECK clause found`);
    for (const c of clauses) {
      // The topic IS the authorisation. An obscure name would not be enough:
      // this project's auth.users is shared with another app, so another
      // account could sit on a guessable channel and read the addresses.
      assert.match(c.body, /realtime\.topic\(\) = 'vr-devices-' \|\| auth\.uid\(\)::text/,
        `${name}: the ${c.kind.toUpperCase()} clause does not tie the topic to the caller`);
      assert.match(c.body, /is_allowed\(\)/,
        `${name}: the ${c.kind.toUpperCase()} clause is missing the allowlist gate`);
    }
  }

  // The topic the policies allow has to be the one the browser asks for.
  const transfer = fs.readFileSync(path.join(ROOT, 'shared', 'transfer.mjs'), 'utf8');
  const topic = transfer.match(/deviceTopic = \(userId\) => `([^`$]*)/);
  assert.ok(topic, 'shared/transfer.mjs should name the topic in one place');
  assert.equal(topic[1], 'vr-devices-',
    'the browser and the policy would be naming different channels, and nothing would ever connect');
});

test('a research pack is a row of its own kind, and carries its JSON', () => {
  const sql = allMigrations();

  const kinds = sql.match(/check \(kind in \(([^)]*'research'[^)]*)\)\)/);
  assert.ok(kinds, "'research' is never added to the kind check, so no pack could be saved");

  // A pack is JSON in `content`. It has no bytes anywhere, so a storage_path
  // on one would be a download button pointing at nothing.
  const shape = sql.slice(sql.lastIndexOf('add constraint project_items_shape'));
  const body = shape.slice(0, shape.indexOf(');'));
  assert.match(body, /when 'research' then[\s\S]*?content is not null/,
    'a research row with no content is an empty pack');
  assert.match(body, /when 'research' then[\s\S]*?storage_path is null/,
    'a pack is JSON, never a file');
});

test('a video is recorded as a row, and can never be a file', () => {
  const sql = allMigrations();

  // The kind list has to accept it...
  const kinds = sql.match(/check \(kind in \(([^)]*'video_ref'[^)]*)\)\)/);
  assert.ok(kinds, "'video_ref' is never added to the kind check");

  // ...and the shape has to forbid it having bytes anywhere. A 2 GB video in a
  // 300 MB slice of a shared project is the entire reason Part 2 exists.
  const shape = sql.slice(sql.lastIndexOf('add constraint project_items_shape'));
  const body = shape.slice(0, shape.indexOf(');'));
  assert.match(body, /when 'video_ref' then[\s\S]*?storage_path is null/,
    'a video_ref with a storage_path would be a download button pointing at nothing');
  // It claims "verified identical" forever, so the claim has to be structural.
  for (const [column, why] of [
    ['sha256 is not null', 'without a digest, "verified identical" is a guess'],
    ['size_bytes is not null', 'a video with no size cannot be described'],
    ['file_name is not null', 'a video with no name cannot be found again'],
    ['cardinality(devices) > 0', 'a video held by no device is not a note worth keeping'],
  ]) {
    assert.ok(body.includes(column), `video_ref must require ${column}: ${why}`);
  }

  // And the 25 MB limit must not apply to it, or a video could never be
  // recorded at all.
  const size = sql.slice(sql.lastIndexOf('add constraint project_items_size'));
  assert.match(size.slice(0, size.indexOf(');')), /storage_path is null or size_bytes <= 26214400/,
    'the 25 MB limit is about Storage, so it must only apply to rows that have bytes there');

  // Replacing a constraint by name would depend on a name PostgreSQL chose.
  assert.match(sql, /con\.contype = 'c'/, 'the kind check was named by PostgreSQL, so it is found by what it does');
  assert.match(sql, /conname not in \('project_items_path_prefix', 'project_items_sha256'\)/,
    'the constraints that are not being changed must be kept by name');
});

// Files live in Storage, which is shared with the other app in this project:
// one storage.objects table, one set of policies, several apps' buckets. So
// these get their own test rather than being bent into the shape of the ones
// above, which assume a user_id column that storage.objects does not have.
test('the storage policies cover one bucket, one prefix per user, and the 300 MB cap', () => {
  const sql = allMigrations();
  const policies = [...sql.matchAll(/create policy (\w+) on storage\.objects[\s\S]*?;/g)].map((m) => m[0]);
  assert.equal(policies.length, 4, 'one policy per verb, for the same reason the tables have four');

  const verbs = policies.map((p) => p.match(/for (select|insert|update|delete)/)[1]).sort();
  assert.deepEqual(verbs, ['delete', 'insert', 'select', 'update']);

  for (const p of policies) {
    const name = p.match(/create policy (\w+)/)[1];
    // The name has to be unmistakably ours: storage.objects holds the other
    // app's policies too, and two policies with one name cannot both exist.
    assert.match(name, /^vr_/, `${name}: a policy on a shared table must be prefixed, or it can collide`);
    assert.match(p, /to authenticated/, `${name}: must be limited to the authenticated role`);
    assert.ok(!/using \(true\)|with check \(true\)/.test(p), `${name}: must not allow every row`);

    // Every clause, not just the first: an update policy has two, and gating
    // one while forgetting the other is the easy mistake to make.
    const clauses = policyClauses(p);
    assert.ok(clauses.length >= 1, `${name}: no USING or WITH CHECK clause found`);
    for (const c of clauses) {
      assert.match(c.body, /bucket_id = 'vr-project-files'/,
        `${name}: the ${c.kind.toUpperCase()} clause does not pin the bucket, so it could reach the other app's files`);
      assert.match(c.body, /\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/,
        `${name}: the ${c.kind.toUpperCase()} clause does not check that the first folder is the caller`);
      assert.match(c.body, /array_length\(storage\.foldername\(name\), 1\) = 2/,
        `${name}: the ${c.kind.toUpperCase()} clause does not pin the <user>/<project>/<file> shape`);
      assert.match(c.body, /is_allowed\(\)/,
        `${name}: the ${c.kind.toUpperCase()} clause is missing the allowlist gate`);
    }
  }

  // Only uploading is capped. Reading, renaming and deleting have to keep
  // working once the cap is reached, or being full would mean being stuck.
  const insert = policies.find((p) => /for insert/.test(p));
  assert.match(insert, /storage_under_cap\(\)/, 'the insert policy is what enforces the 300 MB slice');
  for (const p of policies.filter((x) => !/for insert/.test(x))) {
    assert.ok(!/storage_under_cap\(\)/.test(p),
      `${p.match(/create policy (\w+)/)[1]}: being over the cap must not stop reading or deleting`);
  }
});

test('the bucket is private, and limits one file to 25 MB', () => {
  const sql = allMigrations();
  const insert = sql.match(/insert into storage\.buckets[\s\S]*?;/);
  assert.ok(insert, 'the bucket should be created by a migration, not only by hand in the dashboard');

  assert.match(insert[0], /'vr-project-files'/);
  assert.match(insert[0], /false/, 'a public bucket would serve every file to anyone with the URL');
  assert.ok(!/\btrue\b/.test(insert[0].split('on conflict')[0].replace(/vr-project-files/g, '')),
    'nothing about this bucket should be true: public must be false');
  // 25 MB. The same number as MAX_FILE_BYTES in shared/projects.mjs and as the
  // CHECK on project_items.size_bytes; test/projects.test.js ties the three
  // together.
  assert.match(insert[0], /26214400/, 'the Storage API is the only one of the three limits that can refuse before the upload');
  assert.match(insert[0], /on conflict \(id\) do update/, 'applying the migration twice must be harmless');

  // Only ViralRadar's own bucket is ever touched.
  const buckets = [...sql.matchAll(/storage\.buckets[\s\S]{0,200}?;/g)].map((m) => m[0]);
  for (const b of buckets) {
    assert.ok(!/\bdelete\b|\bupdate storage\.buckets\b/i.test(b), 'a migration must not remove or rewrite buckets in a shared project');
  }
});

test('the 300 MB cap is computed from what the bucket really holds', () => {
  const sql = allMigrations();
  const used = sql.slice(sql.indexOf('function viralradar.storage_used'));
  const body = used.slice(0, used.indexOf('$$;') + 3);

  // Summing project_items.size_bytes would under-count: an upload that
  // succeeded while its row insert failed still occupies the shared quota.
  assert.match(body, /from storage\.objects/, 'the cap must be measured against the bucket, not against our own rows');
  assert.ok(!/project_items/.test(body), 'our own rows are not the authority on how many bytes exist');

  // SECURITY DEFINER is needed because this is called from inside a policy on
  // storage.objects. That makes the owner filter in the body the only thing
  // keeping it honest, so it has to be there.
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/, "a SECURITY DEFINER function without a pinned search_path can be tricked");
  assert.match(body, /\(storage\.foldername\(o\.name\)\)\[1\] = auth\.uid\(\)::text/,
    'without this filter, an elevated function would total up everyone');
  assert.match(body, /bucket_id = 'vr-project-files'/, 'the other app\'s files are not ours to count');
  assert.match(body, /is_allowed\(\)/);
  assert.match(sql, /revoke all on function viralradar\.storage_used\(\) from public, anon;/);

  const cap = sql.slice(sql.indexOf('function viralradar.storage_under_cap'));
  assert.match(cap.slice(0, cap.indexOf('$$;')), /314572800/, '300 MB, matching TOTAL_BYTES_CAP');
});

test('the 14-day cleanup rule is written once, and the job only asks for it', () => {
  const sql = allMigrations();

  const due = sql.slice(sql.indexOf('function viralradar.project_files_due'));
  const body = due.slice(0, due.indexOf('$$;') + 3);
  assert.match(body, /p_days integer default 14/, 'the retention period belongs in one place');
  assert.match(body, /status = 'posted'/, 'only posted projects are cleaned up');
  assert.match(body, /posted_at < now\(\) - make_interval/);
  assert.match(body, /storage_path is not null/, 'notes and links cost nothing and are never deleted');
  assert.match(body, /i\.user_id = p_user_id/, 'the service role bypasses RLS, so the owner filter has to be explicit');
  assert.match(body, /security invoker/, 'called as a user, the policies must still apply');

  // posted_at has to be maintained by the database, or the cleanup can read a
  // date from a project that is no longer posted at all.
  assert.match(sql, /create trigger projects_touch_posted_at before insert or update on viralradar\.projects/);
  const touch = sql.slice(sql.indexOf('function viralradar.touch_posted_at'));
  assert.match(touch.slice(0, touch.indexOf('$$;')), /new\.posted_at = null/,
    'un-posting a project must clear the clock, or its files are deleted while it is back in use');

  // Deleting the storage.objects row would leave the bytes in the bucket,
  // still counted against this project's quota and now unreachable. Only the
  // Storage API really removes a file, so the job calls a function.
  const request = sql.slice(sql.indexOf('function viralradar.request_project_file_purge'));
  const purge = request.slice(0, request.indexOf('$$;') + 3);
  assert.ok(!/delete from storage\.objects/i.test(sql),
    'deleting the row leaves the bytes behind: the Storage API has to do it');
  assert.match(purge, /net\.http_post/);
  assert.match(purge, /purge_function_url/);
  assert.match(purge, /vault\.decrypted_secrets/, 'the secret is read from Vault at the moment it is used');
  assert.match(purge, /is null then[\s\S]*?return;/, 'with nothing configured the job must do nothing, not guess a URL');

  const job = [...sql.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  const cleanup = job.find(([name]) => /purge/.test(name));
  assert.ok(cleanup, 'the cleanup should be scheduled by a migration, not by hand');
  assert.match(cleanup[0], /^viralradar-/, 'the job name must not collide with the other app\'s');
  // Half an hour after the morning refresh, so the two never overlap.
  assert.equal(cleanup[1], '0 2 * * *');
  const refresh = job.find(([name]) => /refresh/.test(name));
  assert.notEqual(cleanup[1], refresh[1], 'two jobs at the same minute would compete for the same connection');
});

test('project folders are shaped so an item can never sit in someone else\'s folder', () => {
  const sql = allMigrations();
  const items = sql.slice(sql.indexOf('create table viralradar.project_items'));
  const body = items.slice(0, items.indexOf('\n);'));

  // A plain (project_id) foreign key would let an item point at a folder with
  // a different owner. The composite one cannot: projects' primary key is the
  // same pair, so item and folder always share an owner.
  assert.match(body, /foreign key \(user_id, project_id\)[\s\S]*?references viralradar\.projects \(user_id, id\) on delete cascade/,
    'the foreign key must be on the pair, or an item can belong to another user\'s folder');

  // A path that claims to be somewhere it is not would survive RLS, because
  // RLS only decides which rows you may write — not whether their contents
  // make sense.
  assert.match(body, /storage_path like \(user_id::text \|\| '\/' \|\| project_id::text \|\| '\/%'\)/,
    'a stored path must be inside the folder the row says it is in');
  assert.match(body, /26214400/, 'the 25 MB limit belongs in the database too, not only in the browser');
  assert.match(body, /\^\[0-9a-f\]\{64\}\$/, 'a digest in mixed case would never compare equal to a lowercase one');

  // Exactly one Inbox per user, said in the database rather than hoped for.
  assert.match(sql, /create unique index projects_one_inbox_idx on viralradar\.projects \(user_id\) where is_inbox/);

  // The folder link to a script is deliberately not a foreign key, for the
  // same reason results.script_id is not.
  const projects = sql.slice(sql.indexOf('create table viralradar.projects'));
  const projectBody = projects.slice(0, projects.indexOf('\n);'));
  assert.ok(!/script_id[^,]*references/.test(projectBody),
    'script_id must not be a foreign key: deleting a script would take the folder with it');
});

test('every user-owned table defaults user_id to auth.uid() and refuses a null owner', () => {
  // Every migration, not just the first: a table added later is exactly the
  // one most likely to miss a rule the earlier ones all follow.
  const schema = allMigrations();

  // Split the file into one chunk per CREATE TABLE so each is checked on its own.
  const chunks = schema.split(/create table viralradar\./).slice(1)
    .filter((c) => !CONTROL_TABLES.includes(c.match(/^(\w+)/)[1]));
  assert.ok(chunks.length >= 9, `expected every user table, found ${chunks.length}`);
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

test('realtime only publishes the tables the app subscribes to', () => {
  // Every migration: a later one adding a table to the publication is exactly
  // how something nobody subscribes to would start being broadcast.
  const sql = allMigrations();
  const published = [...sql.matchAll(/alter publication supabase_realtime add table viralradar\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(published.sort(), ['ideas', 'project_items', 'projects', 'results', 'scripts']);

  // What the browser actually listens to has to be the same list, or either
  // rows are broadcast for nothing or an update never arrives.
  const datajs = fs.readFileSync(path.join(ROOT, 'public', 'data.js'), 'utf8');
  const names = (match) => (datajs.match(match) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const subscribed = [
    ...names(/export const LIVE_TABLES = \[([^\]]*)\]/),
    ...names(/export const PROJECT_LIVE_TABLES = \[([^\]]*)\]/),
  ];
  assert.deepEqual(subscribed.sort(), published.sort(),
    'the publication and what the browser subscribes to have drifted apart');

  // The allowlist and the schedule config must never be published, whatever
  // else is: one says who may use the app, the other where the schedule calls.
  for (const table of CONTROL_TABLES) {
    assert.ok(!published.includes(table), `${table} must never be broadcast over realtime`);
  }
});
