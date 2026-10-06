// The Reddit RSS fallback: Reddit blocks anonymous JSON often enough that this
// path runs most days. It is parsed with regexes over a template literal, which
// is easy to break, so a fake feed is parsed here on every test run.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchReddit } = require('../shared/sources/reddit.mjs');

const FEED = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:media=\"http://search.yahoo.com/mrss/\">\n  <entry>\n    <title>A free site that\nspans two lines &amp; has an ampersand</title>\n    <link href=\"https://www.reddit.com/r/webdev/comments/a1/x/\" />\n    <published>PUB1</published>\n    <content type=\"html\">&lt;a href=\"https://example.com/tool\"&gt;[link]&lt;/a&gt;</content>\n    <media:thumbnail url=\"https://thumb.example/1.jpg\" />\n  </entry>\n  <entry>\n    <title>Self post with no outside link</title>\n    <link href=\"https://www.reddit.com/r/webdev/comments/a2/y/\" />\n    <published>PUB2</published>\n    <content type=\"html\">&lt;p&gt;text only&lt;/p&gt;</content>\n  </entry>\n</feed>"
  .replace('PUB1', new Date(Date.now() - 2 * 3600000).toISOString())
  .replace('PUB2', new Date(Date.now() - 4 * 3600000).toISOString());

// First call is the JSON endpoint (403, as Reddit usually does), then the RSS feed.
function stub({ jsonStatus = 403, rss = FEED } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('.json')) {
      return { ok: jsonStatus === 200, status: jsonStatus, text: async () => '{"error":"blocked"}' };
    }
    return { ok: true, status: 200, text: async () => rss };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('blocked JSON falls back to the RSS feed and parses every entry', async () => {
  const s = stub();
  try {
    const { items, notes } = await fetchReddit(['webdev']);
    assert.deepEqual(notes, []);
    assert.equal(items.length, 2);

    const [first, second] = items;
    // The multi-line, entity-escaped title must come through whole.
    assert.equal(first.title, ['A free site that', 'spans two lines & has an ampersand'].join(String.fromCharCode(10)));
    // An external [link] in the content wins over the reddit permalink.
    assert.equal(first.url, 'https://example.com/tool');
    assert.equal(first.thumbnail, 'https://thumb.example/1.jpg');
    assert.equal(first.source, 'reddit');
    assert.equal(first.keyword, 'r/webdev');
    assert.equal(first.summary, 'r/webdev · #1 top today');
    assert.equal(first.views, null, 'RSS carries no upvote count');
    // Rank-based score: #1 of 2 entries, posted 2 hours ago.
    assert.equal(first.score, 1);

    // A self post keeps its reddit permalink.
    assert.equal(second.url, 'https://www.reddit.com/r/webdev/comments/a2/y/');
    assert.equal(second.title, 'Self post with no outside link');
    assert.ok(second.score < first.score, 'lower rank and older post scores lower');
    assert.ok(Date.parse(second.published_at) < Date.parse(first.published_at));
  } finally { s.restore(); }
});

test('entries with no title or no url are dropped', async () => {
  const s = stub({ rss: '<feed><entry><link href="https://a.com/1" /></entry></feed>' });
  try {
    const { items } = await fetchReddit(['webdev']);
    assert.deepEqual(items, []);
  } finally { s.restore(); }
});

test('one failing subreddit is noted but the others still return items', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/r/broken/')) return { ok: false, status: 500, text: async () => 'boom' };
    if (u.includes('.json')) return { ok: false, status: 403, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => FEED };
  };
  try {
    const { items, notes } = await fetchReddit(['webdev', 'broken']);
    assert.equal(items.length, 2);
    assert.equal(notes.length, 1);
    assert.match(notes[0], new RegExp("^r\\/broken: HTTP 500"));
  } finally { globalThis.fetch = real; }
});

test('when every subreddit fails the whole source fails, so the radar reports it', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  try {
    await assert.rejects(() => fetchReddit(['a']), /HTTP 500/);
  } finally { globalThis.fetch = real; }
});
