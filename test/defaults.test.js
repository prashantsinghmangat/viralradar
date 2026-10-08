// The defaults exist in two places: shared/defaults.mjs, which the functions and
// the browser read, and the column defaults in the database, which decide what a
// brand new settings row gets.
//
// They drifted once already — the code said gemini-3.5-flash while the column
// still said gemini-flash-latest, so a fresh account got a different model from
// an existing one and only one of them worked. Nothing noticed, because each
// half was correct on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../shared/defaults.mjs');

const ROOT = path.join(__dirname, '..');

/** Every migration joined, so a later one overriding an earlier one is seen. */
const migrations = () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
};

/** What a new row would actually get for a column, after every migration. */
function columnDefault(sql, column) {
  // A later `alter column ... set default` wins over the one in create table.
  const altered = [...sql.matchAll(new RegExp(`alter column ${column} set default '([^']*)'`, 'g'))];
  if (altered.length) return altered[altered.length - 1][1];
  const created = sql.match(new RegExp(`${column}\\s+text not null default '([^']*)'`));
  return created ? created[1] : null;
}

test('the model defaults in the database match the ones in the code', () => {
  const sql = migrations();
  assert.equal(columnDefault(sql, 'gemini_model'), defaults.DEFAULT_GEMINI_MODEL,
    'a new account would get a different Gemini model from the one the code falls back to');
  assert.equal(columnDefault(sql, 'openrouter_model'), defaults.DEFAULT_OPENROUTER_MODEL,
    'a new account would get a different OpenRouter model from the one the code falls back to');
});

test('the other settings defaults match too', () => {
  const sql = migrations();
  assert.equal(columnDefault(sql, 'language'), defaults.DEFAULT_LANGUAGE);
  assert.equal(columnDefault(sql, 'default_length'), defaults.DEFAULT_LENGTH);
});

test('no model known to be dead is still a default anywhere', () => {
  // Each of these was a default once and stopped working without warning.
  const dead = ['gemini-2.5-flash', 'gemini-1.5-flash', 'meta-llama/llama-3.3-70b-instruct:free'];
  const sql = migrations();
  for (const model of dead) {
    assert.notEqual(defaults.DEFAULT_GEMINI_MODEL, model);
    assert.notEqual(defaults.DEFAULT_OPENROUTER_MODEL, model);
    assert.notEqual(columnDefault(sql, 'gemini_model'), model, `${model} is retired but is still the column default`);
    assert.notEqual(columnDefault(sql, 'openrouter_model'), model);
  }
});

test('the default provider order only names providers that exist', async () => {
  const { PROVIDERS } = await import('../shared/generate-core.mjs');
  for (const name of defaults.DEFAULT_AI_ORDER) {
    assert.ok(PROVIDERS.includes(name), `${name} is in the default order but is not implemented`);
  }
  assert.ok(defaults.DEFAULT_AI_ORDER.length >= 2, 'the fallback needs somewhere to fall back to');
});

test('the default length is one the Settings dropdown offers', () => {
  // Otherwise the dropdown shows nothing selected and saving changes it silently.
  assert.ok(defaults.LENGTHS.includes(defaults.DEFAULT_LENGTH),
    `${defaults.DEFAULT_LENGTH} is not in ${defaults.LENGTHS.join(', ')}`);
});

test('an OpenRouter model meant to be free says so in its name', () => {
  // The ":free" suffix is the only thing distinguishing it from the paid slug,
  // and getting it wrong means real money rather than an error.
  assert.match(defaults.DEFAULT_OPENROUTER_MODEL, /:free$/);
});
