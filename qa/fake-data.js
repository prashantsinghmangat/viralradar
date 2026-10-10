// A stand-in for public/data.js, served in its place during the UI suite.
//
// app.js imports exactly `{ data, readable }` from './data.js', so matching
// those two exports is enough to run the REAL index.html, app.js and
// styles.css against controlled data — which is the point: the suite tests
// the view layer, and nothing it finds can be blamed on the network.
//
// Nothing here ships. public/data.js is untouched.
import { resultStats } from './shared/stats.mjs';

const QA = (typeof window !== 'undefined' && window.__QA) || {};
const SCENARIO = QA.scenario || 'default';
// Pinned so "5h ago" is the same string on every run.
const NOW = new Date(QA.now || '2026-10-10T12:00:00+05:30').getTime();
const agoISO = (hours) => new Date(NOW - hours * 3600_000).toISOString();
const dayISO = (daysBack) => new Date(NOW - daysBack * 86400_000).toISOString().slice(0, 10);

// ---------- the awkward strings every screen has to survive ----------
const LONG_NOSPACE = 'Supercalifragilisticexpialidocious'.repeat(4);
const LONG_URL = 'https://example.com/a/very/long/path/that/never/breaks/' + 'segment-'.repeat(12) + 'end?query=' + 'x'.repeat(60);
const DEVANAGARI = 'एआई टूल्स से वायरल वीडियो कैसे बनाएं — पूरी जानकारी हिंदी में';
const HINGLISH = 'Ye free AI tool bawaal hai 🔥 — 5 minute me video ban jayegi 😱';
const LONG_PROMPT = 'Write a complete vertical short-video script about ' + LONG_NOSPACE + ' and include ' + 'detail-'.repeat(20) + 'end.';

// A 16:9 placeholder that loads with no network at all.
const THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2d3344"/><text x="160" y="96" font-size="20" fill="#8c909f" text-anchor="middle">thumb</text></svg>`);

const SOURCES = ['youtube', 'hackernews', 'reddit', 'github'];

function makeTrends() {
  const base = [
    {
      source: 'youtube', url: 'https://youtube.com/watch?v=1', title: HINGLISH,
      summary: 'Channel Name · "ai tools" · A short summary of what this video shows.',
      thumbnail: THUMB, views: 184000, views_per_hour: 12000, score: 12000,
      published_at: agoISO(5), extra: { keyword: 'ai tools' },
    },
    {
      source: 'youtube', url: 'https://youtube.com/watch?v=2', title: DEVANAGARI,
      summary: 'हिंदी चैनल · "useful websites" · एक लंबा सारांश जो कार्ड में समाना चाहिए।',
      thumbnail: null, views: 99400, views_per_hour: 2900, score: 2900,
      published_at: agoISO(26), extra: { keyword: 'useful websites' },
    },
    {
      source: 'hackernews', url: 'https://news.ycombinator.com/item?id=1', title: LONG_NOSPACE,
      summary: '410 points · 618 comments', thumbnail: null,
      views: 410, views_per_hour: 34, score: 34, published_at: agoISO(2), extra: {},
    },
    {
      source: 'reddit', url: 'https://reddit.com/r/LocalLLaMA/comments/1', title: 'DeepSeek R1 on a Raspberry Pi 5 at 14 t/s',
      summary: 'r/LocalLLaMA · 1420 upvotes · 312 comments', thumbnail: THUMB,
      views: 1420, views_per_hour: 88, score: 88, published_at: agoISO(3), extra: { keyword: 'r/LocalLLaMA' },
    },
    {
      source: 'github', url: 'https://github.com/browser-use/browser-use', title: 'browser-use / browser-use',
      summary: '★14100 · Python · Make websites accessible for AI agents',
      thumbnail: null, views: 14100, views_per_hour: 21, score: 21, published_at: agoISO(7), extra: { keyword: 'Python' },
    },
    // A thumbnail that will not load, to prove the fallback.
    {
      source: 'youtube', url: 'https://youtube.com/watch?v=broken', title: 'A video whose thumbnail is gone',
      summary: 'Broken thumbnail case', thumbnail: '/qa-missing-thumbnail.png',
      views: 0, views_per_hour: 0, score: 0, published_at: agoISO(49), extra: { keyword: 'edge case' },
    },
    // Every optional field missing.
    {
      source: 'hackernews', url: 'https://news.ycombinator.com/item?id=bare', title: 'A bare item with no summary, views or keyword',
      summary: null, thumbnail: null, views: null, views_per_hour: null, score: 3,
      published_at: null, extra: {},
    },
  ];
  if (SCENARIO === 'empty') return [];
  if (SCENARIO === 'single') return [base[0]];
  if (SCENARIO === 'many') {
    return Array.from({ length: 120 }, (_, i) => ({
      ...base[i % base.length],
      url: `https://example.com/trend/${i}`,
      title: `${i + 1}. ${base[i % base.length].title}`,
      score: 5000 - i * 20,
    }));
  }
  return base;
}

const IDEAS = [
  { id: 'idea_1', date: dayISO(0), title: HINGLISH, hook: 'Ye tool dekh ke yakeen nahi hoga', tool: 'ExampleTool', show: 'Screen recording of the tool', why: 'Saves an hour of work', format: 'demo', status: 'new', origin_at: agoISO(3) },
  { id: 'idea_2', date: dayISO(0), title: DEVANAGARI, hook: 'एक मिनट में समझिए', tool: 'हिंदी टूल', show: 'डेमो', why: 'तेज़ और मुफ़्त', format: 'tip', status: 'picked', origin_at: agoISO(6) },
  { id: 'idea_3', date: dayISO(2), title: LONG_NOSPACE, hook: LONG_NOSPACE, tool: '', show: '', why: '', format: 'listicle', status: 'skipped', origin_at: agoISO(50) },
  { id: 'idea_4', date: dayISO(2), title: 'An idea with nothing else filled in', hook: null, tool: null, show: null, why: null, format: null, status: 'new', origin_at: agoISO(52) },
];

const DEMO = {
  tool: 'ExampleTool', url: LONG_URL,
  prepare: ['A free account on the site', 'A sample image on the desktop'],
  steps: ['Open the site', 'Click "New project"', 'Paste the prompt below', 'Press Generate'],
  prompts: [LONG_PROMPT, 'A short second prompt.'],
  check: ['The result actually rendered', 'No watermark on the export'],
  checked: true,
};

const EDIT_PLAN = {
  total_sec: 30,
  timeline: [
    { at: '0-3s', clip: 'Face to camera', action: 'Say the hook', text: 'BAWAAL TOOL', sfx: 'whoosh', tip: 'Start mid-sentence' },
    { at: '3-12s', clip: 'Screen record', action: 'Show the result first', text: 'DEKHO', sfx: '', tip: '' },
    { at: '12-30s', clip: 'Screen record', action: 'Walk through the steps', text: '', sfx: '', tip: 'Keep cuts on information' },
  ],
  captions: 'Big, centred, two words a line.',
  music: { mood: 'Upbeat', search: 'lofi tech', volume: 'Low under the voice' },
  cover: { frame: 'The moment the result appears', text: 'FREE AI TOOL' },
  checklist: ['Captions burned in', 'No watermark', 'Hook under 3 seconds'],
};

const FULL_SCRIPT = {
  id: 'scr_full', topic: HINGLISH, title: HINGLISH, stage: 'to_shoot', language: 'Hinglish',
  own_idea: true, source: 'gemini', origin_at: agoISO(20),
  beats: [
    { t: '0-3s', say: 'Ye tool dekh ke yakeen nahi hoga — ek minute me video ban gayi.', screen: 'Face to camera, then cut to screen' },
    { t: '3-12s', say: DEVANAGARI, screen: 'Screen recording of the result' },
    { t: '12-30s', say: LONG_NOSPACE, screen: 'Walk through each step on screen' },
  ],
  thumbnail_text: 'FREE AI TOOL', yt_title: 'This free AI tool builds a video in one minute',
  ig_caption: 'Save this one 🔥', fb_caption: 'A free tool worth a minute of your time.',
  hashtags: ['#AITools', '#Shorts', '#' + LONG_NOSPACE],
  pinned_comment: 'Link is in the description.', broll: ['Typing on a keyboard', 'The export finishing'],
  audio: 'Upbeat lofi, low under the voice',
  raw: {
    created_at: agoISO(20), demo: DEMO, edit_plan: EDIT_PLAN,
    original: { mode: 'generate', title: HINGLISH, details: 'My own idea, typed out.', links: [LONG_URL] },
  },
};

const SCRIPTS = [
  FULL_SCRIPT,
  { id: 'scr_bare', topic: 'A script with nothing optional', title: 'A script with nothing optional', stage: 'shot', language: 'English', own_idea: false, source: 'shorts-studio', origin_at: agoISO(40), beats: [], hashtags: [], broll: [], raw: {} },
  { id: 'scr_hindi', topic: DEVANAGARI, title: DEVANAGARI, stage: 'edited', language: 'Hindi', own_idea: false, source: 'openrouter', origin_at: agoISO(60), beats: [{ t: '0-5s', say: DEVANAGARI, screen: 'कैमरा' }], hashtags: ['#हिंदी'], broll: [], raw: { demo: { ...DEMO, checked: false } } },
  { id: 'scr_posted', topic: LONG_NOSPACE, title: LONG_NOSPACE, stage: 'posted', language: 'English', own_idea: false, source: 'gemini', origin_at: agoISO(90), beats: [], hashtags: [], broll: [], raw: {} },
];

const RESULTS = [
  { id: 'res_1', title: HINGLISH, posted_on: dayISO(1), platforms: ['youtube', 'instagram'], format: 'demo', hook: 'I found', len: '30s', cta: 'save this', views: 184000, likes: 9100, comments: 310, shares: 220, saves: 4100, follows: 180 },
  { id: 'res_2', title: DEVANAGARI, posted_on: dayISO(2), platforms: ['youtube'], format: 'tip', hook: 'Stop doing', len: '45s', cta: 'follow for a new tool every day', views: 42000, likes: 2100, comments: 90, shares: 60, saves: 900, follows: 40 },
  { id: 'res_3', title: LONG_NOSPACE, posted_on: dayISO(4), platforms: ['facebook'], format: 'listicle', hook: '3 things', len: '60s', cta: 'comment for the link', views: 0, likes: 0, comments: 0, shares: 0, saves: 0, follows: 0 },
  { id: 'res_4', title: 'A result with gaps', posted_on: null, platforms: [], format: null, hook: null, len: null, cta: null, views: 1200, likes: null, comments: null, shares: null, saves: 30, follows: null, origin_at: agoISO(200) },
];

const PROJECT_ITEMS = {
  proj_1: [
    { id: 'it_1', project_id: 'proj_1', kind: 'text', content: 'A note typed on the bus.\nWith a second line.', preview: 'A note typed on the bus.', from_device: 'Phone', created_at: agoISO(2) },
    { id: 'it_2', project_id: 'proj_1', kind: 'link', content: LONG_URL, preview: LONG_URL.slice(0, 80), from_device: 'Laptop', created_at: agoISO(5) },
    { id: 'it_3', project_id: 'proj_1', kind: 'video_ref', file_name: 'raw-take-2.mp4', size_bytes: 1_840_000_000, sha256: 'a'.repeat(64), devices: ['Laptop', 'Phone'], from_device: 'Phone', created_at: agoISO(8) },
    { id: 'it_4', project_id: 'proj_1', kind: 'text', content: DEVANAGARI, preview: DEVANAGARI, from_device: 'Phone', created_at: agoISO(9) },
  ],
  proj_empty: [],
};

const PROJECTS = [
  { id: 'proj_1', title: HINGLISH, script_id: 'scr_full', status: 'active', is_inbox: false, own_idea: true, language: 'Hinglish', local_folder_name: '2026-10-10 ' + HINGLISH.slice(0, 20), origin_at: agoISO(20), item_count: 4, bytes: 1_840_000_000, latest: PROJECT_ITEMS.proj_1[0] },
  { id: 'proj_inbox', title: 'Inbox', script_id: null, status: 'active', is_inbox: true, own_idea: false, language: null, local_folder_name: null, origin_at: agoISO(100), item_count: 2, bytes: 0, latest: null },
  { id: 'proj_posted', title: DEVANAGARI, script_id: null, status: 'posted', is_inbox: false, own_idea: false, language: 'Hindi', local_folder_name: null, origin_at: agoISO(200), posted_at: agoISO(30), item_count: 0, bytes: 0, latest: null },
  { id: 'proj_archived', title: LONG_NOSPACE, script_id: null, status: 'archived', is_inbox: false, own_idea: false, language: null, local_folder_name: null, origin_at: agoISO(400), item_count: 1, bytes: 2048, latest: null },
  { id: 'proj_empty', title: 'An empty folder', script_id: null, status: 'active', is_inbox: false, own_idea: false, language: null, local_folder_name: null, origin_at: agoISO(12), item_count: 0, bytes: 0, latest: null },
];

const SETTINGS_ROW = {
  user_id: 'user-1',
  niche_keywords: ['ai tools', 'free ai website', 'useful websites', 'chatgpt tricks', 'coding tips', 'tech hacks'],
  language: 'English', default_length: '30s',
  ai_order: ['gemini', 'openrouter'],
  gemini_model: 'gemini-2.5-flash', openrouter_model: 'meta-llama/llama-3.3-70b-instruct:free',
  radar_languages: ['hi', 'en'], weekly_goal: 5,
};

const PACK = {
  topic: HINGLISH,
  main_tool: {
    name: 'ExampleTool', url: LONG_URL, reachable: true,
    what_it_does: 'Turns a prompt into a short video.',
    how_it_works_simple: 'You type a prompt, it renders a clip.',
    free_details: { signup: 'Email only', watermark: 'None on the free plan', limits: '5 videos a day', export_quality: '1080p' },
    steps: DEMO.steps, prompts: DEMO.prompts, best_inputs: ['Short, concrete prompts'], settings: ['Set the aspect ratio to 9:16'],
  },
  alternatives: [{ name: 'OtherTool', url: 'https://example.org', reachable: false, one_line: 'Similar, but slower.' }],
  fact_check: [
    { claim: 'The free plan adds no watermark.', status: 'verified', source_url: LONG_URL },
    { claim: 'It renders in under ten seconds.', status: 'unverified', source_url: 'https://example.net/claim' },
  ],
  test_plan: ['Render one clip before filming'], recording_checklist: ['Clear the browser of other tabs'],
  sources: [LONG_URL, 'https://example.org'],
  unreachable: [{ url: 'https://example.org', error: 'timed out' }],
  checked: true, grounded: true, verified_count: 1, unverified_count: 1, unchecked_count: 0,
  downgraded_count: 0, researched_at: agoISO(1),
};

// ---------- the module app.js actually imports ----------
const fail = (doing) => { throw new Error(`Could not ${doing}: the fake data layer was asked for a failure.`); };
const maybeFail = (doing) => { if (SCENARIO === 'error') fail(doing); };
const copy = (v) => JSON.parse(JSON.stringify(v));

export function readable(error, doing) {
  if (!error) return null;
  return `Could not ${doing}: ${error.message || error}`;
}

export const TABLES = { ideas: 'ideas', scripts: 'scripts', results: 'results', trends: 'trends' };
export const LIVE_TABLES = ['ideas', 'scripts', 'results'];
export const PROJECT_LIVE_TABLES = ['projects', 'project_items'];

const SESSION = { access_token: 'fake', user: { id: 'user-1', email: 'sampleuser@gmail.com' } };

export const data = {
  auth: {
    session: async () => (QA.signedOut ? null : SESSION),
    user: async () => (QA.signedOut ? null : SESSION.user),
    signInWithPassword: async () => { throw new Error('Wrong email or password.'); },
    signIn: async () => true,
    signOut: async () => {},
    onChange: () => () => {},
  },
  settings: {
    get: async () => { maybeFail('read your settings'); return copy(SETTINGS_ROW); },
    update: async (_id, patch) => ({ ...copy(SETTINGS_ROW), ...patch }),
  },
  ideas: {
    list: async () => { maybeFail('load your ideas'); return SCENARIO === 'empty' ? [] : SCENARIO === 'single' ? [copy(IDEAS[0])] : copy(IDEAS); },
    setStatus: async (id, status) => ({ id, status }),
    remove: async () => null,
    create: async ({ title }) => ({ id: 'idea_new', title, status: 'new' }),
  },
  scripts: {
    list: async () => { maybeFail('load your scripts'); return SCENARIO === 'empty' ? [] : SCENARIO === 'single' ? [copy(SCRIPTS[0])] : copy(SCRIPTS); },
    get: async (id) => {
      maybeFail('open that script');
      const s = SCRIPTS.find((x) => x.id === id);
      if (!s) throw new Error('Script not found.');
      return copy(s);
    },
    setStage: async (id, stage) => ({ id, stage }),
    remove: async () => null,
  },
  results: {
    list: async () => { maybeFail('load your results'); return SCENARIO === 'empty' ? [] : copy(RESULTS); },
    stats: async () => resultStats(SCENARIO === 'empty' ? [] : copy(RESULTS), dayISO(0)),
    remove: async () => null,
  },
  trends: {
    latestDay: async () => dayISO(0),
    list: async () => {
      maybeFail('load the radar');
      const trends = makeTrends();
      return { day: trends.length ? dayISO(0) : null, trends };
    },
    refresh: async () => ({ total: 7, sources: { youtube: { notes: [] } } }),
  },
  usage: { today: async () => ({ youtube: { units: 606, requests: 6 } }) },
  tokens: {
    list: async () => [{ id: 'tok_1', label: 'laptop', last_used_at: agoISO(30), created_at: agoISO(300) }],
    create: async (_u, _l, token) => token,
    revoke: async () => null,
  },
  projects: {
    list: async () => { maybeFail('load your projects'); return SCENARIO === 'empty' ? [] : copy(PROJECTS); },
    get: async (id) => {
      const p = PROJECTS.find((x) => x.id === id);
      if (!p) throw new Error('That project is no longer there.');
      return copy(p);
    },
    items: async (id) => copy(PROJECT_ITEMS[id] || []),
    create: async ({ title }) => ({ id: 'proj_new', title, status: 'active', is_inbox: false }),
    inbox: async () => copy(PROJECTS[1]),
    forScript: async () => copy(PROJECTS[0]),
    setStatus: async (id, status) => ({ id, status, posted_at: null }),
    rename: async (id, title) => ({ id, title }),
    setLocalFolderName: async (id, name) => [{ id, local_folder_name: name }],
    remove: async () => null,
  },
  items: {
    addText: async () => copy(PROJECT_ITEMS.proj_1[0]),
    addFile: async () => copy(PROJECT_ITEMS.proj_1[0]),
    fileUrl: async () => THUMB,
    addVideoRef: async () => copy(PROJECT_ITEMS.proj_1[2]),
    remove: async () => null,
  },
  storage: {
    used: async () => 41_943_040,
    usage: async () => ({ used: 41_943_040, free: 272_629_760, cap: 314_572_800, percent: 13, full: false, text: '40 MB of 300 MB used' }),
    purge: async () => ({ message: 'Nothing to delete.' }),
  },
  devices: {
    join: async () => ({
      send: () => {}, onMessage: () => () => {},
      waitFor: () => new Promise(() => {}),
      peers: () => [{ id: 'peer-2', device: 'Laptop', canStream: true, at: NOW }],
      rename: () => {}, leave: () => {},
    }),
  },
  imports: {
    send: async () => ({ message: 'Imported 3 ideas.' }),
    recent: async () => (SCENARIO === 'empty' ? [] : [
      { kind: 'idea', id: 'idea_1', title: HINGLISH, created_at: agoISO(3) },
      { kind: 'script', id: 'scr_full', title: null, yt_title: FULL_SCRIPT.yt_title, created_at: agoISO(20) },
      { kind: 'result', id: 'res_1', title: DEVANAGARI, created_at: agoISO(26) },
    ]),
  },
  ai: {
    generate: async (body) => {
      maybeFail('write that');
      if (body.kind === 'hooks') {
        return {
          message: '3 hooks from gemini', provider: 'gemini', topic: body.topic,
          hooks: [
            { label: 'Hook A', style: 'bold claim', line: 'Agar tum abhi bhi purana tarika use kar rahe ho, toh ruk jao.' },
            { label: 'Hook B', style: 'relatable problem', line: DEVANAGARI },
            { label: 'Hook C', style: 'direct challenge', line: LONG_NOSPACE },
          ],
        };
      }
      if (body.kind === 'angles') {
        return {
          message: '5 angles from gemini', provider: 'gemini', personalised: true, results_count: 12,
          angles: [
            { type: 'Discovery', title: HINGLISH, hook: 'Ye tool abhi mila', twist: 'Shows it cold' },
            { type: 'Experiment', title: DEVANAGARI, hook: 'मैंने टेस्ट किया', twist: 'Tries it on something odd' },
            { type: 'Comparison', title: LONG_NOSPACE, hook: LONG_NOSPACE, twist: LONG_NOSPACE },
          ],
        };
      }
      if (body.kind === 'test') {
        return { providers: [{ ok: true, name: 'gemini', model: 'gemini-2.5-flash', detail: '1.9s' }, { ok: false, name: 'openrouter', model: 'llama', detail: 'no key' }] };
      }
      return { message: 'Wrote 1 script.', provider: 'gemini', ids: ['scr_full'] };
    },
    research: async () => ({ pack: copy(PACK), project_id: 'proj_1', item_id: 'it_9', provider: 'gemini', urls_from: 'given', warning: '' }),
  },
  backup: {
    download: async () => ({ app: 'viralradar', backup_version: 3, tables: {} }),
    restore: async () => ({ scripts: 1, ideas: 2, results: 3 }),
  },
  live: () => () => {},
  liveProjects: () => () => {},
  callFunction: async () => ({ providers: [] }),
};

if (typeof window !== 'undefined') window.VR = data;
