const { getJson, getText, hoursSince } = require('./http');

const decode = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#32;/g, ' ').replace(/&amp;/g, '&');

// Preferred: public JSON (has upvote counts).
async function fromJson(sub) {
  const data = await getJson(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=15&raw_json=1`);
  return ((data.data && data.data.children) || [])
    .map((c) => c.data)
    .filter((p) => p && !p.stickied && !p.over_18)
    .map((p) => {
      const created = new Date(p.created_utc * 1000).toISOString();
      const external = p.url && !p.is_self && !/reddit\.com|redd\.it/.test(p.url);
      const preview = p.preview && p.preview.images && p.preview.images[0] && p.preview.images[0].source;
      return {
        url: external ? p.url : `https://www.reddit.com${p.permalink}`,
        source: 'reddit',
        title: p.title,
        summary: `r/${sub} · ${p.ups} upvotes · ${p.num_comments} comments`,
        thumbnail: preview ? preview.url : /^https?:/.test(p.thumbnail || '') ? p.thumbnail : null,
        views: p.ups,
        score: Math.round((p.ups / hoursSince(created)) * 10) / 10,
        published_at: created,
        keyword: `r/${sub}`,
      };
    });
}

// Fallback: Reddit often blocks anonymous JSON (HTTP 403) but still serves the RSS feed.
// RSS has no upvote counts, so score comes from the post's rank in today's top list.
async function fromRss(sub) {
  const xml = await getText(`https://www.reddit.com/r/${sub}/top.rss?t=day&limit=15`, { headers: { Accept: 'application/atom+xml' } });
  const entries = xml.split('<entry>').slice(1);
  return entries.map((e, i) => {
    const tag = (name) => { const m = e.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };
    const permalink = (e.match(/<link href="([^"]+)"/) || [])[1];
    const content = tag('content');
    const external = (content.match(/<a href="([^"]+)">\[link\]<\/a>/) || [])[1];
    const thumb = (e.match(/<media:thumbnail url="([^"]+)"/) || [])[1];
    const published = tag('published') || tag('updated');
    const rankScore = entries.length - i; // #1 of 15 → 15
    return {
      url: external && !/reddit\.com|redd\.it/.test(external) ? decode(external) : decode(permalink),
      source: 'reddit',
      title: tag('title'),
      summary: `r/${sub} · #${i + 1} top today`,
      thumbnail: thumb ? decode(thumb) : null,
      views: null,
      score: Math.round((rankScore / hoursSince(published)) * 10) / 10,
      published_at: published ? new Date(published).toISOString() : null,
      keyword: `r/${sub}`,
    };
  }).filter((p) => p.url && p.title);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let jsonBlocked = false; // once JSON returns 403, go straight to RSS for the rest of this process

async function fetchSubreddit(sub) {
  if (!jsonBlocked) {
    try {
      return await fromJson(sub);
    } catch (e) {
      if (/HTTP 403/.test(e.message)) jsonBlocked = true;
    }
  }
  try {
    return await fromRss(sub);
  } catch (e) {
    if (!/HTTP 429/.test(e.message)) throw e;
    await sleep(3000); // rate limited: wait once and retry
    return fromRss(sub);
  }
}

// Subreddits are fetched one at a time (Reddit rate-limits bursts); one failing sub doesn't drop the others.
async function fetchReddit(subs) {
  const items = [];
  const notes = [];
  for (const [i, sub] of subs.entries()) {
    if (i) await sleep(1200);
    try {
      items.push(...(await fetchSubreddit(sub)));
    } catch (e) {
      notes.push(`r/${sub}: ${e.message}`);
    }
  }
  if (!items.length && notes.length) throw new Error(notes.join('; '));
  return { items, notes };
}

module.exports = { fetchReddit };
