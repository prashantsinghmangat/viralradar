// GENERATED FILE - DO NOT EDIT.
// Copied from shared/defaults.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// Defaults shared by the local app, the Edge Functions and the Settings screen.
export const DEFAULT_KEYWORDS = ['ai tools', 'free ai website', 'useful websites', 'chatgpt tricks', 'coding tips', 'tech hacks'];
export const SUBREDDITS = ['InternetIsBeautiful', 'artificial', 'SideProject', 'webdev'];
export const MAX_KEYWORDS = 25;
export const TREND_RETENTION_DAYS = 14;

export const DEFAULT_LANGUAGE = 'English';
export const DEFAULT_LENGTH = '30s';
export const LENGTHS = ['20s', '30s', '45s', '60s'];
// Providers are tried in this order unless Settings says otherwise.
export const DEFAULT_AI_ORDER = ['gemini', 'openrouter'];
// Measured rather than assumed. gemini-2.5-flash was retired outright, and
// the newest free models are heavily loaded: sampling four calls each gave
// gemini-flash-latest 1/4 (503 high demand), gemini-3.8-flash 2/4 (429), and
// gemini-3.5-flash 4/4. An alias sounds safer than a pinned version and in
// practice was the least reliable of the three.
//
// This is a Settings field, so it can be changed without a deploy when the
// balance shifts again — which it will.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
// Also measured. meta-llama/llama-3.3-70b-instruct:free stopped being free
// ("the paid version is available now"), and several of the current free
// models answer "Provider returned error" or are restricted. Of the ones
// tried through the deployed function, this answered in under a second.
export const DEFAULT_OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

export const IDEA_STATUS = ['new', 'picked', 'skipped'];
export const SCRIPT_STAGES = ['to_shoot', 'shot', 'edited', 'posted'];

// The three spoken languages the language sheet offers before writing
// anything — free text, same as DEFAULT_LANGUAGE, because that is what the
// prompt wants ("Spoken language: ${language}"). Hinglish first: it is what
// most of this creator's own videos are actually spoken in.
export const SCRIPT_LANGUAGES = ['Hinglish', 'Hindi', 'English'];

// Radar language filtering (shared/language.mjs) — ISO 639-1 codes, not the
// free-text script languages above. Hindi and English because that is what
// the Radar is for; the rest are offered because shared/language.mjs can
// actually detect them from a title's Unicode script.
export const RADAR_LANGUAGE_OPTIONS = [
  ['hi', 'Hindi'], ['en', 'English'], ['ta', 'Tamil'], ['te', 'Telugu'],
  ['kn', 'Kannada'], ['ml', 'Malayalam'], ['bn', 'Bengali'], ['gu', 'Gujarati'],
  ['pa', 'Punjabi'], ['or', 'Odia'],
];
export const DEFAULT_RADAR_LANGUAGES = ['hi', 'en'];
