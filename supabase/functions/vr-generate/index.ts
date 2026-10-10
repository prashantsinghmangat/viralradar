// vr-generate: ask an AI for ideas, a script, or an edit plan.
//
//   POST /functions/v1/vr-generate
//   Authorization: Bearer <user JWT>
//   Body: { kind: "ideas" | "angles" | "hooks" | "script" | "edit_plan" | "test", ... }
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
import { ideasPrompt, anglesPrompt, hooksPrompt, scriptPrompt, editPlanPrompt, formatScriptPrompt } from '../_shared/core/prompts.mjs';
import { resultsLesson } from '../_shared/core/learning.mjs';
import { runImport } from '../_shared/core/import-core.mjs';
import { istDay } from '../_shared/core/time.mjs';
import { keepsExact } from '../_shared/core/own-idea.mjs';
import {
  DEFAULT_AI_ORDER, DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL,
  DEFAULT_KEYWORDS, DEFAULT_LANGUAGE, DEFAULT_LENGTH,
} from '../_shared/core/defaults.mjs';

const KINDS = ['ideas', 'angles', 'hooks', 'script', 'format_script', 'edit_plan', 'test'];
// A script written straight from the creator's own words, same as 'script'
// everywhere except which prompt builds it and the keep_exact check below.
const SCRIPT_KINDS = ['script', 'format_script'];

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

/**
 * What the creator's own results say, for the prompt to lean on.
 *
 * Read here rather than sent from the browser: the page could be out of date,
 * and a lesson is only as good as the rows it came from. RLS limits this to
 * the caller's own results, so there is nothing to filter by hand.
 *
 * Never worth failing a generation over — a lesson is an improvement, not a
 * requirement, and resultsLesson() returns an inactive one from an empty list.
 */
async function lessonFor(client: { from: Function }, userId: string) {
  try {
    const { data, error } = await client
      .from('results').select('format, hook, len, cta, views, saves').eq('user_id', userId);
    if (error) {
      console.warn(`[vr-generate] could not read results for personalisation: ${error.message}`);
      return resultsLesson([]);
    }
    return resultsLesson(data ?? []);
  } catch (e) {
    console.warn(`[vr-generate] personalisation skipped: ${(e as Error).message}`);
    return resultsLesson([]);
  }
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

      // The script's OWN language, if the sheet set one when it was written —
      // never the account-wide default, and never whatever this particular
      // request happened to send. An edit plan has to match the script it is
      // for, not the language someone was last generating something else in.
      const scriptLanguage = script.language || language;

      const result = await generateJson({ ...ask, prompt: editPlanPrompt({ script, language: scriptLanguage, length, today }) });
      await countCall(client, userId, result.provider);

      // The plan lives inside raw, where an imported one lives, so one piece of
      // code reads both. Everything else in raw is left exactly as it was.
      const raw = { ...(script.raw ?? {}), edit_plan: result.value };
      const { error: saveError } = await client.from('scripts').update({ raw }).eq('id', scriptId);
      if (saveError) return json(req, { ok: false, error: `Could not save the edit plan: ${saveError.message}` }, 500);

      console.log(`[vr-generate] edit_plan for ${scriptId} by ${result.provider}`);
      return json(req, { ok: true, kind, provider: result.provider, model: result.model, script_id: scriptId, edit_plan: result.value });
    }

    // Every remaining kind leans on what has already worked, when there is
    // enough of it to lean on.
    const lesson = await lessonFor(client, userId);
    const topic = String(body.topic ?? '').trim();

    // Verified facts from a Research Pack, when the creator made one for this
    // subject. Only the verified half ever reaches here — the browser sends
    // packSummary(), which drops every unverified claim. Capped because it is
    // creator-supplied text going into a prompt, not because it is untrusted.
    const research = String(body.research ?? '').trim().slice(0, 6000) || null;

    // ---- angles: ways into a subject, before any script exists ----
    //
    // Deliberately not stored. An angle is a choice the creator makes on the
    // way to a script, not an item to keep: writing five of them to the
    // database every time a trend was looked at would fill the Ideas screen
    // with things nobody decided to make.
    if (kind === 'angles') {
      if (!topic) return json(req, { ok: false, error: 'What subject? No topic was sent.' }, 400);

      const result = await generateJson({
        ...ask,
        prompt: anglesPrompt({ topic, language, length, count: Math.min(Math.max(Number(body.count) || 5, 3), 7), today, lesson, research }),
      });
      await countCall(client, userId, result.provider);

      const raw = Array.isArray(result.value?.angles) ? result.value.angles
        : Array.isArray(result.value) ? result.value : [];
      const angles = raw
        .filter((a: Record<string, unknown>) => a && (a.title || a.hook))
        .slice(0, 7)
        .map((a: Record<string, unknown>) => ({
          type: String(a.type ?? '').trim(),
          title: String(a.title ?? '').trim(),
          hook: String(a.hook ?? '').trim(),
          twist: String(a.twist ?? '').trim(),
        }));

      if (!angles.length) {
        return json(req, { ok: false, error: `${result.provider} replied, but with no usable angles in it. Try again.` }, 502);
      }

      console.log(`[vr-generate] angles for "${topic.slice(0, 60)}" by ${result.provider}: ${angles.length}`);
      return json(req, {
        ok: true,
        kind,
        provider: result.provider,
        model: result.model,
        topic,
        angles,
        personalised: lesson.active,
        results_count: lesson.count,
        message: `${angles.length} angles from ${result.provider}`,
      });
    }

    // ---- hooks: just the opening line, not a whole angle or script ----
    //
    // Deliberately not stored, same reasoning as angles above: a hook is a
    // choice on the way to a script, not an item of its own.
    if (kind === 'hooks') {
      if (!topic) return json(req, { ok: false, error: 'What subject? No topic was sent.' }, 400);

      const result = await generateJson({
        ...ask,
        prompt: hooksPrompt({ topic, language, count: Math.min(Math.max(Number(body.count) || 3, 2), 5), today }),
      });
      await countCall(client, userId, result.provider);

      const raw = Array.isArray(result.value?.hooks) ? result.value.hooks
        : Array.isArray(result.value) ? result.value : [];
      const hooks = raw
        .filter((h: Record<string, unknown>) => h && h.line)
        .slice(0, 5)
        .map((h: Record<string, unknown>) => ({
          label: String(h.label ?? '').trim(),
          style: String(h.style ?? '').trim(),
          line: String(h.line ?? '').trim(),
        }));

      if (!hooks.length) {
        return json(req, { ok: false, error: `${result.provider} replied, but with no usable hooks in it. Try again.` }, 502);
      }

      console.log(`[vr-generate] hooks for "${topic.slice(0, 60)}" by ${result.provider}: ${hooks.length}`);
      return json(req, {
        ok: true, kind, provider: result.provider, model: result.model, topic, hooks,
        message: `${hooks.length} hooks from ${result.provider}`,
      });
    }

    // ---- ideas, a script, or the creator's own script formatted ----
    if (kind === 'script' && !topic) {
      return json(req, { ok: false, error: 'What should the script be about? No topic was sent.' }, 400);
    }
    if (kind === 'format_script' && !String(body.script ?? '').trim()) {
      return json(req, { ok: false, error: 'What should the script say? No script text was sent.' }, 400);
    }

    // An angle chosen on the angles screen, carried through so the script takes
    // it rather than producing the plainest treatment of the topic.
    const angle = body.angle && typeof body.angle === 'object' ? body.angle as Record<string, string> : null;

    let result;
    if (kind === 'format_script') {
      // "Keep my words exactly" is asked for in the prompt, but a model told to
      // copy sentences unchanged can still paraphrase — so it is checked here,
      // in code, the same "ask in the prompt, enforce in code" split the
      // Research Pack and the demo walkthrough already use. One retry before
      // giving up: the second attempt gets the identical instruction, and a
      // model that drifted once sometimes does not drift twice.
      const myScript = String(body.script ?? '').trim();
      const keepExact = body.keep_exact === true;
      const prompt = formatScriptPrompt({ script: myScript, keepExact, language, length, today, research });
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await generateJson({ ...ask, prompt });
        const value = result.value as Record<string, unknown>;
        const candidate = (Array.isArray(value?.items) ? value.items[0]
          : Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined;
        if (!keepExact || keepsExact(myScript, candidate?.beats as unknown[])) break;
        if (attempt === 1) {
          return json(req, {
            ok: false,
            error: `${result.provider} could not keep your script exactly as written, even on a second try. `
              + 'Try "Polish lightly" instead, or shorten your script.',
          }, 502);
        }
      }
    } else {
      const prompt = kind === 'ideas'
        ? ideasPrompt({
          keywords: Array.isArray(body.keywords) && body.keywords.length ? body.keywords : settings.keywords,
          language,
          length,
          count: Math.min(Math.max(Number(body.count) || 6, 1), 12),
          today,
          lesson,
        })
        : scriptPrompt({ topic, language, length, today, angle, lesson, research });
      result = await generateJson({ ...ask, prompt });
    }
    await countCall(client, userId, result.provider);

    const items = Array.isArray(result.value?.items) ? result.value.items
      : Array.isArray(result.value) ? result.value
        : [result.value];
    if (!items.length || !items[0]) {
      return json(req, { ok: false, error: `${result.provider} replied, but with nothing usable in it. Try again.` }, 502);
    }

    // A pack's own steps and prompts, when the browser sent one — see
    // shared/research.mjs's packDemoSource(). Overrides whatever the model
    // wrote for demo.steps/demo.prompts, the same "ask in the prompt, enforce
    // in code" split the Research Pack itself uses: a model can paraphrase a
    // prompt it was told to copy exactly, and the one place this matters most
    // is the one line the viewer is about to read off screen on camera.
    const demoSource = SCRIPT_KINDS.includes(kind) && body.demo_source && typeof body.demo_source === 'object'
      ? body.demo_source as Record<string, unknown> : null;

    // New Project's own-idea screen: the creator's original title, details,
    // links and (for format_script) their own script, kept whole in raw —
    // shown on the script detail as a collapsible "Original idea" section —
    // and own_idea:true, which draws the "My idea" badge. Neither is part of
    // the Shorts Studio contract; both simply pass through raw untouched, the
    // same way demo and edit_plan do.
    const ownIdea = SCRIPT_KINDS.includes(kind) && body.own_idea === true;
    const original = SCRIPT_KINDS.includes(kind) && body.original && typeof body.original === 'object'
      ? body.original as Record<string, unknown> : null;

    // Ids are assigned here, never by the model: it has no idea what already
    // exists, and a collision would overwrite real work. A script's id may be
    // supplied by the browser instead, so it can navigate straight to
    // `#/scripts/<id>` before the generation even finishes.
    const prefix = kind === 'ideas' ? 'idea' : 'scr';
    const suppliedId = SCRIPT_KINDS.includes(kind) ? String(body.id ?? '').trim() : '';
    const stamped = items.slice(0, 12).map((item: Record<string, unknown>, i: number) => ({
      ...item,
      id: (i === 0 && suppliedId) || newId(prefix),
      source: result.provider,
      ...(kind === 'ideas' ? { date: item.date || today } : { created_at: new Date().toISOString() }),
      ...(i === 0 && original ? { original } : {}),
      ...(demoSource ? {
        demo: {
          tool: demoSource.tool, url: demoSource.url,
          prepare: Array.isArray(item.demo && (item.demo as Record<string, unknown>).prepare)
            ? (item.demo as Record<string, unknown>).prepare : demoSource.prepare,
          steps: demoSource.steps, prompts: demoSource.prompts, check: demoSource.check,
          // False only when the pack itself has never been fetched by this
          // app — see shared/research.mjs's packDemoSource(). The steps and
          // prompts are still the pack's own, real ones; only the confidence
          // in them is what this says.
          checked: demoSource.checked !== false,
        },
      } : {}),
    }));

    // Through the same path as an import, so there is one way rows are written.
    const imported = await runImport(
      { app: 'shorts-studio', schema: 1, type: kind === 'ideas' ? 'ideas' : 'script', exported_at: new Date().toISOString(), items: stamped },
      storeFor(client, userId),
    );

    // Set directly, never through the contract: `language` is not part of the
    // Shorts Studio import shape at all (unlike demo, which Shorts Studio can
    // send too), so it stays out of COLUMNS.script on purpose — a column
    // listed there is overwritten by every future import of the same script,
    // including a plain re-import from Shorts Studio that has never heard of
    // this concept and would otherwise null it straight back out, the exact
    // bug class that keeps status/stage out of that list too.
    if (SCRIPT_KINDS.includes(kind)) {
      const { error: scriptLangError } = await client.from('scripts')
        .update({ language, ...(ownIdea ? { own_idea: true } : {}) }).eq('id', stamped[0].id);
      if (scriptLangError) console.warn(`[vr-generate] could not save the script's language: ${scriptLangError.message}`);
    }

    // The project's own language default, for next time — best-effort, same
    // as vr-research treats a pack save failure: the script is already
    // written, and losing this convenience is not worth failing the request.
    const projectId = SCRIPT_KINDS.includes(kind) ? String(body.project_id ?? '').trim() : '';
    if (projectId) {
      const { error: projLangError } = await client.from('projects').update({ language }).eq('id', projectId);
      if (projLangError) console.warn(`[vr-generate] could not remember the project's language: ${projLangError.message}`);
    }

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
      personalised: lesson.active,
      results_count: lesson.count,
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
