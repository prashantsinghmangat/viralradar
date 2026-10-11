// Cover ideas for a script: three ways to build the thumbnail, each one
// assemblable by hand in Canva free with a real photo and a real screenshot.
//
// WHY THIS IS NOT AN IMAGE GENERATOR
//   The cover sells the video, and the two things that sell it are the
//   creator's own face and the tool's own screen. Neither can be generated:
//   an AI face is not this channel's face, and an AI rendering of a tool's UI
//   is a picture of a product that does not exist. So a concept here is a
//   BRIEF — where things go, what to photograph, what to screenshot, what
//   text to set — and the only thing a model is asked to draw is the
//   background behind all of it. That split is written into the prompt (see
//   thumbnailPrompt() in shared/prompts.mjs) and it is the rule this whole
//   feature is shaped around.
//
// Shape, as vr-generate stores it on `raw.thumbnail`:
//   {
//     concepts: [{
//       name, cover_text, layout, colors: [string],
//       my_photo, screenshot, image_prompt,
//       canva_steps: [string], stitch_prompt
//     }],
//     safe_area_note
//   }
//
// No column, same as the edit plan: it rides along in `raw`, so a `thumbnail`
// field exported by Shorts Studio later arrives and shows with no migration
// and no change here — see test/thumbnail.test.js, which holds that.
//
// Everything that reads the shape is defensive, for the same reason
// shared/edit-plan.mjs is: it is written by a model, and a string where an
// array belongs must cost one missing line on screen, never the screen.

const text = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(text).filter(Boolean);

// ---------- the brand kit ----------

/** How many brand colours are kept. Three is a palette; four is a mess. */
export const MAX_BRAND_COLORS = 3;

export const FACE_POSITIONS = ['left', 'right'];

/**
 * The brand kit off a settings row: colours, a font preference, the handle and
 * which side the face usually sits on. Every part optional.
 *
 * `set` is what both the prompt and the Settings screen branch on, so "no
 * brand kit" means exactly one thing in both places: with nothing filled in,
 * thumbnailPrompt() says nothing about branding at all rather than asking a
 * model to interpret an empty heading.
 */
export function readBrandKit(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const colors = list(s.brand_colors).map((c) => c.slice(0, 40)).slice(0, MAX_BRAND_COLORS);
  const font = text(s.brand_font).slice(0, 60);
  const handle = text(s.brand_handle).slice(0, 60);
  const face = FACE_POSITIONS.includes(text(s.brand_face)) ? text(s.brand_face) : '';
  return { colors, font, handle, face, set: Boolean(colors.length || font || handle || face) };
}

// ---------- reading what came back ----------

/** One concept, or null when there is nothing in it worth putting on screen. */
function readConcept(concept) {
  if (!concept || typeof concept !== 'object' || Array.isArray(concept)) return null;
  const out = {
    name: text(concept.name),
    cover_text: text(concept.cover_text),
    layout: text(concept.layout),
    colors: list(concept.colors).slice(0, MAX_BRAND_COLORS),
    my_photo: text(concept.my_photo),
    screenshot: text(concept.screenshot),
    image_prompt: text(concept.image_prompt),
    canva_steps: list(concept.canva_steps),
    stitch_prompt: text(concept.stitch_prompt),
  };
  // A concept with only a name is a heading with nothing under it.
  const usable = out.cover_text || out.layout || out.my_photo || out.screenshot
    || out.image_prompt || out.canva_steps.length || out.stitch_prompt || out.colors.length;
  return usable ? out : null;
}

/**
 * Pull the cover ideas out of a script row, or null when there are none.
 *
 * Pass the whole row: they live in `raw`, where vr-generate and an import both
 * leave them.
 */
export function readThumbnail(script) {
  const thumb = script?.raw?.thumbnail ?? script?.thumbnail ?? null;
  if (!thumb || typeof thumb !== 'object' || Array.isArray(thumb)) return null;

  const concepts = (Array.isArray(thumb.concepts) ? thumb.concepts : []).map(readConcept).filter(Boolean);
  const safe_area_note = text(thumb.safe_area_note);
  // The note alone is not a cover idea. Without a single usable concept there
  // is nothing to show, and the screen offers to write some instead.
  return concepts.length ? { concepts, safe_area_note } : null;
}

// ---------- copying it ----------

/** The Canva steps as a numbered list, for the copy button. */
export function canvaStepsText(concept) {
  const steps = concept?.canva_steps || [];
  if (!steps.length) return '';
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/**
 * All three concepts as one Markdown brief — the 06-cover/cover-brief.md the
 * local folder gets, so the cover can be built at the desk with the app shut.
 */
export function coverBriefMarkdown(script) {
  const thumb = readThumbnail(script);
  if (!thumb) return '';
  const s = script || {};
  const lines = [`# Cover ideas: ${text(s.title) || text(s.yt_title) || text(s.topic) || 'Script'}`, ''];

  lines.push('Use your real photo and a real screenshot of the tool. The image prompt is for the', 'background only — never your face, never the tool\'s screen.', '');
  if (thumb.safe_area_note) lines.push(`> ${thumb.safe_area_note}`, '');

  thumb.concepts.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.name || 'Concept ' + (i + 1)}`, '');
    for (const [label, value] of [
      ['Cover text', c.cover_text],
      ['Layout', c.layout],
      ['Colours', c.colors.join(', ')],
      ['Your photo', c.my_photo],
      ['Screenshot', c.screenshot],
    ]) {
      if (value) lines.push(`- **${label}:** ${value}`);
    }
    lines.push('');
    if (c.canva_steps.length) lines.push('### In Canva', ...c.canva_steps.map((step, n) => `${n + 1}. ${step}`), '');
    if (c.image_prompt) lines.push('### Background image prompt', '```', c.image_prompt, '```', '');
    if (c.stitch_prompt) lines.push('### Stitch prompt (1080x1920)', '```', c.stitch_prompt, '```', '');
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
