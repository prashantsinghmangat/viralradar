// Research Pack: everything needed to record a video about one tool, grounded
// in pages that were actually fetched.
//
// WHY THIS IS NOT JUST ANOTHER PROMPT
//   Asking a model "what are this tool's free limits?" gets you a confident
//   answer that is sometimes last year's pricing and sometimes invented. For a
//   video whose whole promise is "this is free and you can try it now", a wrong
//   limit is the one mistake that cannot be edited out afterwards.
//
//   So the page is fetched first, and the model is given the text rather than
//   asked to remember it.
//
// WHAT IS ASKED FOR, AND WHAT IS ENFORCED
//   The prompt says: state only what is in the fetched text, put everything
//   else under "unverified", cite a URL for every fact. That is an instruction,
//   and an instruction is not a guarantee — a model can ignore it, and will.
//
//   So normalisePack() afterwards enforces the parts that can be:
//     * `reachable` comes from the fetch result, never from the model. It
//       cannot present a dead URL as working.
//     * `sources` is the list of pages that really loaded.
//     * any fact citing a URL that did not load is forced to "unverified",
//       whatever the model called it.
//     * with nothing reachable at all, nothing is verified. Full stop.
//
//   What remains unenforceable is whether a claim the model marked verified is
//   really in the text it was given. A paraphrase cannot be string-matched, so
//   that one rests on the prompt — which is why every claim carries its source
//   URL and the UI shows it: the check of last resort is a person following the
//   link.

import { istDay } from './time.mjs';

/** Long enough for a slow site, short enough that six of them is not a minute. */
export const FETCH_TIMEOUT_MS = 10000;

/** Visible text kept per page. Past this, a model is reading navigation. */
export const MAX_TEXT_CHARS = 10000;

/** Downloaded per page. A page bigger than this is not an article. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** Pages per pack. Each one is a fetch and a slice of the prompt. */
export const MAX_URLS = 6;

/** Candidate tools to ask for when no URL was given. */
export const MAX_CANDIDATES = 3;

// Sent so a site can see who is asking. A blank or fake browser string gets
// more pages blocked, not fewer.
export const USER_AGENT =
  'ViralRadar/1.0 (personal research tool; +https://ytshortradar.netlify.app)';

const str = (v, max = 2000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const lines = (v, max = 12, len = 400) => (Array.isArray(v) ? v : [])
  .map((x) => str(x, len)).filter(Boolean).slice(0, max);

// ---------- urls ----------

/** Only http(s), deduped, capped. Anything else is not a page we can read. */
export function cleanUrls(urls = [], max = MAX_URLS) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    let u;
    try {
      u = new URL(String(raw).trim());
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(u.protocol)) continue;
    // Tracking parameters change nothing about the page and would make the
    // same URL look like two sources.
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|si$)/i.test(p)) u.searchParams.delete(p);
    }
    const key = u.toString().replace(/#.*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.toString());
    if (out.length >= max) break;
  }
  return out;
}

// ---------- reading a page ----------

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&rsquo;': '’', '&lsquo;': '‘',
};
const decode = (s) => String(s ?? '')
  .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()]
    ?? (/^&#\d+;$/.test(m) ? String.fromCharCode(Number(m.slice(2, -1))) : m));

/**
 * The readable parts of an HTML page: title, description, visible text.
 *
 * Deliberately crude. There is no DOM here and nothing needs one: the model is
 * being given prose to read, not a document to traverse. What matters is that
 * script and style contents never reach it, because a page's JavaScript is full
 * of strings that look like facts.
 */
export function readPage(html, { maxChars = MAX_TEXT_CHARS } = {}) {
  const source = String(html ?? '');

  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? str(decode(titleMatch[1]), 300) : '';

  const descMatch = source.match(
    /<meta[^>]+(?:name|property)\s*=\s*["'](?:description|og:description)["'][^>]*>/i,
  );
  const descContent = descMatch ? descMatch[0].match(/content\s*=\s*["']([\s\S]*?)["']/i) : null;
  const description = descContent ? str(decode(descContent[1]), 600) : '';

  const text = str(decode(source
    // Anything that is not prose, removed whole. A page's own scripts contain
    // plenty of text that reads like a feature list and is not one.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')), maxChars);

  return { title, description, text, chars: text.length };
}

/** Read a response body, stopping at a byte cap rather than trusting the site. */
async function readCapped(response, maxBytes) {
  // Content-Length is a hint, not a promise, so the stream is capped as well.
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared && declared > maxBytes) {
    return { text: '', tooBig: true };
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const whole = await response.text();
    return { text: whole.slice(0, maxBytes), tooBig: whole.length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let tooBig = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength ?? value.length ?? 0;
    if (total > maxBytes) { tooBig = true; break; }
    chunks.push(value);
  }
  try { await reader.cancel(); } catch { /* already done */ }
  const merged = new Uint8Array(total > maxBytes ? maxBytes : total);
  let at = 0;
  for (const c of chunks) { merged.set(c, at); at += c.byteLength ?? c.length; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), tooBig };
}

/**
 * Fetch one page and say plainly whether it worked.
 *
 * `fetchImpl` is injected so the whole of this runs in Node against a fake.
 * Never throws: a page that cannot be read is a result, not an error — the
 * pack is still worth having with two of three sources.
 */
export async function fetchPage(url, { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_PAGE_BYTES } = {}) {
  const started = Date.now();
  const base = { url, finalUrl: url, reachable: false, status: 0, title: '', description: '', text: '', chars: 0, error: '' };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
      ...(controller ? { signal: controller.signal } : {}),
    });

    const status = Number(response.status) || 0;
    const finalUrl = str(response.url || url, 2000) || url;
    const type = String(response.headers?.get?.('content-type') || '').toLowerCase();

    if (!response.ok) {
      return { ...base, finalUrl, status, error: `the page answered ${status}` };
    }
    // A PDF or an image decoded as text is noise that reads like content.
    if (type && !/text\/html|text\/plain|application\/xhtml/.test(type)) {
      return { ...base, finalUrl, status, error: `not a readable page (${type.split(';')[0]})` };
    }

    const { text: body, tooBig } = await readCapped(response, maxBytes);
    const page = readPage(body);
    return {
      ...base,
      finalUrl,
      status,
      reachable: true,
      title: page.title,
      description: page.description,
      text: page.text,
      chars: page.chars,
      truncated: tooBig || page.chars >= MAX_TEXT_CHARS,
      ms: Date.now() - started,
    };
  } catch (e) {
    const aborted = /abort/i.test(e?.name || '') || /abort/i.test(e?.message || '');
    return { ...base, error: aborted ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : (e?.message || 'could not be fetched') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Every URL, fetched. One slow site must not hold up the rest. */
export async function fetchPages(urls, options = {}) {
  const list = cleanUrls(urls, options.max ?? MAX_URLS);
  return Promise.all(list.map((u) => fetchPage(u, options)));
}

// ---------- the prompts ----------

/** Candidates, when there is no URL to start from. Clearly labelled as guesses. */
export function candidatesPrompt({ topic, language = 'English', today = istDay() } = {}) {
  return `A creator wants to make a short video about this subject:

${topic}

Name up to ${MAX_CANDIDATES} specific free tools or websites that fit it, with their
OFFICIAL homepage URL — not a blog post, not a review, not an app store page.

Today is ${today}. Answer in ${language} where there is prose.

These are CANDIDATES to be checked, not facts. Do not describe what they do, do
not state any limits or pricing, and do not claim any of them is free: every one
of those will be read off the real page afterwards. If you are not confident a
tool exists at a URL you can name, leave it out rather than guessing.

Return ONLY valid JSON, no markdown, no commentary:
{ "candidates": [{ "name": "the tool", "url": "https://..." }] }`;
}

const PACK_SHAPE = `{
  "topic": "the subject, in a few words",
  "main_tool": {
    "name": "the tool this video is about",
    "url": "its official URL, from the sources below",
    "what_it_does": "one or two plain sentences",
    "how_it_works_simple": "the explanation you would give out loud, no jargon",
    "free_details": {
      "signup": "whether an account is needed, exactly as the page says",
      "watermark": "whether output is watermarked, exactly as the page says",
      "limits": "the free limits, exactly as the page says",
      "export_quality": "what quality can be exported on the free plan"
    },
    "steps": ["one step of using it, in order"],
    "prompts": ["a prompt worth trying, if it takes a text prompt at all"],
    "best_inputs": ["what to feed it so the demo looks impressive"],
    "settings": ["a setting worth changing before recording"]
  },
  "alternatives": [{ "name": "another tool", "url": "https://...", "one_line": "how it differs" }],
  "fact_check": [{ "claim": "the claim as it would be said on camera", "status": "verified", "source_url": "https://..." }],
  "test_plan": ["how to prove one claim on camera"],
  "recording_checklist": ["one thing to do or check before recording"]
}`;

/**
 * The pack, written only from what was fetched.
 *
 * The rules are stated as plainly as they can be, and then normalisePack()
 * enforces the half of them that is enforceable. Both are needed: the prompt
 * because most of this cannot be checked mechanically, the code because the
 * prompt will sometimes be ignored.
 */
export function researchPrompt({ topic, pages = [], language = 'English', today = istDay() } = {}) {
  const live = pages.filter((p) => p.reachable);
  const dead = pages.filter((p) => !p.reachable);

  const sourceBlocks = live.map((p, i) => `--- SOURCE ${i + 1}: ${p.finalUrl}
title: ${p.title || '(no title)'}
description: ${p.description || '(none)'}
page text${p.truncated ? ' (truncated)' : ''}:
${p.text || '(no readable text)'}
--- end of SOURCE ${i + 1}`).join('\n\n');

  const deadBlock = dead.length
    ? `\nThese URLs could NOT be read, so nothing may be said about them:\n${dead.map((p) => `- ${p.url} (${p.error})`).join('\n')}\n`
    : '';

  return `You are preparing a creator to record a short video. They will read this
and then press record, so everything in it has to be true.

Subject: ${topic}
Today is ${today}.
Write the explanations in ${language}. Keep URLs and tool names as they are.

${live.length ? `The pages below were fetched just now. They are your ONLY source of fact.

${sourceBlocks}` : 'NOTHING could be fetched for this subject.'}
${deadBlock}
RULES, and they matter more than completeness:
1. Every statement of fact must come from the page text above. If it is not
   there, you do not know it.
2. Anything you believe but cannot find in the text above goes in "fact_check"
   with status "unverified". It is better to return ten unverified claims than
   one invented fact.
3. Never invent pricing, free limits, watermark behaviour, export quality or
   feature lists. These are the things a viewer will check, and the things a
   model is most likely to remember wrongly. If the page does not say, write
   "the page does not say" and mark it unverified.
4. Every entry in "fact_check" needs the source_url it came from, and that URL
   must be one of the sources above.
5. "steps" must be the steps as the page describes them, in order. If the page
   does not describe them, leave the list empty rather than inventing a flow.
6. "prompts" is only for a tool that takes a text prompt. If it does not, return
   an empty list — do not invent prompts for a tool that has no prompt box.
7. "test_plan" is how to PROVE each important claim while recording: the thing
   to show on screen that makes the claim self-evident.
${live.length ? '' : '8. With no sources, every claim must be "unverified" and the pack should say so plainly.\n'}
Return ONLY valid JSON, no markdown, no code fences, no commentary.
Return exactly this shape:
${PACK_SHAPE}`;
}

// ---------- making the answer trustworthy ----------

const asFreeDetails = (v) => {
  const d = v && typeof v === 'object' ? v : {};
  return {
    signup: str(d.signup, 400),
    watermark: str(d.watermark, 400),
    limits: str(d.limits, 600),
    export_quality: str(d.export_quality, 400),
  };
};

/**
 * Take what the model returned and make the parts that can be checked true.
 *
 * This is the half of "never invented" that is actually enforceable:
 *
 *   reachable   from the fetch, never from the model
 *   sources     the pages that really loaded
 *   verified    only where the cited URL is one of those pages
 *
 * Everything it downgrades is still shown — as unverified, with its link — so
 * nothing is hidden, it is just no longer presented as fact.
 *
 * `checked` is false for a pack that arrived by import rather than by a real
 * fetch here (a Shorts Studio or Claude-chat research item): its own
 * `reachable` and `status` fields were someone else's word for it, not this
 * function's, so they are untrustworthy in exactly the way a wrong URL would
 * be. Rather than guess, every claim is marked 'unchecked' and every
 * `reachable` is left `null` — "not checked", not "checked and false" — until
 * Re-check links calls this same function again with `checked: true` and
 * pages it actually fetched. The shape of the two outputs is identical; only
 * the verdicts differ.
 */
export function normalisePack({ pack, pages = [], topic = '', checked = true } = {}) {
  const raw = pack && typeof pack === 'object' ? pack : {};
  const live = pages.filter((p) => p.reachable);

  // Both forms count: a source that redirected is still that source, and the
  // model may cite either the URL it was given or the final one.
  const reachableUrls = new Set();
  for (const p of live) {
    reachableUrls.add(p.url);
    if (p.finalUrl) reachableUrls.add(p.finalUrl);
  }
  const known = (url) => checked && reachableUrls.has(str(url, 2000));

  const tool = raw.main_tool && typeof raw.main_tool === 'object' ? raw.main_tool : {};
  const toolUrl = str(tool.url, 2000);

  const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .slice(0, 6)
    .map((a) => {
      const url = str(a?.url, 2000);
      return { name: str(a?.name, 200), url, reachable: checked ? known(url) : null, one_line: str(a?.one_line, 300) };
    })
    .filter((a) => a.name || a.url);

  // The rule that does the work. A claim whose source did not load cannot have
  // been read off it, whatever the model called the claim.
  //
  // When !checked, the claimed status is kept exactly as it arrived rather
  // than forced to 'unchecked' here: Re-check links calls this same function
  // a second time, with real fetches, on this pack's own output — and it
  // needs to know what was claimed in order to confirm or downgrade it. What
  // the UI shows while unchecked is a presentation decision, made from the
  // pack's top-level `checked` flag (every claim reads as "not checked" then,
  // regardless of its stored status) rather than by destroying the claim.
  let downgraded = 0;
  const factCheck = (Array.isArray(raw.fact_check) ? raw.fact_check : [])
    .slice(0, 40)
    .map((f) => {
      const sourceUrl = str(f?.source_url, 2000);
      const claimedVerified = str(f?.status, 20).toLowerCase() === 'verified';
      if (!checked) return { claim: str(f?.claim, 600), status: claimedVerified ? 'verified' : 'unverified', source_url: sourceUrl };
      // `live.length > 0` is redundant — with nothing live, reachableUrls is
      // empty and known() is already false. It stays as a second gate, and a
      // tamper test that removes it rightly shows no change in behaviour.
      const verified = claimedVerified && live.length > 0 && known(sourceUrl);
      if (claimedVerified && !verified) downgraded += 1;
      return {
        claim: str(f?.claim, 600),
        status: verified ? 'verified' : 'unverified',
        source_url: sourceUrl,
      };
    })
    .filter((f) => f.claim);

  return {
    topic: str(raw.topic, 300) || str(topic, 300),
    main_tool: {
      name: str(tool.name, 200),
      url: toolUrl,
      // Never the model's opinion. This is the one field a wrong answer would
      // turn into a video recommending a dead site.
      reachable: checked ? known(toolUrl) : null,
      what_it_does: str(tool.what_it_does, 800),
      how_it_works_simple: str(tool.how_it_works_simple, 1200),
      free_details: asFreeDetails(tool.free_details),
      steps: lines(tool.steps, 15),
      prompts: lines(tool.prompts, 10, 600),
      best_inputs: lines(tool.best_inputs, 10),
      settings: lines(tool.settings, 10),
    },
    alternatives,
    fact_check: factCheck,
    test_plan: lines(raw.test_plan, 12),
    recording_checklist: lines(raw.recording_checklist, 15),
    // Set here, not by the model: the list of pages that actually answered.
    // An unchecked pack has no fetch to draw this from, so it keeps whatever
    // the import said — clearly unverifiable until Re-check links runs.
    sources: checked ? live.map((p) => p.finalUrl || p.url) : lines(raw.sources, 20),
    unreachable: pages.filter((p) => !p.reachable).map((p) => ({ url: p.url, error: p.error })),
    checked,
    grounded: checked && live.length > 0,
    // Counted from `checked`, not from the per-claim status: while unchecked,
    // every claim displays as "not checked" regardless of what it carries
    // internally (see the comment above factCheck), so the counts a reader
    // sees have to agree with that, not with the hidden claimed status.
    verified_count: checked ? factCheck.filter((f) => f.status === 'verified').length : 0,
    unverified_count: checked ? factCheck.filter((f) => f.status === 'unverified').length : 0,
    unchecked_count: checked ? 0 : factCheck.length,
    downgraded_count: downgraded,
    researched_at: new Date().toISOString(),
  };
}

/** Did anything come back worth keeping? */
export const packIsEmpty = (pack) => !pack
  || (!pack.main_tool?.name && !pack.fact_check?.length && !pack.sources?.length);

/**
 * The pack, as a block for the angles and script prompts.
 *
 * Only verified claims. An unverified one is a thing to check before recording,
 * not a thing to put in a script — and a script written from one is exactly the
 * mistake this whole feature exists to prevent.
 */
export function packSummary(pack) {
  if (!pack || !pack.grounded) return '';
  const verified = (pack.fact_check || []).filter((f) => f.status === 'verified');
  const tool = pack.main_tool || {};

  const facts = verified.length
    ? verified.map((f) => `- ${f.claim} (${f.source_url})`).join('\n')
    : '- (nothing could be verified from the pages that were read)';

  // Steps and prompts are not individually fact-checked the way a claim is —
  // see normalisePack() — but they only ever reach here once at least one
  // page was actually fetched (packSummary refuses otherwise), and they are
  // what packDemoSource() below builds demo.steps / demo.prompts from. Shown
  // here too so a script's own beats are written consistent with the demo
  // that will actually override them.
  const steps = (tool.steps || []).length
    ? `\n\nSteps read off the page:\n${tool.steps.map((s) => `- ${s}`).join('\n')}` : '';
  const prompts = (tool.prompts || []).length
    ? `\n\nPrompts read off the page — if the demo needs one, use this exact wording:\n${tool.prompts.map((p) => `- ${p}`).join('\n')}` : '';

  return `Verified research on this subject. Use these facts and no others:

tool: ${tool.name || '(not named)'}${tool.url ? ` — ${tool.url}` : ''}
what it does: ${tool.what_it_does || '(not established)'}

${facts}${steps}${prompts}

Do NOT state any limit, price, watermark behaviour or feature that is not in the
list above. If the script needs one and it is not there, leave it out of the
script rather than guessing: every claim above was read off the live page, and
anything else would not have been.`;
}

/**
 * The demo's steps and prompts, taken straight from the pack rather than
 * trusted from whatever the model writes — the same "ask in the prompt,
 * enforce in code" split the rest of this module uses.
 *
 * Two different reasons this can come back with nothing to build from:
 *   - `checked !== false` (this app fetched the pages itself, or has not said
 *     otherwise) but `!grounded` — a real fetch was attempted and found
 *     nothing live, so there is no page a step or a prompt could have been
 *     read off. Building a demo from it would be building one from a page
 *     that does not answer.
 *   - the pack simply names no steps or prompts at all (grounded in general
 *     facts about a tool without ever having found a how-to).
 *
 * An imported pack that has never been checked (`checked === false` — see
 * normalisePack()) is treated differently on purpose: its steps and prompts
 * came from somewhere else, not from a fetch this app ever made or refused
 * to make, so they are still worth using rather than thrown away — just
 * labelled. The returned `checked` field is what the demo section reads to
 * show "Not checked yet" instead of presenting them as confirmed.
 */
export function packDemoSource(pack) {
  if (!pack) return null;
  if (pack.checked !== false && !pack.grounded) return null;
  const tool = pack.main_tool || {};
  if (!(tool.steps || []).length && !(tool.prompts || []).length) return null;
  return {
    tool: tool.name || '',
    url: tool.url || '',
    prepare: pack.recording_checklist || [],
    steps: tool.steps || [],
    prompts: tool.prompts || [],
    check: pack.test_plan || [],
    checked: pack.checked !== false,
  };
}

/** "3 sources · 7 verified · 2 unverified", or "4 claims · not checked yet" before a recheck. */
export const packLabel = (pack) => {
  if (!pack) return '';
  if (pack.checked === false) {
    const n = pack.unchecked_count || 0;
    return n ? `${n} claim${n === 1 ? '' : 's'} · not checked yet` : 'not checked yet';
  }
  const bits = [`${(pack.sources || []).length} source${(pack.sources || []).length === 1 ? '' : 's'}`];
  if (pack.verified_count) bits.push(`${pack.verified_count} verified`);
  if (pack.unverified_count) bits.push(`${pack.unverified_count} unverified`);
  return bits.join(' · ');
};
