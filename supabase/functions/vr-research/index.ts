// vr-research: read the live pages, then write the pack.
//
//   POST /functions/v1/vr-research
//   Authorization: Bearer <user JWT>
//   Body: { topic, urls?: string[], project_id?: string }
//
// WHY THIS IS A FUNCTION AND NOT THE BROWSER
//   Two reasons, and the second is the real one.
//
//   The AI keys live here. That is the same reason vr-generate exists.
//
//   But the fetching has to be here too: a browser cannot read another site's
//   page. Cross-origin rules stop it, which is the whole point of them. Only
//   something server-side can fetch a tool's homepage and hand the text to a
//   model, and that is what makes this feature possible at all.
//
// WHAT IS ENFORCED HERE RATHER THAN ASKED FOR
//   The prompt says "only state what is in the fetched text". That is an
//   instruction and a model can ignore it. normalisePack() afterwards fixes
//   what can be fixed: `reachable` comes from the fetch, `sources` is what
//   really loaded, and any claim citing a page that did not load is forced to
//   unverified. See shared/research.mjs.

import { authenticate, AuthError } from '../_shared/auth.ts';
import { corsHeaders, json, preflight } from '../_shared/cors.ts';
import { generateJson } from '../_shared/core/generate-core.mjs';
import {
  MAX_CANDIDATES, MAX_URLS,
  candidatesPrompt, cleanUrls, fetchPages, normalisePack, packIsEmpty, researchPrompt,
} from '../_shared/core/research.mjs';
import { istDay } from '../_shared/core/time.mjs';
import {
  DEFAULT_AI_ORDER, DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL,
  DEFAULT_LANGUAGE, DEFAULT_LENGTH,
} from '../_shared/core/defaults.mjs';

const keys = () => ({
  gemini: Deno.env.get('GEMINI_API_KEY') ?? '',
  openrouter: Deno.env.get('OPENROUTER_API_KEY') ?? '',
});

/** Settings, with every gap filled, so a half-filled row cannot break a run. */
async function settingsFor(client: { from: Function }, userId: string) {
  const { data } = await client.from('settings').select('*').eq('user_id', userId).maybeSingle();
  const order = Array.isArray(data?.ai_order) && data.ai_order.length ? data.ai_order : DEFAULT_AI_ORDER;
  return {
    order,
    models: {
      gemini: (data?.gemini_model || DEFAULT_GEMINI_MODEL).trim(),
      openrouter: (data?.openrouter_model || DEFAULT_OPENROUTER_MODEL).trim(),
    },
    language: (data?.language || DEFAULT_LANGUAGE).trim(),
    length: (data?.default_length || DEFAULT_LENGTH).trim(),
  };
}

async function countCall(client: { rpc: Function }, userId: string, provider: string) {
  const { error } = await client.rpc('add_usage', {
    p_user_id: userId, p_provider: provider, p_units: 0, p_requests: 1,
  });
  if (error) console.warn(`[vr-research] could not count the call: ${error.message}`);
}

/**
 * Candidate URLs from a free-tier search API, if one is configured.
 *
 * Skipped silently when SEARCH_API_KEY is not set, which is the normal state:
 * the feature works without it, just with the AI's own candidates instead of
 * search results. A search that fails is also silent — it is a way of finding
 * URLs, not a requirement.
 */
async function searchForUrls(topic: string): Promise<string[]> {
  const key = Deno.env.get('SEARCH_API_KEY') ?? '';
  if (!key) return [];
  const endpoint = Deno.env.get('SEARCH_API_URL') ?? 'https://api.search.brave.com/res/v1/web/search';
  try {
    const url = new URL(endpoint);
    url.searchParams.set('q', topic);
    url.searchParams.set('count', String(MAX_CANDIDATES));
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.warn(`[vr-research] search answered ${response.status}; carrying on without it`);
      return [];
    }
    const body = await response.json();
    // Two common shapes, so swapping provider does not mean a code change.
    const results = body?.web?.results ?? body?.results ?? body?.organic_results ?? [];
    return cleanUrls(
      (Array.isArray(results) ? results : []).map((r: Record<string, unknown>) => r?.url ?? r?.link),
      MAX_CANDIDATES,
    );
  } catch (e) {
    console.warn(`[vr-research] search skipped: ${(e as Error).message}`);
    return [];
  }
}

/** Candidate tools from the AI, as names and URLs only — never as facts. */
async function askForCandidates(ask: Record<string, unknown>, topic: string, language: string, today: string) {
  try {
    const result = await generateJson({ ...ask, prompt: candidatesPrompt({ topic, language, today }) });
    const list = Array.isArray(result.value?.candidates) ? result.value.candidates
      : Array.isArray(result.value) ? result.value : [];
    const urls = cleanUrls(list.map((c: Record<string, unknown>) => c?.url), MAX_CANDIDATES);
    const names = list.map((c: Record<string, unknown>) => String(c?.name ?? '').trim()).filter(Boolean);
    return { urls, names, provider: result.provider };
  } catch (e) {
    console.warn(`[vr-research] could not get candidates: ${(e as Error).message}`);
    return { urls: [], names: [], provider: '' };
  }
}

/**
 * The folder this pack belongs in, made if it is not there.
 *
 * A pack is only useful next to the screenshots and links for the same video,
 * so it goes in a folder rather than a table of its own. Matched by title
 * because that is what a person would recognise; there is no unique index on
 * title, so two packs made at the same moment could make two folders. That is
 * cosmetic, and far better than failing after the pages have been fetched.
 */
async function folderFor(client: { from: Function }, topic: string, given: string) {
  if (given) return given;
  const title = topic.replace(/\s+/g, ' ').trim().slice(0, 120);

  const { data: found } = await client.from('projects').select('id').eq('title', title).limit(1);
  if (found && found.length) return found[0].id;

  const { data: made, error } = await client.from('projects').insert({ title }).select('id');
  if (error) throw new Error(`Could not make a folder for this research: ${error.message}`);
  return made?.[0]?.id ?? '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Use POST.' }, 405);

  let caller;
  try {
    caller = await authenticate(req);
  } catch (e) {
    if (e instanceof AuthError) return json(req, { ok: false, error: e.message }, e.status);
    console.error('[vr-research] auth failed', e);
    return json(req, { ok: false, error: 'Could not check who you are.' }, 503);
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return json(req, { ok: false, error: 'The request body is not valid JSON.' }, 400);
  }

  const topic = String(body.topic ?? '').trim().slice(0, 500);
  if (!topic) return json(req, { ok: false, error: 'What subject? No topic was sent.' }, 400);

  const { client, userId } = caller;
  const settings = await settingsFor(client, userId);
  const today = istDay();
  const ask = {
    order: settings.order,
    keys: keys(),
    models: settings.models,
    referer: req.headers.get('origin') ?? undefined,
  };

  try {
    // ---- which pages to read ----
    //
    // In order of trust: URLs the creator gave (a trend's own link, or pasted),
    // then search results if a key is configured, then the AI's guesses. Only
    // the first of those is known to be about the right thing.
    let urls = cleanUrls(Array.isArray(body.urls) ? body.urls : [], MAX_URLS);
    let candidateNames: string[] = [];
    let from: 'given' | 'search' | 'ai' | 'none' = urls.length ? 'given' : 'none';

    if (!urls.length) {
      const searched = await searchForUrls(topic);
      if (searched.length) {
        urls = searched;
        from = 'search';
      } else {
        const candidates = await askForCandidates(ask, topic, settings.language, today);
        if (candidates.urls.length) {
          urls = candidates.urls;
          candidateNames = candidates.names;
          from = 'ai';
          if (candidates.provider) await countCall(client, userId, candidates.provider);
        }
      }
    }

    if (!urls.length) {
      return json(req, {
        ok: false,
        error: 'Could not find anything to read for this subject. Paste the tool\'s URL and try again.',
      }, 422);
    }

    // ---- read them ----
    const pages = await fetchPages(urls);
    const live = pages.filter((p) => p.reachable);
    console.log(`[vr-research] "${topic.slice(0, 60)}" urls=${from} fetched=${live.length}/${pages.length}`);

    if (!live.length) {
      // Nothing was readable. A pack written now would be entirely invented,
      // which is the one thing this feature must never produce.
      return json(req, {
        ok: false,
        error: pages.length === 1
          ? `Could not read ${pages[0].url} — ${pages[0].error}. Nothing was written, because a pack with no sources would be guesswork.`
          : `None of the ${pages.length} pages could be read. Nothing was written, because a pack with no sources would be guesswork.`,
        unreachable: pages.map((p) => ({ url: p.url, error: p.error })),
      }, 422);
    }

    // ---- write the pack from what was read ----
    const result = await generateJson({
      ...ask,
      prompt: researchPrompt({ topic, pages, language: settings.language, today }),
    });
    await countCall(client, userId, result.provider);

    const pack = normalisePack({ pack: result.value, pages, topic });
    if (packIsEmpty(pack)) {
      return json(req, { ok: false, error: `${result.provider} read the pages but produced nothing usable. Try again.` }, 502);
    }

    // ---- keep it with the video it is for ----
    let projectId = '';
    let itemId = '';
    let saveError = '';
    try {
      projectId = await folderFor(client, topic, String(body.project_id ?? ''));
      const { data: saved, error } = await client.from('project_items').insert({
        project_id: projectId,
        kind: 'research',
        content: JSON.stringify(pack),
        from_device: String(body.from_device ?? '').trim() || null,
      }).select('id');
      if (error) throw new Error(error.message);
      itemId = saved?.[0]?.id ?? '';
    } catch (e) {
      // The pack is the expensive part and it is already written. Losing the
      // row is worth a warning, not throwing the research away.
      saveError = (e as Error).message;
      console.warn(`[vr-research] pack made but not saved: ${saveError}`);
    }

    const verified = pack.verified_count;
    return json(req, {
      ok: true,
      kind: 'research',
      provider: result.provider,
      model: result.model,
      urls_from: from,
      candidate_names: candidateNames,
      project_id: projectId,
      item_id: itemId,
      pack,
      message: `${live.length} of ${pages.length} pages read · ${verified} verified claim${verified === 1 ? '' : 's'}`
        + (pack.downgraded_count ? ` · ${pack.downgraded_count} downgraded` : '')
        + (saveError ? ' · not saved to a folder' : ''),
      ...(saveError ? { warning: `The pack was made but could not be saved: ${saveError}` } : {}),
    });
  } catch (e) {
    const message = (e as Error).message ?? 'Something went wrong.';
    console.error('[vr-research] failed', e);
    const expected = /No AI key|Could not write that|No AI provider/.test(message);
    return json(req, { ok: false, error: message }, expected ? 502 : 500);
  }
});

export { corsHeaders };
