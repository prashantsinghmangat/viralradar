// Asking an AI provider for something, and getting usable JSON back.
//
// Two providers, tried in the order Settings says. They are different enough in
// their request and response shapes to be worth writing out, and similar enough
// that everything after the call is shared: force JSON, strip whatever fencing
// came back anyway, and if it still will not parse, hand it back and ask for it
// to be fixed.
//
// What fails, and what is done about it:
//   no key           skip the provider entirely, without counting an attempt
//   429 or 5xx       wait, try once more, then move to the next provider
//   4xx otherwise    the request itself is wrong; moving on would not help,
//                    but the next provider might, so move on without retrying
//   unparseable      one repair attempt with the same provider, then give up
//
// `fetch` is injected so every one of those paths is tested without a key and
// without the network.

import { extractJson, fixJsonPrompt } from './prompts.mjs';

export const PROVIDERS = ['gemini', 'openrouter'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** Turn a failed HTTP response into something that says whether retrying helps. */
async function failureOf(response, provider) {
  let detail = '';
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message || parsed?.error || parsed?.message || '';
    } catch {
      detail = body.slice(0, 200);
    }
  } catch { /* nothing readable */ }

  const retryable = response.status === 429 || response.status >= 500;
  const quota = response.status === 429 || /quota|rate.?limit|exhausted/i.test(String(detail));
  const message = quota
    ? `${provider} has hit its limit for now${detail ? `: ${detail}` : ''}`
    : `${provider} refused the request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`;
  return new ProviderError(message, { status: response.status, retryable });
}

const CALLERS = {
  async gemini({ apiKey, model, prompt, fetchImpl, timeoutMs }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await withTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
      }),
    }, timeoutMs);

    if (!response.ok) throw await failureOf(response, 'Gemini');
    const body = await response.json();
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('') ?? '';
    if (!text) {
      // Usually a safety block, which has its own shape and no text at all.
      const why = body?.promptFeedback?.blockReason || body?.candidates?.[0]?.finishReason || 'no reason given';
      throw new ProviderError(`Gemini returned nothing (${why})`);
    }
    return text;
  },

  async openrouter({ apiKey, model, prompt, fetchImpl, timeoutMs, referer }) {
    const response = await withTimeout(fetchImpl, 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // OpenRouter asks callers to identify themselves; it is not a secret.
        'HTTP-Referer': referer || 'https://ytshortradar.netlify.app',
        'X-Title': 'ViralRadar',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.9,
      }),
    }, timeoutMs);

    if (!response.ok) throw await failureOf(response, 'OpenRouter');
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    if (!text) throw new ProviderError(`OpenRouter returned nothing (${body?.choices?.[0]?.finish_reason || 'no reason given'})`);
    return text;
  },
};

async function withTimeout(fetchImpl, url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new ProviderError(`took longer than ${Math.round(timeoutMs / 1000)} seconds`, { retryable: true });
    throw new ProviderError(e?.message || 'could not be reached', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One provider, retried while retrying could plausibly help.
 *
 * Free tiers are spiky rather than down: sampling the Gemini models one
 * afternoon gave 503 "high demand" on one call in four for some of them, and
 * the same model answered fine seconds later. One quick retry was not enough to
 * ride that out, so it waits longer each time.
 */
async function askOnce(provider, options) {
  const retries = options.retries ?? 2;
  const backoff = options.backoffMs ?? 1500;

  for (let attempt = 0; ; attempt++) {
    try {
      return await CALLERS[provider](options);
    } catch (e) {
      if (!e.retryable || attempt >= retries) throw e;
      await sleep(backoff * (attempt + 1));
    }
  }
}

/**
 * Ask for JSON, and insist on getting it.
 *
 * Providers are told to return JSON and usually do. When one does not — a stray
 * ``` fence, a sentence in front of it — extractJson handles it. Only when that
 * also fails is the provider asked to repair its own output, once.
 */
async function askForJson(provider, options) {
  const raw = await askOnce(provider, options);
  try {
    return { value: extractJson(raw), repaired: false };
  } catch {
    const fixed = await askOnce(provider, { ...options, prompt: fixJsonPrompt(raw) });
    return { value: extractJson(fixed), repaired: true };
  }
}

/**
 * Try each provider in order until one answers.
 *
 * @param {object} o
 * @param {string}   o.prompt
 * @param {string[]} o.order     provider names, most preferred first
 * @param {object}   o.keys      { gemini, openrouter } — missing means skip
 * @param {object}   o.models    { gemini, openrouter }
 * @returns {Promise<{ value, provider, model, repaired, skipped, attempts }>}
 */
export async function generateJson({
  prompt,
  order = PROVIDERS,
  keys = {},
  models = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 45000,
  backoffMs = 1500,
  referer,
}) {
  const wanted = order.filter((name) => CALLERS[name]);
  if (!wanted.length) throw new Error('No AI provider is set up. Check the provider order in Settings.');

  const attempts = [];
  const skipped = [];

  for (const provider of wanted) {
    const apiKey = (keys[provider] ?? '').trim();
    if (!apiKey) {
      // Not a failure: a provider with no key on the server is simply not set up.
      skipped.push(provider);
      continue;
    }
    const model = (models[provider] ?? '').trim();
    if (!model) {
      attempts.push({ provider, error: 'no model name is set in Settings' });
      continue;
    }

    try {
      const { value, repaired } = await askForJson(provider, { apiKey, model, prompt, fetchImpl, timeoutMs, backoffMs, referer });
      return { value, provider, model, repaired, skipped, attempts };
    } catch (e) {
      attempts.push({ provider, model, error: e.message });
    }
  }

  if (!attempts.length) {
    throw new Error(`No AI key is set for ${skipped.join(' or ')}. See the README for how to add one.`);
  }
  // Every provider that could be tried has failed; say what each one said.
  throw new Error(`Could not write that. ${attempts.map((a) => `${a.provider}: ${a.error}`).join('. ')}`);
}

/** A tiny request to each provider, for the Test AI button. */
export async function testProviders({ order = PROVIDERS, keys = {}, models = {}, fetchImpl = globalThis.fetch, timeoutMs = 20000, referer }) {
  const results = [];
  for (const provider of order.filter((name) => CALLERS[name])) {
    const apiKey = (keys[provider] ?? '').trim();
    const model = (models[provider] ?? '').trim();

    if (!apiKey) { results.push({ name: provider, ok: false, model, detail: 'no key set on the server' }); continue; }
    if (!model) { results.push({ name: provider, ok: false, model, detail: 'no model name set in Settings' }); continue; }

    const started = Date.now();
    try {
      const { value } = await askForJson(provider, {
        apiKey, model, fetchImpl, timeoutMs, backoffMs: 500,
        referer,
        prompt: 'Reply with exactly this JSON and nothing else: {"ok": true}',
      });
      const ok = value && typeof value === 'object';
      results.push({ name: provider, ok: Boolean(ok), model, detail: ok ? `answered in ${Date.now() - started}ms` : 'answered, but not with JSON' });
    } catch (e) {
      results.push({ name: provider, ok: false, model, detail: e.message });
    }
  }
  return results;
}
