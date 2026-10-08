// Prompt rules and JSON repair for the "generate" Edge Function.
// The rules are the same ones Shorts Studio uses, so generated items feel
// identical to imported ones. Kept here (not in the function) so the browser
// can show them and the tests can assert on them.

export const CTAS = ['save this', 'follow for more', 'comment for link'];

export const RULES = [
  'Stop the scroll in the first 2 seconds: the first line must be the hook, never a greeting or an intro.',
  'Show the result first, then explain how it was done.',
  'One idea per video. Do not bundle several tools or tips into one script.',
  'Only free tools a viewer can try in under a minute: no signup walls, no paid plans, no installs.',
  'Honest claims only. No "this will make you rich", no invented numbers, no fake urgency.',
  `Vary the call to action between videos; pick one of: ${CTAS.join(' / ')}.`,
  'Plain spoken language, short sentences, no jargon, no emoji inside the spoken lines.',
];

const rulesBlock = () => RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');

// Shapes mirror shared/contract.mjs exactly, minus "id": the function assigns
// ids itself so a model can never cause a collision or overwrite a real row.
const IDEA_SHAPE = `{
  "date": "YYYY-MM-DD (today)",
  "title": "short idea name",
  "hook": "the exact first spoken line, under 12 words",
  "tool": "the one free tool or website used",
  "show": "what is shown on screen",
  "why": "why someone watches to the end",
  "format": "listicle | demo | before-after | story | tip"
}`;

const SCRIPT_SHAPE = `{
  "topic": "short topic label",
  "title": "working title",
  "beats": [{ "t": "0-3s", "say": "the exact words to speak", "screen": "what is on screen" }],
  "thumbnail_text": "3 to 5 words, ALL CAPS",
  "yt_title": "YouTube title under 70 characters",
  "ig_caption": "Instagram caption, 1 to 2 lines",
  "fb_caption": "Facebook caption, 1 to 2 lines",
  "hashtags": ["#tag", "#tag"],
  "pinned_comment": "the comment to pin under the video",
  "broll": ["b-roll shot to film or screen-record"],
  "audio": "the kind of background audio"
}`;

const jsonOnly = (shape, wrapper) =>
  `Return ONLY valid JSON, no markdown, no code fences, no commentary before or after.
Return exactly this shape:
${wrapper.replace('SHAPE', shape)}`;

export function ideasPrompt({ keywords = [], language = 'English', length = '30s', count = 6, today } = {}) {
  const niche = keywords.length ? keywords.join(', ') : 'free AI tools and useful websites';
  return `You write short-video ideas for a creator whose niche is: ${niche}.

Write ${count} fresh ideas for ${length} vertical short videos. Spoken language: ${language}.
Today is ${today}.

Rules:
${rulesBlock()}

${jsonOnly(IDEA_SHAPE, '{ "items": [ SHAPE ] }')}`;
}

export function scriptPrompt({ topic, language = 'English', length = '30s', today } = {}) {
  return `You write short-video scripts for a creator who demos free tools and useful websites.

Write one complete ${length} vertical short-video script about: ${topic}
Spoken language: ${language}. Today is ${today}.

Rules:
${rulesBlock()}

Beats must cover the whole ${length} with timecodes that add up to it (for example 0-3s, 3-10s, 10-22s, 22-30s).
The spoken lines together must be readable aloud within ${length}.

${jsonOnly(SCRIPT_SHAPE, '{ "items": [ SHAPE ] }')}`;
}

// The edit plan a script can carry. Same shape Shorts Studio writes, so a plan
// written here and one written there are read by exactly the same code.
const EDIT_PLAN_SHAPE = `{
  "total_sec": 30,
  "timeline": [{
    "at": "0-3s",
    "clip": "what to film or screen-record",
    "action": "what happens in this moment",
    "text": "words on screen, if any",
    "sfx": "a sound effect, if any",
    "tip": "one thing that makes this shot work, if any"
  }],
  "captions": "how the subtitles should look",
  "music": { "mood": "the feel", "search": "what to search for in a free music library", "volume": "how loud under the voice" },
  "cover": { "frame": "which moment to use as the thumbnail", "text": "3 to 5 words, ALL CAPS" },
  "checklist": ["one thing to check before posting"]
}`;

export function editPlanPrompt({ script, language = 'English', length = '30s', today } = {}) {
  const beats = (script?.beats || [])
    .map((b) => [b.t, b.say, b.screen && `(on screen: ${b.screen})`].filter(Boolean).join(' — '))
    .join('\n');

  return `You are editing a short vertical video that has already been written.
Make the plan for shooting and editing it. Today is ${today}.

Title: ${script?.title || script?.yt_title || 'untitled'}
Topic: ${script?.topic || 'not given'}
Spoken language: ${language}. Target length: ${length}.

The script, beat by beat:
${beats || '(no beats; work from the title and topic)'}

Rules:
${rulesBlock()}

The timecodes in the timeline must cover the whole video and add up to roughly
${length}. Every entry needs at least "at" and "action"; "text", "sfx" and "tip"
are only for when they actually help. Keep the checklist to things that are
quick to check and easy to get wrong.

${jsonOnly(EDIT_PLAN_SHAPE, 'SHAPE')}`;
}

export const fixJsonPrompt = (bad) =>
  `The text below was supposed to be valid JSON but it cannot be parsed. Fix it.
Return ONLY the corrected JSON: no code fences, no explanation, no extra keys.

${bad}`;

/**
 * Pull JSON out of a model reply: strips ```json fences and any prose around
 * the object. Throws if nothing parseable is found.
 */
export function extractJson(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  t = t.replace(/^﻿/, '').trim();
  try {
    return JSON.parse(t);
  } catch { /* fall through to brace scanning */ }
  const start = t.search(/[[{]/);
  if (start !== -1) {
    const open = t[start];
    const close = open === '{' ? '}' : ']';
    const end = t.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch { /* give up below */ }
    }
  }
  throw new Error('The AI did not return JSON.');
}
