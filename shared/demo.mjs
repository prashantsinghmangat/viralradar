// The demo walkthrough a script can carry: exactly what to click, exactly
// what to type, read off camera while actually using the tool.
//
// It arrives inside the export item and is kept whole in the `raw` column —
// the same place edit_plan lives (see shared/edit-plan.mjs) and for the same
// reason: it is one blob that is only ever read as a whole, so no migration
// is needed either to accept it from Shorts Studio or to write it when
// vr-generate writes a script.
//
// Shape, as Shorts Studio writes it (and as vr-generate writes one too):
//   {
//     tool, url,
//     prepare: [string],   // one thing to have ready before filming
//     steps:   [string],   // one exact on-screen click or action, in order
//     prompts: [string],   // exact prompt text to type or paste, word for word
//     check:   [string],   // one thing to verify worked before moving on
//   }
//
// `checked` is not part of that contract — Shorts Studio never writes one.
// vr-generate adds it only when the demo was built from a Research Pack
// (shared/research.mjs's packDemoSource()): true when that pack has been
// fetched by this app (Re-checked), false when it has not. Everything else —
// a Shorts Studio export, a Claude chat import, or a demo a model wrote with
// no pack to draw from — defaults to **not checked**: none of those sources
// can browse, so none of them can vouch for a URL or a step actually working.
// Only a pack this app has itself fetched earns `checked: true`.
//
// Defensive for the same reason edit-plan.mjs is: written by a tool and
// sometimes by a model, so anything unusable is dropped rather than allowed
// to break the screen.

const text = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(text).filter(Boolean);

/**
 * Pull the demo out of a script row, or return null when there is none.
 * Pass the whole row: the demo lives in `raw`, where an import or a
 * generation leaves it.
 */
export function readDemo(script) {
  const demo = script?.raw?.demo ?? script?.demo ?? null;
  if (!demo || typeof demo !== 'object' || Array.isArray(demo)) return null;

  const out = {
    tool: text(demo.tool),
    url: text(demo.url),
    prepare: list(demo.prepare),
    steps: list(demo.steps),
    prompts: list(demo.prompts),
    check: list(demo.check),
    // Only an explicit true means checked; anything else — absent, false,
    // garbage — reads as not checked, because that is the honest default for
    // everything that is not a pack this app has fetched itself.
    checked: demo.checked === true,
  };

  // Nothing usable in it is the same as no demo at all.
  const hasContent = out.tool || out.url || out.prepare.length || out.steps.length || out.prompts.length || out.check.length;
  return hasContent ? out : null;
}
