const { getJson, hoursSince } = require('./http');

async function fetchHackerNews() {
  const since = Math.floor(Date.now() / 1000) - 48 * 3600;
  const q = new URLSearchParams({
    tags: 'story', numericFilters: `created_at_i>${since},points>30`, hitsPerPage: '60',
  });
  const data = await getJson(`https://hn.algolia.com/api/v1/search_by_date?${q}`);
  return (data.hits || [])
    .map((h) => ({
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      source: 'hackernews',
      title: h.title,
      summary: `Hacker News · ${h.num_comments || 0} comments`,
      thumbnail: null,
      views: h.points,
      score: Math.round((h.points / hoursSince(h.created_at)) * 10) / 10,
      published_at: h.created_at,
      keyword: null,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

module.exports = { fetchHackerNews };
