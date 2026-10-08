// GENERATED FILE - DO NOT EDIT.
// Copied from shared/learning.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// What has actually worked, turned into something a prompt can use.
//
// The Results screen already works out averages by format, hook, length and
// CTA. That analysis sat on its own screen: the idea generator knew the niche
// keywords and nothing about which of its own past suggestions had done well.
// This closes that loop.
//
// TWO THRESHOLDS, AND WHY
//   5 results overall. Below that there is no pattern, only noise, and a
//   generator told "your best hook is X" after two videos would narrow itself
//   on an accident.
//
//   2 videos per group. One video is an anecdote. Worse, with a single video in
//   a group it is always both the best and the worst of its kind, so the
//   summary would contradict itself.
//
//   A dimension also needs at least TWO qualifying groups before it says
//   anything. "Your best hook is 'I found'" is meaningless if it is the only
//   hook ever tried, and that is exactly the state a new channel is in.
//
// WHY IT ALSO NAMES THE WEAKEST
//   Telling a model only what works makes every suggestion the same. Naming
//   both ends gives it something to move away from, which is what keeps the
//   output varied rather than converging on one winning shape.

import { groupStats } from './stats.mjs';

/** Below this many logged results, there is nothing worth learning from. */
export const MIN_RESULTS = 5;

/** Below this many videos in a group, it is an anecdote rather than a pattern. */
export const MIN_PER_GROUP = 2;

/** How often the model should still try something outside the pattern. */
export const EXPLORE_ONE_IN = 5;

const DIMENSIONS = [
  ['format', 'format'],
  ['hook', 'hook'],
  ['len', 'length'],
  ['cta', 'call to action'],
];

const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 100000) return `${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(v);
};

/**
 * What the results say, or nothing at all.
 *
 * Returns { active, count, dimensions: [...], summary }. `active` is false
 * whenever there is not enough to go on, and `summary` is then an empty string
 * — so a caller can add it to a prompt unconditionally and get no change.
 */
export function resultsLesson(rows = []) {
  const results = Array.isArray(rows) ? rows : [];
  const count = results.length;
  const nothing = { active: false, count, dimensions: [], summary: '' };

  if (count < MIN_RESULTS) return nothing;

  const dimensions = [];
  for (const [key, label] of DIMENSIONS) {
    // Only groups with enough videos behind them, and only a dimension where
    // two or more of those exist — otherwise "best" and "worst" are the same
    // thing wearing different hats.
    const groups = groupStats(results, key).filter((g) => g.count >= MIN_PER_GROUP && g.label !== '(none)');
    if (groups.length < 2) continue;

    // groupStats already sorts by average views, best first.
    const best = groups[0];
    const weakest = groups[groups.length - 1];
    dimensions.push({ key, label, best, weakest });
  }

  if (!dimensions.length) return nothing;

  const lines = dimensions.map(({ label, best, weakest }) =>
    `- ${label}: "${best.label}" does best (${best.count} videos, ${compact(best.avg_views)} average views);`
    + ` "${weakest.label}" does worst (${weakest.count} videos, ${compact(weakest.avg_views)} average views)`);

  const summary = `What has actually worked for this creator, from ${count} logged videos:
${lines.join('\n')}

Lean towards what works. But roughly one suggestion in ${EXPLORE_ONE_IN} should be
deliberately different from the patterns above: that list is only what has been
tried so far, not what is possible.`;

  return { active: true, count, dimensions, summary };
}

/** "Personalised from your 12 logged videos" — what the UI shows when it is on. */
export const lessonLabel = (lesson) =>
  (lesson && lesson.active ? `Personalised from your ${lesson.count} logged videos` : '');
