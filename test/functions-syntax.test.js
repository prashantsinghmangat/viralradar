// Syntax-checks the Edge Functions.
//
// Deno is not installed on this machine, so the functions cannot be type-checked
// or run here. This is the next best thing: TypeScript parses every .ts file, so
// a stray bracket or a bad bit of syntax fails here instead of at deploy time.
//
// What this does NOT check: types, that jsr:/npm: imports resolve, or that the
// function behaves correctly. The behaviour lives in shared/*.mjs, which the
// other tests cover properly, precisely so that the untestable part of the
// function stays as thin as possible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'supabase', 'functions');

function tsFiles(dir = FUNCTIONS) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = tsFiles();

test('there are Edge Functions to check', () => {
  assert.ok(files.length >= 3, `expected the function and its shared helpers, found ${files.length}`);
});

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  test(`${rel} parses as valid TypeScript`, () => {
    const source = fs.readFileSync(file, 'utf8');
    const result = ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, allowJs: true },
      fileName: rel,
    });
    const errors = (result.diagnostics ?? []).map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      if (d.file && typeof d.start === 'number') {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return `line ${line + 1}, column ${character + 1}: ${message}`;
      }
      return message;
    });
    assert.deepEqual(errors, [], `${rel}:\n  ${errors.join('\n  ')}`);
  });
}

test('the import function handles the methods and failures a browser will throw at it', () => {
  const source = fs.readFileSync(path.join(FUNCTIONS, 'vr-import', 'index.ts'), 'utf8');
  assert.match(source, /OPTIONS/, 'a browser sends a pre-flight request before a cross-origin POST');
  assert.match(source, /preflight\(req\)/);
  assert.match(source, /405/, 'anything other than POST should say so, not crash');
  assert.match(source, /ImportError/, 'a bad file must come back as a 400 with its own message');
  assert.match(source, /400/);
  assert.match(source, /AuthError/);
  // The body is read as text, because the importer accepts pasted text as well
  // as JSON and produces its own parse error message.
  assert.match(source, /req\.text\(\)/);
  assert.ok(!/req\.json\(\)/.test(source), 'req.json() would throw before the importer could explain the problem');
});

test('every function the schedule calls has the gateway stood down', () => {
  // Supabase verifies the Authorization header as a JWT by default. pg_cron
  // sends a shared secret in a header of its own and no Authorization at all,
  // so without verify_jwt = false the gateway refuses the call before the
  // function runs — which is how the import token path was broken once, and the
  // failure looks nothing like its cause.
  const config = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
  for (const name of ['vr-refresh-trends', 'vr-purge-project-files']) {
    const block = config.slice(config.indexOf(`[functions.${name}]`));
    assert.ok(config.includes(`[functions.${name}]`), `${name} has no config block`);
    assert.match(block.slice(0, 200), /verify_jwt = false/, `${name} is called by the schedule and would be refused by the gateway`);

    // Standing the gateway down means the function has to do the whole job
    // itself, so both halves have to be visible in it.
    const source = fs.readFileSync(path.join(FUNCTIONS, name, 'index.ts'), 'utf8');
    assert.match(source, /x-vr-cron-secret/, `${name} must check the schedule secret itself`);
    assert.match(source, /sameSecret/, `${name} must compare the secret in constant time`);
    assert.match(source, /allowed_users/, `${name} runs as the service role, which skips the allowlist gate`);
  }
});

test('the cleanup deletes files through Storage, and only ever its own', () => {
  const source = fs.readFileSync(path.join(FUNCTIONS, 'vr-purge-project-files', 'index.ts'), 'utf8');

  // The retention rule lives in the database, in one place, so it can be tested
  // on its own against real dates.
  assert.match(source, /rpc\('project_files_due'/, 'the function must ask which files are due, not work it out itself');
  assert.ok(!/interval|14 \* 24|posted_at/.test(source), 'the fortnight belongs in the database, not in two places');

  // Deleting the row leaves the bytes in the bucket, still counted against a
  // shared quota and now unreachable. Only the Storage API really removes one.
  assert.match(source, /storage\.from\(BUCKET\)\.remove/);
  const files = source.indexOf('.remove(paths)');
  const rows = source.indexOf("from('project_items').delete()");
  assert.ok(files !== -1 && rows !== -1 && files < rows,
    'files must go before rows, or a half-failure leaves files nothing points at');

  // It runs as the service role for the schedule, which bypasses every policy.
  assert.match(source, /startsWith\(prefix\)/, 'a path outside this user\'s prefix must be left alone');
  assert.match(source, /\.eq\('user_id', caller\.userId\)/, 'the owner filter has to be explicit');
});

test('CORS never answers an origin it was not told about', () => {
  const source = fs.readFileSync(path.join(FUNCTIONS, '_shared', 'cors.ts'), 'utf8');
  // A wildcard origin would let any website call this with your session. There
  // is no legitimate "*" in this file, so look for the string itself rather
  // than for one particular way of writing the assignment — an earlier version
  // of this check only matched `header: '*'` and missed `header = '*'`.
  const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const wildcards = [...code.matchAll(/['"`]\*['"`]/g)];
  assert.equal(wildcards.length, 0, 'a wildcard origin would let any website call this with your session');
  assert.match(source, /ALLOWED_ORIGINS/, 'the deployed site address comes from a secret');
  assert.match(source, /Vary/, 'responses differ by origin, so they must not be cached across origins');
  assert.match(source, /allowedOrigins\(\)\.includes\(origin\)/);
});

test('the token path sets the owner itself and checks the allowlist', () => {
  const source = fs.readFileSync(path.join(FUNCTIONS, '_shared', 'auth.ts'), 'utf8');
  // The service role bypasses RLS, so both of the things RLS would have done
  // have to be visible here.
  assert.match(source, /allowed_users/, 'the service role skips the allowlist gate unless it is checked by hand');
  assert.match(source, /user_id: caller\.userId|userId: caller\.userId/, 'rows must carry an explicit owner');
  assert.match(source, /last_used_at/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  // A project can have the legacy anon/service_role keys switched off, and
  // this one does. Supabase injects both sets, so the new ones come first.
  assert.match(source, /SUPABASE_PUBLISHABLE_KEYS/, 'the legacy anon key fails outright when legacy keys are disabled');
  assert.match(source, /SUPABASE_SECRET_KEYS/);
  const publishableFirst = source.indexOf('SUPABASE_PUBLISHABLE_KEYS') < source.indexOf("SUPABASE_ANON_KEY'))");
  assert.ok(publishableFirst, 'the new key must be preferred, with the legacy one only as a fallback');
  // The service key must never be handed to a client built from a user's JWT.
  const userClient = source.slice(source.indexOf('function userClient'), source.indexOf('function serviceClient'));
  assert.ok(!/serviceKey/.test(userClient), 'the user client must never be built with the service key');
  assert.match(source, /db: \{ schema: SCHEMA \}/, 'every client must target the viralradar schema');
});
