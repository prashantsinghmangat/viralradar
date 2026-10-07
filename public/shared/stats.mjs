// GENERATED FILE - DO NOT EDIT.
// Copied from shared/stats.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// Results analytics. Pure functions over result rows, so the same code runs
// on the server (local build) and in the browser (cloud build).
const DAY = 86400000;

export function groupStats(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = (r[key] ?? '').toString().trim() || '(none)';
    const g = groups.get(k) || { label: k, count: 0, views: 0, saves: 0 };
    g.count++;
    g.views += r.views || 0;
    g.saves += r.saves || 0;
    groups.set(k, g);
  }
  return [...groups.values()]
    .map((g) => ({
      label: g.label,
      count: g.count,
      avg_views: Math.round(g.views / g.count),
      save_rate: g.views ? Math.round((g.saves / g.views) * 10000) / 100 : 0, // percent
    }))
    .sort((a, b) => b.avg_views - a.avg_views);
}

export function streaks(dates, today) {
  const days = [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')))].sort();
  if (!days.length) return { current: 0, longest: 0, last_posted: null };
  const t = (d) => Date.parse(`${d}T00:00:00Z`);
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = t(days[i]) - t(days[i - 1]) === DAY ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  // Current streak counts back from today, or from yesterday if nothing is posted yet today.
  const set = new Set(days);
  let cursor = t(today);
  if (!set.has(today)) cursor -= DAY;
  let current = 0;
  while (set.has(new Date(cursor).toISOString().slice(0, 10))) { current++; cursor -= DAY; }
  return { current, longest, last_posted: days[days.length - 1] };
}

/** The whole Results screen payload, computed from plain result rows. */
export function resultStats(rows, today) {
  const totalViews = rows.reduce((s, x) => s + (x.views || 0), 0);
  const totalSaves = rows.reduce((s, x) => s + (x.saves || 0), 0);
  return {
    count: rows.length,
    total_views: totalViews,
    avg_views: rows.length ? Math.round(totalViews / rows.length) : 0,
    save_rate: totalViews ? Math.round((totalSaves / totalViews) * 10000) / 100 : 0,
    by: { format: groupStats(rows, 'format'), hook: groupStats(rows, 'hook'), len: groupStats(rows, 'len'), cta: groupStats(rows, 'cta') },
    streak: streaks(rows.map((x) => x.posted_on), today),
    top: [...rows].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5)
      .map(({ id, title, views, saves, posted_on, format }) => ({ id, title, views, saves, posted_on, format })),
  };
}
