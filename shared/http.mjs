// fetch with a hard timeout and JSON parsing; throws on non-2xx.
// Uses only the global fetch/AbortController, so it runs on Node and Deno alike.
export async function getJson(url, opts = {}) {
  return JSON.parse(await getText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } }));
}

export async function getText(url, { timeoutMs = 10000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ViralRadar/1.0 (local personal app)', ...headers },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).trim(); } catch { /* ignore */ }
      if (detail.startsWith('<')) detail = ''; // skip HTML error pages
      try { const j = JSON.parse(detail); detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch { /* not JSON */ }
      detail = String(detail).slice(0, 300);
      const err = new Error(`HTTP ${res.status} from ${new URL(url).host}${detail ? `: ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs / 1000}s: ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export { hoursSince } from './time.mjs';
