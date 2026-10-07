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
  // The service key must never be handed to a client built from a user's JWT.
  const userClient = source.slice(source.indexOf('function userClient'), source.indexOf('function serviceClient'));
  assert.ok(!/serviceKey/.test(userClient), 'the user client must never be built with the service key');
  assert.match(source, /db: \{ schema: SCHEMA \}/, 'every client must target the viralradar schema');
});
