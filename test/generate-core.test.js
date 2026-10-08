// Tests for shared/generate-core.mjs — talking to the AI providers.
//
// fetch is stubbed throughout, so these run with no key and no network. That
// matters more here than elsewhere: the interesting behaviour is all failure —
// a provider out of quota, one that returns prose instead of JSON, one that
// never answers — and none of it can be produced on demand from a real API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateJson, testProviders, PROVIDERS } = require('../shared/generate-core.mjs');

const KEYS = { gemini: 'g-key', openrouter: 'o-key' };
const MODELS = { gemini: 'gemini-2.5-flash', openrouter: 'meta-llama/llama-3.3-70b-instruct:free' };
const BASE = { prompt: 'write something', keys: KEYS, models: MODELS, backoffMs: 1 };

const geminiSays = (text) => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
});
const openrouterSays = (text) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: text } }] }),
});
const fails = (status, body = {}) => ({
  ok: false, status,
  text: async () => JSON.stringify(body),
});

/** Records every call, and answers from a list of handlers in order. */
function stub(handlers) {
  const calls = [];
  const queue = [...handlers];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: options?.body ? JSON.parse(options.body) : null });
    const next = queue.shift();
    if (!next) throw new Error('the stub ran out of answers');
    return typeof next === 'function' ? next(String(url), options) : next;
  };
  return { fetchImpl, calls };
}

const which = (url) => (url.includes('googleapis') ? 'gemini' : url.includes('openrouter') ? 'openrouter' : 'other');

test('the first provider in the order is the one that gets asked', async () => {
  const s = stub([geminiSays('{"items":[{"title":"one"}]}')]);
  const out = await generateJson({ ...BASE, order: ['gemini', 'openrouter'], fetchImpl: s.fetchImpl });

  assert.equal(out.provider, 'gemini');
  assert.equal(out.model, MODELS.gemini);
  assert.deepEqual(out.value, { items: [{ title: 'one' }] });
  assert.equal(s.calls.length, 1, 'a provider that answers should end it');
  assert.equal(which(s.calls[0].url), 'gemini');
});

test('the order in Settings is obeyed, not the built-in one', async () => {
  const s = stub([openrouterSays('{"ok":true}')]);
  const out = await generateJson({ ...BASE, order: ['openrouter', 'gemini'], fetchImpl: s.fetchImpl });
  assert.equal(out.provider, 'openrouter');
  assert.equal(which(s.calls[0].url), 'openrouter');
});

test('a provider out of quota is retried once, then handed over to the next', async () => {
  // This is the case the whole fallback exists for: Gemini's free tier runs out
  // partway through a day.
  const s = stub([
    fails(429, { error: { message: 'Quota exceeded for this model' } }),
    fails(429, { error: { message: 'Quota exceeded for this model' } }),
    fails(429, { error: { message: 'Quota exceeded for this model' } }),
    openrouterSays('{"items":[]}'),
  ]);
  const out = await generateJson({ ...BASE, order: ['gemini', 'openrouter'], fetchImpl: s.fetchImpl });

  assert.equal(out.provider, 'openrouter', 'the work still got done');
  assert.equal(s.calls.length, 4, 'three attempts at Gemini, then OpenRouter');
  assert.deepEqual(s.calls.map((c) => which(c.url)), ['gemini', 'gemini', 'gemini', 'openrouter']);
  assert.match(out.attempts[0].error, /hit its limit/, 'and the reason is kept, for showing');
});

test('a server error is retried; a bad request is not', async () => {
  // A free tier under load answers 503 and then answers fine moments later,
  // so it is worth waiting through more than one of those.
  const retried = stub([fails(503), fails(503), geminiSays('{"ok":true}')]);
  const out503 = await generateJson({ ...BASE, order: ['gemini'], fetchImpl: retried.fetchImpl });
  assert.equal(out503.provider, 'gemini', 'it should get there in the end');
  assert.equal(retried.calls.length, 3);

  // A 400 means the request itself is wrong. Sending it again changes nothing,
  // so move straight on rather than making the person wait twice.
  const notRetried = stub([fails(400, { error: { message: 'model not found' } }), openrouterSays('{"ok":true}')]);
  const out = await generateJson({ ...BASE, order: ['gemini', 'openrouter'], fetchImpl: notRetried.fetchImpl });
  assert.equal(notRetried.calls.length, 2, 'one try at Gemini, then OpenRouter');
  assert.equal(out.provider, 'openrouter');
  assert.match(out.attempts[0].error, /model not found/);
});

test('a provider with no key is skipped, not failed', async () => {
  const s = stub([openrouterSays('{"ok":true}')]);
  const out = await generateJson({
    ...BASE, order: ['gemini', 'openrouter'], keys: { openrouter: 'o-key' }, fetchImpl: s.fetchImpl,
  });
  assert.equal(out.provider, 'openrouter');
  assert.deepEqual(out.skipped, ['gemini'], 'not set up is different from broken');
  assert.deepEqual(out.attempts, [], 'and it should not be reported as a failure');
  assert.equal(s.calls.length, 1, 'no request should be made without a key');
});

test('with no keys at all, the message says so rather than blaming the providers', async () => {
  const s = stub([]);
  await assert.rejects(
    () => generateJson({ ...BASE, keys: {}, fetchImpl: s.fetchImpl }),
    /No AI key is set for gemini or openrouter/,
  );
  assert.equal(s.calls.length, 0);
});

test('when every provider fails, the message says what each one said', async () => {
  const s = stub([
    fails(400, { error: { message: 'model not found' } }),
    fails(401, { error: { message: 'invalid key' } }),
  ]);
  await assert.rejects(
    () => generateJson({ ...BASE, order: ['gemini', 'openrouter'], fetchImpl: s.fetchImpl }),
    (e) => /gemini.*model not found/s.test(e.message) && /openrouter.*invalid key/s.test(e.message),
  );
});

test('JSON wrapped in fences or prose is still read', async () => {
  for (const wrapped of [
    '```json\n{"items":[1]}\n```',
    'Sure! Here is the JSON:\n{"items":[1]}\nHope that helps.',
    '\n\n{"items":[1]}',
  ]) {
    const s = stub([geminiSays(wrapped)]);
    const out = await generateJson({ ...BASE, order: ['gemini'], fetchImpl: s.fetchImpl });
    assert.deepEqual(out.value, { items: [1] });
    assert.equal(out.repaired, false, 'this needed no repair, only unwrapping');
    assert.equal(s.calls.length, 1);
  }
});

test('output that will not parse is sent back once to be fixed', async () => {
  const s = stub([geminiSays('{"items": [1,]}  <- oops'), geminiSays('{"items":[1]}')]);
  const out = await generateJson({ ...BASE, order: ['gemini'], fetchImpl: s.fetchImpl });

  assert.deepEqual(out.value, { items: [1] });
  assert.equal(out.repaired, true);
  assert.equal(s.calls.length, 2);
  // The repair prompt must contain the broken text, or there is nothing to fix.
  const repair = s.calls[1].body.contents[0].parts[0].text;
  assert.match(repair, /\{"items": \[1,\]\}/);
  assert.match(repair, /Return ONLY the corrected JSON/);
});

test('output that will not parse even after a repair moves to the next provider', async () => {
  const s = stub([geminiSays('not json'), geminiSays('still not json'), openrouterSays('{"ok":true}')]);
  const out = await generateJson({ ...BASE, order: ['gemini', 'openrouter'], fetchImpl: s.fetchImpl });
  assert.equal(out.provider, 'openrouter');
  assert.match(out.attempts[0].error, /did not return JSON/);
});

test('a request that never answers is given up on, and counted as retryable', async () => {
  const timeout = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  // One try plus two retries before moving on.
  const s = stub([timeout, timeout, timeout, openrouterSays('{"ok":true}')]);
  const out = await generateJson({ ...BASE, order: ['gemini', 'openrouter'], fetchImpl: s.fetchImpl, timeoutMs: 10 });
  assert.equal(out.provider, 'openrouter');
  assert.match(out.attempts[0].error, /longer than/);
});

test('each provider is asked the way it expects', async () => {
  const s = stub([geminiSays('{"ok":true}'), openrouterSays('{"ok":true}')]);
  await generateJson({ ...BASE, order: ['gemini'], fetchImpl: s.fetchImpl });
  await generateJson({ ...BASE, order: ['openrouter'], fetchImpl: s.fetchImpl });

  const [gemini, openrouter] = s.calls;
  // The key goes in a header, never in the URL, where it would end up in logs.
  assert.ok(!gemini.url.includes('g-key'), 'the Gemini key must not be in the query string');
  assert.equal(gemini.options.headers['x-goog-api-key'], 'g-key');
  assert.ok(gemini.url.includes(MODELS.gemini));
  assert.equal(gemini.body.generationConfig.responseMimeType, 'application/json', 'ask for JSON rather than hoping');

  assert.equal(openrouter.options.headers.Authorization, 'Bearer o-key');
  assert.equal(openrouter.body.model, MODELS.openrouter);
  assert.deepEqual(openrouter.body.response_format, { type: 'json_object' });
  assert.ok(openrouter.options.headers['HTTP-Referer'], 'OpenRouter asks callers to identify themselves');
});

test('a provider that answers with nothing says why', async () => {
  // Gemini returns no text at all when it blocks a prompt, which otherwise
  // looks exactly like a successful empty answer.
  const blocked = { ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }) };
  const s = stub([blocked, openrouterSays('{"ok":true}')]);
  const out = await generateJson({ ...BASE, order: ['gemini', 'openrouter'], fetchImpl: s.fetchImpl });

  assert.match(out.attempts[0].error, /returned nothing \(SAFETY\)/);
  assert.equal(out.provider, 'openrouter');
  // Asking again would be blocked again, so it is tried once and handed on.
  assert.equal(s.calls.length, 2);
});

test('a provider with no model name set is reported, not silently skipped', async () => {
  const s = stub([openrouterSays('{"ok":true}')]);
  const out = await generateJson({
    ...BASE, order: ['gemini', 'openrouter'], models: { openrouter: MODELS.openrouter }, fetchImpl: s.fetchImpl,
  });
  assert.equal(out.provider, 'openrouter');
  assert.match(out.attempts[0].error, /no model name/);
});

// ---------- Test AI ----------

test('the Test AI button reports every provider, working or not', async () => {
  const s = stub([geminiSays('{"ok":true}'), fails(401, { error: { message: 'invalid key' } })]);
  const results = await testProviders({ order: ['gemini', 'openrouter'], keys: KEYS, models: MODELS, fetchImpl: s.fetchImpl });

  assert.equal(results.length, 2);
  assert.equal(results[0].name, 'gemini');
  assert.equal(results[0].ok, true);
  assert.match(results[0].detail, /answered in \d+ms/);
  assert.equal(results[1].ok, false);
  assert.match(results[1].detail, /invalid key/);
  assert.equal(results[1].model, MODELS.openrouter, 'the model is shown either way, so a typo is visible');
});

test('Test AI says plainly when a provider is simply not set up', async () => {
  const s = stub([]);
  const results = await testProviders({ order: ['gemini', 'openrouter'], keys: {}, models: MODELS, fetchImpl: s.fetchImpl });
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.match(r.detail, /no key set on the server/);
  }
  assert.equal(s.calls.length, 0, 'there is nothing to ask');
});

test('the provider list is the two that are actually implemented', () => {
  assert.deepEqual(PROVIDERS, ['gemini', 'openrouter']);
});

test('a provider name that does not exist is ignored rather than crashing', async () => {
  // ai_order is free text in Settings, so it can contain anything.
  const s = stub([geminiSays('{"ok":true}')]);
  const out = await generateJson({ ...BASE, order: ['claude', 'gemini'], fetchImpl: s.fetchImpl });
  assert.equal(out.provider, 'gemini');

  await assert.rejects(
    () => generateJson({ ...BASE, order: ['claude'], fetchImpl: stub([]).fetchImpl }),
    /No AI provider is set up/,
  );
});

test('retrying gives up eventually rather than hammering a provider', async () => {
  const s = stub(Array.from({ length: 8 }, () => fails(503)));
  await assert.rejects(() => generateJson({ ...BASE, order: ['gemini'], fetchImpl: s.fetchImpl }), /Could not write that/);
  assert.equal(s.calls.length, 3, 'one try plus two retries, then stop');
});

test('each retry waits longer than the last', async () => {
  const waits = [];
  let last = Date.now();
  const s = stub([
    () => { last = Date.now(); return fails(503); },
    () => { waits.push(Date.now() - last); last = Date.now(); return fails(503); },
    () => { waits.push(Date.now() - last); return geminiSays('{"ok":true}'); },
  ]);
  await generateJson({ ...BASE, order: ['gemini'], fetchImpl: s.fetchImpl, backoffMs: 40 });
  assert.equal(waits.length, 2);
  assert.ok(waits[1] > waits[0], `backing off should lengthen, got ${waits.join('ms, ')}ms`);
});
