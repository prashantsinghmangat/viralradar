// A deployed Edge Function only receives the files under supabase/functions/,
// so the shared modules are copied in there by scripts/sync-shared.mjs. A copy
// can drift from its original, which would mean the deployed function quietly
// behaved differently from everything the other tests check.
//
// These tests make that impossible to do by accident: the suite fails until the
// copy matches, naming the command that fixes it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'supabase', 'functions');

test('the copy of shared/ inside supabase/functions is up to date', async () => {
  const { drift, sharedFiles } = await import('../scripts/sync-shared.mjs');
  const stale = drift();
  assert.deepEqual(stale, [], `out of date. Run: npm run sync:shared\n  ${stale.join('\n  ')}`);
  assert.ok(sharedFiles().length >= 10, 'expected the shared modules to be listed');
});

test('the copies match the originals, apart from a header', async () => {
  const { sharedFiles, SOURCE_DIR, TARGET_DIR } = await import('../scripts/sync-shared.mjs');
  // Line endings are not part of the comparison: git rewrites them on checkout
  // on Windows, which would otherwise report every file as drifted.
  const text = (s) => s.split(String.fromCharCode(13)).join('');
  for (const relative of sharedFiles()) {
    const original = text(fs.readFileSync(path.join(SOURCE_DIR, relative), 'utf8'));
    const copy = text(fs.readFileSync(path.join(TARGET_DIR, relative), 'utf8'));
    assert.ok(copy.startsWith('// GENERATED FILE - DO NOT EDIT.'), `${relative}: the copy has no warning header`);
    assert.ok(copy.endsWith(original), `${relative}: the copy differs from the original`);
  }
});

test('no function reaches outside supabase/functions for code', () => {
  // "../../.." would climb out of the folder that actually gets deployed, so
  // the function would work locally and fail once deployed.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue; // jsr:, npm:, https: are fine
        const resolved = path.resolve(path.dirname(full), spec);
        if (!resolved.startsWith(FUNCTIONS)) {
          offenders.push(`${path.relative(ROOT, full)} imports ${spec}`);
        }
      }
    }
  };
  walk(FUNCTIONS);
  assert.deepEqual(offenders, [], `these imports would not survive deployment:\n  ${offenders.join('\n  ')}`);
});

test('every relative import inside the functions folder points at a file that exists', () => {
  const missing = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|mjs|js)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(full), m[1]);
        if (!fs.existsSync(target)) missing.push(`${path.relative(ROOT, full)} -> ${m[1]}`);
      }
    }
  };
  walk(FUNCTIONS);
  assert.deepEqual(missing, [], `broken imports:\n  ${missing.join('\n  ')}`);
});

test('the generated copies are not edited by hand', async () => {
  // If someone edits the copy instead of the original, the next sync silently
  // throws their change away. The header says so, and this check backs it up.
  const { TARGET_DIR, sharedFiles } = await import('../scripts/sync-shared.mjs');
  for (const relative of sharedFiles(TARGET_DIR)) {
    const text = fs.readFileSync(path.join(TARGET_DIR, relative), 'utf8');
    assert.match(text, /npm run sync:shared/, `${relative}: the header telling people where to edit is gone`);
  }
});
