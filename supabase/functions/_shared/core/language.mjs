// GENERATED FILE - DO NOT EDIT.
// Copied from shared/language.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// Which language a trending video is in, for the Radar's language filter.
//
// Two signals, in order of trust:
//
//   1. What YouTube itself says — videos.list's snippet.defaultAudioLanguage
//      or snippet.defaultLanguage, when the uploader set one. This is the
//      strongest signal there is, because it is a declaration rather than a
//      guess, but a lot of uploaders never set it.
//   2. The title's own Unicode script, when there is no declaration to go on.
//      Nine Indic scripts have unambiguous block ranges — a title containing
//      one of them is not plausibly in a different language. A title with no
//      script-level signal at all (pure Latin letters) could be English or
//      romanised Hindi ("Hinglish") and the text alone cannot tell those
//      apart, so it is kept whenever either is allowed rather than guessed at.
//
// Nothing here calls the network; it only reads strings already in hand.

/** ISO 639-1 code → Unicode block the language is written in, when distinctive. */
const SCRIPT_RANGES = [
  ['hi', /[ऀ-ॿ]/], // Devanagari
  ['bn', /[ঀ-৿]/], // Bengali
  ['pa', /[਀-੿]/], // Gurmukhi
  ['gu', /[઀-૿]/], // Gujarati
  ['or', /[଀-୿]/], // Odia
  ['ta', /[஀-௿]/], // Tamil
  ['te', /[ఀ-౿]/], // Telugu
  ['kn', /[ಀ-೿]/], // Kannada
  ['ml', /[ഀ-ൿ]/], // Malayalam
];

/**
 * The Unicode script a title is written in: an ISO code for one of the nine
 * Indic scripts above, `'latin'` for a title that is mostly Latin letters
 * (English or romanised Hindi — indistinguishable from the text alone), or
 * `''` when neither is true (all digits/emoji/punctuation, or a script this
 * list does not cover).
 */
export function detectTitleScript(title) {
  const text = String(title ?? '');
  for (const [lang, range] of SCRIPT_RANGES) {
    if (range.test(text)) return lang;
  }
  return /[a-zA-Z]/.test(text) ? 'latin' : '';
}

/** "en-US" / "hi_IN" / "EN" → "en". Empty for anything that is not a real code. */
export function baseLanguage(code) {
  const base = String(code ?? '').trim().toLowerCase().split(/[-_]/)[0];
  // YouTube uses "und" for "undetermined" and "zxx" for "no linguistic
  // content" — both mean "no real declaration", not a language of their own.
  return base && base !== 'und' && base !== 'zxx' ? base : '';
}

/**
 * Should this video be kept, given which languages the Radar is set to show?
 *
 * `allowed` is a list of ISO codes (shared/defaults.mjs's
 * DEFAULT_RADAR_LANGUAGES, or whatever Settings has). YouTube's own
 * declaration wins when there is one; the title's script is the fallback, and
 * a title with no usable signal at all is kept rather than guessed away.
 */
export function isLanguageAllowed({ title, allowed, audioLanguage, defaultLanguage } = {}) {
  const list = Array.isArray(allowed) ? allowed : [];
  const declared = baseLanguage(audioLanguage) || baseLanguage(defaultLanguage);
  if (declared) return list.includes(declared);

  const script = detectTitleScript(title);
  if (!script) return true; // nothing to go on; filtering here would be a guess
  if (script === 'latin') return list.includes('hi') || list.includes('en');
  return list.includes(script);
}
