import { getJson } from '../http.mjs';
import { hoursSince } from '../time.mjs';

export async function fetchGitHub({ token = '' } = {}) {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const q = new URLSearchParams({ q: `created:>${since}`, sort: 'stars', order: 'desc', per_page: '20' });
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = await getJson(`https://api.github.com/search/repositories?${q}`, { headers });
  return (data.items || []).map((r) => ({
    url: r.html_url,
    source: 'github',
    title: r.full_name,
    summary: `${r.description ? r.description.slice(0, 140) : 'New GitHub repo'} · ★${r.stargazers_count}${r.language ? ` · ${r.language}` : ''}`,
    thumbnail: r.owner && r.owner.avatar_url,
    views: r.stargazers_count,
    views_per_hour: null,
    score: Math.round((r.stargazers_count / hoursSince(r.created_at)) * 10) / 10,
    published_at: r.created_at,
    keyword: r.language || null,
  }));
}
