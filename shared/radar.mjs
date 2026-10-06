// Runs every trend source independently and dedupes the results by URL.
// Pure: it fetches and merges, but never writes. Callers persist the outcome
// (SQLite locally, Postgres in the refresh-trends Edge Function).

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const p of [...url.searchParams.keys()]) if (/^utm_|^ref$|^si$/.test(p)) url.searchParams.delete(p);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'; // also catches "page/\" which the parser turns into "page//"
    return url.toString().replace('://www.', '://').replace(/^http:/, 'https:');
  } catch {
    return u;
  }
}

/**
 * @param {Record<string, () => Promise<any>>} sources  name → fetcher returning items[] or {items, notes, skipped}
 * @returns {Promise<{items: object[], status: Record<string, object>, names: string[], total: number}>}
 */
export async function collect(sources) {
  const names = Object.keys(sources);
  const settled = await Promise.allSettled(names.map((n) => sources[n]()));

  const status = {};
  const byUrl = new Map();
  settled.forEach((r, i) => {
    const name = names[i];
    if (r.status === 'rejected') {
      status[name] = { ok: false, count: 0, error: r.reason && r.reason.message };
      return;
    }
    const { items, notes, skipped } = Array.isArray(r.value) ? { items: r.value, notes: [] } : r.value;
    status[name] = { ok: true, count: items.length, notes, ...(skipped && { skipped: true }) };
    for (const it of items) {
      if (!it.url || !it.title) continue;
      const key = normalizeUrl(it.url);
      const prev = byUrl.get(key);
      if (!prev || (it.score || 0) > (prev.score || 0)) byUrl.set(key, { ...it, url: key });
    }
  });

  const items = [...byUrl.values()];
  return { items, status, names, total: items.length };
}

export const failedSources = (status) => Object.keys(status).filter((n) => !status[n].ok);
