// GENERATED FILE - DO NOT EDIT.
// Copied from shared/edit-plan.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// The edit plan that Shorts Studio can attach to a script.
//
// It arrives inside the export item and is kept whole in the `raw` column, so
// no migration was needed to start showing it — the data has been there since
// the first import. There is no column for it, and there should not be: it is
// one blob that is only ever read as a whole.
//
// Shape, as Shorts Studio writes it:
//   {
//     total_sec,
//     timeline: [{ at, clip, action, text, sfx, tip }],
//     captions,
//     music:     { mood, search, volume },
//     cover:     { frame, text },
//     checklist: [string]
//   }
//
// Everything here is defensive. The plan is written by a tool and sometimes by
// a model, so a missing field, a string where an array belongs, or a number
// where text belongs must not break the screen. Anything unusable is dropped
// and the rest still shows.

const text = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(text).filter(Boolean);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** One row of the timeline, or null if there is nothing in it worth showing. */
function readStep(step) {
  if (!step || typeof step !== 'object') {
    // A plain string is still a usable instruction.
    const only = text(step);
    return only ? { at: '', clip: '', action: only, text: '', sfx: '', tip: '' } : null;
  }
  const out = {
    at: text(step.at),
    clip: text(step.clip),
    action: text(step.action),
    text: text(step.text),
    sfx: text(step.sfx),
    tip: text(step.tip),
  };
  return Object.values(out).some(Boolean) ? out : null;
}

/**
 * Pull the edit plan out of a script row, or return null when there is none.
 * Pass the whole row: the plan lives in `raw`, where the import left it.
 */
export function readEditPlan(script) {
  const plan = script?.raw?.edit_plan ?? script?.edit_plan ?? null;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;

  const timeline = (Array.isArray(plan.timeline) ? plan.timeline : []).map(readStep).filter(Boolean);
  const music = plan.music && typeof plan.music === 'object' ? {
    mood: text(plan.music.mood), search: text(plan.music.search), volume: text(plan.music.volume),
  } : { mood: '', search: '', volume: '' };
  const cover = plan.cover && typeof plan.cover === 'object' ? {
    frame: text(plan.cover.frame), text: text(plan.cover.text),
  } : { frame: '', text: '' };

  const out = {
    total_sec: num(plan.total_sec),
    timeline,
    captions: text(plan.captions),
    music,
    cover,
    checklist: list(plan.checklist),
  };

  // An object with nothing usable in it is the same as no plan at all.
  const hasSomething = out.total_sec || timeline.length || out.captions
    || Object.values(music).some(Boolean) || Object.values(cover).some(Boolean) || out.checklist.length;
  return hasSomething ? out : null;
}

/** The plan as plain text, for the copy button. */
export function editPlanText(plan) {
  if (!plan) return '';
  const lines = [];

  lines.push(plan.total_sec ? `EDIT PLAN (${plan.total_sec}s)` : 'EDIT PLAN');

  if (plan.timeline.length) {
    lines.push('', 'TIMELINE');
    for (const step of plan.timeline) {
      const head = [step.at, step.clip, step.action].filter(Boolean).join(' · ');
      lines.push(head ? `  ${head}` : '  -');
      if (step.text) lines.push(`      on screen: ${step.text}`);
      if (step.sfx) lines.push(`      sound: ${step.sfx}`);
      if (step.tip) lines.push(`      tip: ${step.tip}`);
    }
  }

  if (plan.captions) lines.push('', 'CAPTIONS', `  ${plan.captions}`);

  const music = [
    plan.music.mood && `mood: ${plan.music.mood}`,
    plan.music.search && `search: ${plan.music.search}`,
    plan.music.volume && `volume: ${plan.music.volume}`,
  ].filter(Boolean);
  if (music.length) lines.push('', 'MUSIC', ...music.map((m) => `  ${m}`));

  const cover = [
    plan.cover.frame && `frame: ${plan.cover.frame}`,
    plan.cover.text && `text: ${plan.cover.text}`,
  ].filter(Boolean);
  if (cover.length) lines.push('', 'COVER', ...cover.map((c) => `  ${c}`));

  if (plan.checklist.length) {
    lines.push('', 'CHECKLIST');
    for (const item of plan.checklist) lines.push(`  [ ] ${item}`);
  }

  return lines.join('\n');
}
