// vr-generate: ask an AI for ideas, a script, or an edit plan.
//
//   POST /functions/v1/vr-generate
//   Authorization: Bearer <user JWT>
//   Body: { kind: "ideas" | "script" | "edit_plan" | "test", ... }
//
// This function exists only because of the API keys. They are read from its
// environment and never leave it — not to the browser, not to the phone, not
// into the database. Everything else here could have lived in the page.
//
// What comes back is turned into a Shorts Studio export and run through the
// same import path the Import screen uses, so a generated idea and an imported
// one are the same thing by the time they reach a table, with `source` saying
// which provider wrote it.

import { authenticate, AuthError } from '../_shared/auth.ts';
import { corsHeaders, json, preflight } from '../_shared/cors.ts';
import { generateJson, testProviders } from '../_shared/core/generate-core.mjs';
import { ideasPrompt, scriptPrompt, editPlanPrompt } from '../_shared/core/prompts.mjs';
import { runImport } from '../_shared/core/import-core.mjs';
import { istDay } from '../_shared/core/time.mjs';
import {
  DEFAULT_AI_ORDER, DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL,
  DEFAULT_KEYWORDS, DEFAULT_LANGUAGE, DEFAULT_LENGTH,
} from '../_shared/core/defaults.mjs';

const KINDS = ['ideas', 'script', 'edit_plan', 'test'];

const keys = () => ({
  gemini: Deno.env.get('GEMINI_API_KEY') ?? '',
  openrouter: Deno.env.get('OPENROUTER_API_KEY') ?? '',
});

/** A readable, unique id for something nobody imported. */
const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

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
    keywords: Array.isArray(data?.niche_keywords) && data.niche_keywords.length
      ? data.niche_keywords : DEFAULT_KEYWORDS,
  };
}

/** The storage runImport expects, over the signed-in user's own client. */
function storeFor(client: { from: Function }, userId: string) {
  return {
    userId,
    async findExisting(table: string, ids: string[]) {
      if (!ids.length) return [];
      const { data, error } = await client.from(table).select('id').eq('user_id', userId).in('id', ids);
      if (error) throw new Error(`Could not read your ${table}: ${error.message}`);
      return (data ?? []).map((r: { id: string }) => r.id);
    },
    async upsert(table: string, rows: Record<string, unknown>[]) {
      if (!rows.length) return;
      const { error } = await client.from(table).upsert(rows, { onConflict: 'user_id,id' });
      if (error) throw new Error(`Could not save your ${table}: ${error.message}`);
    },
  };
}

/** Every AI call is counted, so Settings can show what has been used. */
async function countCall(client: { rpc: Function }, userId: string, provider: string) {
  const { error } = await client.rpc('add_usage', {
    p_user_id: userId, p_provider: provider, p_units: 0, p_requests: 1,
  });
  if (error) console.warn(`[vr-generate] could not count the call: ${error.message}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Use POST.' }, 405);

  let caller;
  try {
    caller = await authenticate(req);
  } catch (e) {
    if (e instanceof AuthError) return json(req, { ok: false, error: e.message }, e.status);
    console.error('[vr-generate] auth failed', e);
    return json(req, { ok: false, error: 'Could not check who you are.' }, 503);
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return json(req, { ok: false, error: 'The request body is not valid JSON.' }, 400);
  }

  const kind = String(body.kind ?? '');
  if (!KINDS.includes(kind)) {
    return json(req, { ok: false, error: `Unknown kind ${JSON.stringify(kind)}. Expected one of: ${KINDS.join(', ')}.` }, 400);
  }

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
    // ---- is the AI set up at all? ----
    if (kind === 'test') {
      return json(req, { ok: true, providers: await testProviders({ ...ask, timeoutMs: 20000 }) });
    }

    const language = String(body.language || settings.language);
    const length = String(body.length || settings.length);

    // ---- an edit plan for a script that already exists ----
    if (kind === 'edit_plan') {
      const scriptId = String(body.script_id ?? '');
      if (!scriptId) return json(req, { ok: false, error: 'Which script? No script_id was sent.' }, 400);

      const { data: script, error } = await client.from('scripts').select('*').eq('id', scriptId).maybeSingle();
      if (error) return json(req, { ok: false, error: `Could not open that script: ${error.message}` }, 500);
      if (!script) return json(req, { ok: false, error: 'That script is no longer there.' }, 404);

      const result = await generateJson({ ...ask, prompt: editPlanPrompt({ script, language, length, today }) });
      await countCall(client, userId, result.provider);

      // The plan lives inside raw, where an imported one lives, so one piece of
      // code reads both. Everything else in raw is left exactly as it was.
      const raw = { ...(script.raw ?? {}), edit_plan: result.value };
      const { error: saveError } = await client.from('scripts').update({ raw }).eq('id', scriptId);
      if (saveError) return json(req, { ok: false, error: `Could not save the edit plan: ${saveError.message}` }, 500);

      console.log(`[vr-generate] edit_plan for ${scriptId} by ${result.provider}`);
      return json(req, { ok: true, kind, provider: result.provider, model: result.model, script_id: scriptId, edit_plan: result.value });
    }

    // ---- ideas, or a script ----
    const prompt = kind === 'ideas'
      ? ideasPrompt({
        keywords: Array.isArray(body.keywords) && body.keywords.length ? body.keywords : settings.keywords,
        language,
        length,
        count: Math.min(Math.max(Number(body.count) || 6, 1), 12),
        today,
      })
      : scriptPrompt({ topic: String(body.topic ?? '').trim(), language, length, today });

    if (kind === 'script' && !String(body.topic ?? '').trim()) {
      return json(req, { ok: false, error: 'What should the script be about? No topic was sent.' }, 400);
    }

    const result = await generateJson({ ...ask, prompt });
    await countCall(client, userId, result.provider);

    const items = Array.isArray(result.value?.items) ? result.value.items
      : Array.isArray(result.value) ? result.value
        : [result.value];
    if (!items.length || !items[0]) {
      return json(req, { ok: false, error: `${result.provider} replied, but with nothing usable in it. Try again.` }, 502);
    }

    // Ids are assigned here, never by the model: it has no idea what already
    // exists, and a collision would overwrite real work.
    const prefix = kind === 'ideas' ? 'idea' : 'scr';
    const stamped = items.slice(0, 12).map((item: Record<string, unknown>) => ({
      ...item,
      id: newId(prefix),
      source: result.provider,
      ...(kind === 'ideas' ? { date: item.date || today } : { created_at: new Date().toISOString() }),
    }));

    // Through the same path as an import, so there is one way rows are written.
    const imported = await runImport(
      { app: 'shorts-studio', schema: 1, type: kind === 'ideas' ? 'ideas' : 'script', exported_at: new Date().toISOString(), items: stamped },
      storeFor(client, userId),
    );

    console.log(`[vr-generate] ${kind} by ${result.provider}: ${imported.message}`);
    return json(req, {
      ok: true,
      kind,
      provider: result.provider,
      model: result.model,
      repaired: result.repaired,
      count: stamped.length,
      ids: stamped.map((i: { id: string }) => i.id),
      message: imported.message,
    });
  } catch (e) {
    const message = (e as Error).message ?? 'Something went wrong.';
    console.error('[vr-generate] failed', e);
    // The provider messages are already written for a person to read.
    const expected = /No AI key|Could not write that|No AI provider/.test(message);
    return json(req, { ok: false, error: message }, expected ? 502 : 500);
  }
});

export { corsHeaders };
