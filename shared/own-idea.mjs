// New Project, from your own idea — not a trend, not an import.
//
// One screen, three modes:
//   generate    title + details (+ optional links) -> AI writes everything
//   own_script  a script you already wrote -> formatted into the script shape
//   save_only   just the idea, kept as a note -> nothing generated
//
// Kept here, not only in app.js, because the same rules are checked from two
// places: the browser validates the form before anything is sent, and
// vr-generate enforces "keep my words exactly" itself — a model told to copy
// sentences unchanged can still paraphrase, so the check has to run in code,
// not only live in the prompt. The same split shared/research.mjs and
// shared/demo.mjs already use.

import { cleanUrls } from './research.mjs';

export const IDEA_MODES = ['generate', 'own_script', 'save_only'];
export const MAX_IDEA_LINKS = 5;

export const IDEA_MODE_LABEL = {
  generate: 'AI made everything',
  own_script: 'my own script',
  save_only: 'idea only',
};

const clip = (v, max) => String(v ?? '').trim().slice(0, max);

/** Source links for a New Project: the same cleanup research links get, capped lower. */
export const cleanIdeaLinks = (links) => cleanUrls(links, MAX_IDEA_LINKS);

/**
 * What the New Project screen must have before it can submit, per mode.
 * Returns a message to show, or null when the form is ready to send.
 */
export function validateNewProject({ mode, title, myScript } = {}) {
  if (!IDEA_MODES.includes(mode)) return 'Choose how to start this project.';
  if (!clip(title, 1)) return 'Give the project a title.';
  if (mode === 'own_script' && !clip(myScript, 1)) return 'Paste your script first.';
  return null;
}

const normalizeWhitespace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Every spoken line, joined the same way whichever side is reading it. */
export const joinedSpoken = (beats) =>
  (Array.isArray(beats) ? beats : []).map((b) => normalizeWhitespace(b?.say)).filter(Boolean).join(' ');

/**
 * "Keep my words exactly": true only when the beats' spoken lines, joined and
 * stripped of whitespace differences, are exactly the creator's own script —
 * not a paraphrase, not a trim, not a reorder. Whitespace is the only thing
 * allowed to differ, because a model asked to "just split this into beats"
 * still reflows line breaks and spacing even when it leaves the words alone.
 */
export function keepsExact(myScript, beats) {
  return joinedSpoken(beats) === normalizeWhitespace(myScript);
}

/**
 * What a New Project submission carries forward, whichever mode it is —
 * stamped onto the generated script's `raw.original` (see shared/demo.mjs's
 * `raw` passthrough pattern) and filed as a note in the project folder, so
 * the creator's own input is never lost even once a model has reworked it.
 */
export function originalIdeaPayload({ mode, title, details, links, myScript, keepExact } = {}) {
  const cleanedLinks = Array.isArray(links) ? cleanIdeaLinks(links) : [];
  return {
    mode,
    title: clip(title, 200),
    details: clip(details, 4000),
    links: cleanedLinks,
    ...(mode === 'own_script' ? { my_script: clip(myScript, 20000), keep_exact: keepExact === true } : {}),
  };
}

/** The note text filed in the project folder for the original payload above. */
export function originalIdeaNote(original) {
  const o = original || {};
  const lines = [`Original idea (${IDEA_MODE_LABEL[o.mode] || o.mode || 'unknown'})`, '', `Title: ${o.title || ''}`];
  if (o.details) lines.push('', 'Details:', o.details);
  if (o.mode === 'own_script') {
    lines.push('', `Keep my words: ${o.keep_exact ? 'exactly' : 'polish lightly'}`, '', 'My script:', o.my_script || '');
  }
  if (o.links && o.links.length) lines.push('', 'Links:', ...o.links);
  return lines.join('\n');
}
