// Picking a usable Supabase API key out of what the platform provides.
//
// An Edge Function is handed several key variables, and they do not all hold a
// bare key. SUPABASE_PUBLISHABLE_KEYS and SUPABASE_SECRET_KEYS can carry more
// than one while a rotation is in progress, and the platform has used both a
// JSON array and a comma-separated list for that.
//
// Getting this wrong does not fail loudly, which is why it is worth its own
// module and its own tests: a malformed key produces a client with no
// privileges, every query comes back "permission denied for schema viralradar",
// and that reads like a database problem rather than a configuration one. It
// cost an afternoon once.

/** A real key is either one of the new sb_ keys, or a JWT. */
export const looksLikeKey = (value) =>
  /^sb_(publishable|secret)_[A-Za-z0-9_-]+$/.test(String(value ?? '').trim())
  || String(value ?? '').trim().split('.').length === 3;

/**
 * The first usable key from the values given, in order of preference.
 * Returns '' when none of them hold one.
 */
export function pickKey(...values) {
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;

    let candidates;
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        candidates = list.map((entry) => (
          typeof entry === 'string' ? entry : (entry?.api_key ?? entry?.key ?? entry?.value ?? '')
        ));
      } catch {
        candidates = []; // not JSON after all; nothing usable here
      }
    } else {
      candidates = value.split(',');
    }

    const usable = candidates.map((c) => String(c ?? '').trim()).find(looksLikeKey);
    if (usable) return usable;
  }
  return '';
}
