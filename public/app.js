/* ViralRadar frontend — plain JS, hash routing, no build step beyond copying.
 *
 * The screens and their markup are unchanged from the local version. What
 * changed is underneath: there is no server of ours any more, so every read and
 * write goes through data.js to Supabase, and live updates arrive over Realtime
 * instead of Server-Sent Events.
 */
import { data, readable } from './data.js';
import { newToken, hashToken } from './shared/tokens.mjs';
import { LENGTHS, DEFAULT_AI_ORDER } from './shared/defaults.mjs';
import { readEditPlan, editPlanText } from './shared/edit-plan.mjs';
import { lessonLabel } from './shared/learning.mjs';
import {
  MAX_FILE_BYTES, POSTED_RETENTION_DAYS, TOTAL_BYTES_CAP,
  checkUpload, cleanDeviceName, downloadUrl, formatBytes, guessDeviceName, itemPreview, usageSummary,
} from './shared/projects.mjs';
import {
  BIG_FILE_BYTES, SIGNAL, TransferCancelled,
  acceptPrompt, formatDuration, sendWarning, videoRefSummary,
} from './shared/transfer.mjs';
import { canStreamToDisk, newPeerId, pickSink, receiveFrom, sendTo } from './transfer.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-IN'));
const compact = (n) => {
  if (n == null) return '—';
  n = Number(n);
  if (n >= 1e7) return (n / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n * 10) / 10);
};
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function toast(message, bad = false, ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), bad ? ms + 2500 : ms);
}

// Clipboard API only works on https/localhost; phones over plain http need the textarea fallback.
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const saved = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
  return ok;
}
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  return fallbackCopy(text);
}

// Copy buttons reference text by index so long text never sits in HTML attributes.
let copyStore = [];
const copyBtn = (text, label = 'Copy', cls = 'sm') => {
  copyStore.push(String(text ?? ''));
  return `<button type="button" class="${cls}" data-copy="${copyStore.length - 1}">${esc(label)}</button>`;
};

/** Download something the browser made, without a server to serve it. */
function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- theme ----------
$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = isDark ? 'light' : 'dark';
  try { localStorage.setItem('vr-theme', root.dataset.theme); } catch { /* private mode */ }
});

// ---------- who is signed in ----------
const state = {
  session: null, settings: null, stopLive: null, stopProjectLive: null,
  // The device channel, this tab's peer id, and which of my other devices are
  // online. See the video transfer section.
  devices: null, peerId: null, peers: [], deviceError: '',
};
const userId = () => state.session?.user?.id ?? null;

// ---------- which device this is ----------
//
// "New from Laptop" only means something if this device knows what it is
// called. The name is per device, so it belongs in localStorage rather than in
// the settings row that every device shares. It is only ever a label — nothing
// is decided by it — so a browser in private mode falling back to a guess
// costs nothing.
const DEVICE_KEY = 'vr-device-name';

function deviceName() {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved) return cleanDeviceName(saved);
  } catch { /* private mode */ }
  return guessDeviceName(navigator.userAgent);
}

function setDeviceName(name) {
  const clean = cleanDeviceName(name, guessDeviceName(navigator.userAgent));
  try { localStorage.setItem(DEVICE_KEY, clean); } catch { /* private mode */ }
  return clean;
}

// ---------- live updates ----------
//
// An import on the laptop, or a script generated on the phone, shows up on the
// other device a second or two later. The policies apply to Realtime too, so
// only your own rows ever arrive.
const LIVE_LABEL = { ideas: 'idea', scripts: 'script', results: 'result' };
let liveTimer = null;

function startLive() {
  if (state.stopLive) return;
  const counts = new Map();
  state.stopLive = data.live(({ table, event }) => {
    if (event === 'DELETE') return; // deleting from this device already redrew
    counts.set(table, (counts.get(table) || 0) + 1);
    // An import of 20 ideas fires 20 events; wait a moment and say it once.
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      const parts = [...counts.entries()].map(([t, n]) => `${n} ${LIVE_LABEL[t]}${n === 1 ? '' : 's'}`);
      counts.clear();
      toast(`Updated from another device: ${parts.join(', ')}`);
      if (['radar', 'ideas', 'scripts', 'results', 'import'].includes(currentRoute())) render();
    }, 600);
  });
}

function stopLive() {
  if (state.stopLive) state.stopLive();
  state.stopLive = null;
  if (state.stopProjectLive) state.stopProjectLive();
  state.stopProjectLive = null;
  stopDevices();
  clearTimeout(liveTimer);
}

// ---------- project folders, arriving from the other device ----------
//
// This is the point of the whole feature: paste a link on the laptop, and the
// phone says so a second later without being touched. So it gets its own
// message naming the device and showing a preview, rather than being counted
// into the generic "updated from another device" one.
//
// An item this device just added comes back over Realtime too. Saying "New
// from Phone" on the phone that sent it would be nonsense, so items whose
// from_device matches this one are redrawn silently.
function startProjectLive() {
  if (state.stopProjectLive) return;
  state.stopProjectLive = data.liveProjects(({ table, event, row }) => {
    const onProjectScreen = currentRoute() === 'projects';
    if (event === 'DELETE') {
      if (onProjectScreen) render();
      return;
    }
    if (table === 'project_items' && event === 'INSERT') {
      const from = row && row.from_device;
      if (from && from !== deviceName()) {
        toast(`New from ${from}: ${itemPreview(row)}`, false, 6000);
      }
    }
    if (onProjectScreen) render();
  });
}

// ---------- router ----------
//
// The hash can carry a query — "#/projects?shared=1" is how the service worker
// reports back after a share — so it is split off before anything else. Without
// that, the route name would be "projects?shared=1", match nothing, and quietly
// land on the radar.
function parseHash(hash = location.hash) {
  const [path] = hash.replace(/^#\/?/, '').split('?');
  const [name, ...rest] = path.split('/');
  return { name, params: rest.map(decodeURIComponent) };
}
const currentRoute = () => parseHash().name || 'radar';
const routes = { radar: renderRadar, ideas: renderIdeas, scripts: renderScripts, projects: renderProjects, results: renderResults, import: renderImport, settings: renderSettings };
let renderToken = 0;

async function render() {
  if (!state.session) return renderLogin();
  const token = ++renderToken;
  const { name, params } = parseHash();
  const route = routes[name] ? name : 'radar';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  stopPrompter();
  try {
    const html = await routes[route](params);
    if (token !== renderToken) return; // a newer navigation won
    copyStore = copyStore.slice(-500);
    view.innerHTML = html;
    afterRender[route] && afterRender[route]();
  } catch (e) {
    if (token !== renderToken) return;
    view.innerHTML = `<div class="empty"><span class="big">⚠️</span>${esc(e.message)}</div>`;
  }
}
const afterRender = {};

window.addEventListener('hashchange', () => { copyStore = []; render().then(() => window.scrollTo(0, 0)); });

// One delegated click handler for the whole app.
view.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy],[data-action]');
  if (!btn) return;
  if (btn.dataset.copy !== undefined) {
    e.stopPropagation();
    const ok = await copyText(copyStore[Number(btn.dataset.copy)]);
    if (ok) {
      const old = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = old; }, 1400);
    } else toast('Copy failed — long-press the text to copy it manually.', true);
    return;
  }
  const fn = actions[btn.dataset.action];
  if (fn) { e.preventDefault(); e.stopPropagation(); fn(btn, e); }
});
const actions = {};

// ================= SIGN IN =================
//
// Email and password. The password is not in this code and not in the
// repository: it lives hashed in Supabase, and nothing here could hold one
// safely, because every file on this page is served to whoever asks for it.
//
// Signing in once per device is the whole cost. The session renews itself, so
// this screen should not come back unless the browser's data is cleared.
function renderLogin(message = '') {
  document.body.classList.add('signed-out');
  $('#nav').hidden = true;
  view.innerHTML = `
    <div class="signin">
      <h1>ViralRadar</h1>
      <p class="muted">Sign in once on this device. It stays signed in afterwards.</p>
      ${message ? `<div class="notice">${esc(message)}</div>` : ''}
      <div class="card stack" style="max-width:420px">
        <label class="field" for="email">Email address</label>
        <input type="email" id="email" autocomplete="username" inputmode="email" placeholder="you@example.com" spellcheck="false">
        <label class="field" for="password">Password</label>
        <input type="password" id="password" autocomplete="current-password" placeholder="Your password">
        <div><button type="button" class="primary" data-action="signInPassword">Sign in</button></div>
        <div id="signinResult"></div>
        <p class="muted small" style="margin:0">
          Forgotten it? <button type="button" class="linkish" data-action="sendLink">Email me a sign-in link instead</button>
        </p>
      </div>
      <p class="muted small" style="margin-top:16px">Only accounts that have been allowed can use ViralRadar.</p>
    </div>`;
  const email = $('#email');
  if (email) {
    try { email.value = localStorage.getItem('vr-email') || ''; } catch { /* private mode */ }
    email.focus();
    if (email.value) $('#password').focus();
  }
  for (const id of ['#email', '#password']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') actions.signInPassword($('[data-action=signInPassword]'));
    });
  }
}

actions.signInPassword = async (btn) => {
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const box = $('#signinResult');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  box.innerHTML = '';
  try {
    await data.auth.signInWithPassword(email, password);
    try { localStorage.setItem('vr-email', email); } catch { /* private mode */ }
    // onAuthStateChange takes it from here and draws the app.
  } catch (e) {
    box.innerHTML = `<div class="badge bad" style="display:block;border-radius:10px;padding:10px 12px;white-space:normal">${esc(e.message)}</div>`;
    $('#password').value = '';
    $('#password').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
};

actions.sendLink = async (btn) => {
  const email = $('#email').value.trim();
  const box = $('#signinResult');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await data.auth.signIn(email, location.origin + location.pathname);
    try { localStorage.setItem('vr-email', email); } catch { /* private mode */ }
    box.innerHTML = `<div class="notice"><b>Check your email.</b><br>A sign-in link is on its way to ${esc(email)}. Open it on this device.</div>`;
    btn.textContent = 'Send another link';
  } catch (e) {
    box.innerHTML = `<div class="badge bad" style="display:block;border-radius:10px;padding:10px 12px;white-space:normal">${esc(e.message)}</div>`;
    btn.textContent = 'Email me a sign-in link instead';
  } finally {
    btn.disabled = false;
  }
};

actions.signOut = async () => {
  stopLive();
  await data.auth.signOut();
  state.session = null;
  state.settings = null;
  renderLogin('You are signed out.');
};

// ================= RADAR =================
let radarSource = '';
const SOURCE = {
  youtube: { label: 'YouTube', icon: '▶️', unit: 'views/hr' },
  hackernews: { label: 'Hacker News', icon: '🟧', unit: 'pts/hr' },
  reddit: { label: 'Reddit', icon: '👽', unit: 'upvotes/hr' },
  github: { label: 'GitHub', icon: '🐙', unit: 'stars/hr' },
};

async function renderRadar() {
  const [{ day, trends }, usage] = await Promise.all([data.trends.list(radarSource), data.usage.today()]);
  const yt = usage.youtube || { units: 0, requests: 0 };

  const cards = trends.map((t, i) => {
    const s = SOURCE[t.source] || { label: t.source, icon: '🔗', unit: '/hr' };
    const keyword = t.extra && t.extra.keyword;
    const copy = `${t.title}\n${t.url}\n${t.summary || ''}`.trim();
    const thumb = t.thumbnail
      ? `<img src="${esc(t.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${s.icon}'))">`
      : s.icon;
    const viewsLabel = t.source === 'youtube' ? 'views' : t.source === 'github' ? 'stars' : t.source === 'reddit' ? 'upvotes' : 'points';
    return `<article class="card trend ${t.source === 'youtube' ? '' : 'wide'}">
      <div class="thumb">${thumb}</div>
      <div>
        <div class="rank">#${i + 1} · ${s.icon} ${esc(s.label)}${keyword ? ` · ${esc(keyword)}` : ''}</div>
        <h3>${esc(t.title)}</h3>
        <div class="meta">${t.views != null ? `<span><b>${compact(t.views)}</b> ${viewsLabel}</span>` : ''}<span><b>${compact(t.score)}</b> ${t.views == null ? 'rank pts/hr' : s.unit}</span><span>${ago(t.published_at)}</span></div>
        <div class="summary">${esc(t.summary || '')}</div>
        <div class="actions">
          <a class="btn sm" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
          <button type="button" class="btn sm primary" data-action="writeScript" data-topic="${esc([t.title, t.summary].filter(Boolean).join(' — ').slice(0, 300))}">✍️ Write script</button>
          ${ANGLES_BUTTON([t.title, t.summary].filter(Boolean).join(' — ').slice(0, 300))}
          ${copyBtn(copy, 'Copy', 'sm')}
        </div>
      </div>
    </article>`;
  }).join('');

  return `
    <div class="page-head">
      <h1>Radar</h1>
      <button type="button" class="primary" data-action="refreshRadar">↻ Refresh now</button>
    </div>
    <div class="status-line">
      ${day ? `<span>Collected ${esc(day)}</span>` : '<span>Not run yet. Tap “Refresh now”, or wait for 7:00 AM IST.</span>'}
      <span class="badge accent" title="search.list costs 100 units, videos.list costs 1">YouTube today: ${yt.requests} searches · ${fmt(yt.units)} units</span>
    </div>
    ${renderAngles()}
    <div class="chips" style="margin-bottom:14px">
      ${[['', 'All'], ...Object.entries(SOURCE).map(([k, v]) => [k, v.label])].map(([k, l]) =>
        `<button type="button" class="chip ${radarSource === k ? 'on' : ''}" data-action="radarSource" data-v="${k}">${esc(l)}</button>`).join('')}
    </div>
    ${trends.length ? `<div class="grid">${cards}</div>`
      : `<div class="empty"><span class="big">📡</span>No trends yet${day ? ' for this source' : ''}.<br>Tap <b>Refresh now</b> to scan YouTube, Hacker News, Reddit and GitHub.</div>`}
    <p class="muted small">Scores are per-hour velocity within each source (views, points, upvotes or stars per hour since posting), so compare within a source using the filter above.</p>`;
}
actions.radarSource = (btn) => { radarSource = btn.dataset.v; render(); };
actions.refreshRadar = async (btn) => {
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Refreshing… up to 30 sec';
  try {
    const r = await data.trends.refresh();
    toast(`Found ${r.total} trends`);
  } catch (e) { toast(e.message, true); }
  render();
};

// ================= ANGLES =================
//
// The step between "here is a trend" and "here is a script".
//
// Asking for a script straight off a trending video gives you the video
// somebody else already made. Asking for angles first gives five different ways
// in — tried it on something odd, did not believe it, three more like it — and
// then the script is written to whichever one you pick.
//
// They are never stored. An angle is a decision on the way to a script, and
// writing five of them to the database every time a trend was looked at would
// fill the Ideas screen with things nobody chose to make. They live here until
// dismissed, and render at the top of whichever screen asked for them.
let angles = null; // { topic, items: [...], personalised, resultsCount }

function renderAngles() {
  if (!angles) return '';
  const cards = angles.items.map((a, i) => `
    <article class="card angle">
      <div class="rank">${esc(a.type || `Angle ${i + 1}`)}</div>
      <h3>${esc(a.title || '(untitled)')}</h3>
      ${a.hook ? `<div class="angle-hook">“${esc(a.hook)}”</div>` : ''}
      ${a.twist ? `<div class="muted small">${esc(a.twist)}</div>` : ''}
      <div class="actions">
        <button type="button" class="sm primary" data-action="writeAngle" data-i="${i}">✍️ Write this angle</button>
        ${copyBtn([a.title, a.hook, a.twist].filter(Boolean).join('\n'), 'Copy', 'sm')}
      </div>
    </article>`).join('');

  return `
    <section class="angles-block">
      <div class="page-head" style="margin-bottom:8px">
        <h2 style="margin:0;font-size:1rem">🎯 Angles on: ${esc(angles.topic.slice(0, 80))}</h2>
        ${angles.personalised ? `<span class="badge accent">${esc(lessonLabel({ active: true, count: angles.resultsCount }))}</span>` : ''}
        <button type="button" class="sm ghost" data-action="closeAngles">✕ Close</button>
      </div>
      <p class="muted small">Pick one. The script is then written to that angle rather than to the plainest
        version of the subject — which is the one everybody else made.</p>
      <div class="grid">${cards}</div>
    </section>`;
}

actions.closeAngles = () => { angles = null; render(); };

/** Ask for angles on a subject. The button carries the topic. */
actions.findAngles = async (btn) => {
  const topic = btn.dataset.topic;
  if (!topic) { toast('Nothing to find angles on.', true); return; }
  const result = await askAi(btn, { kind: 'angles', topic });
  if (!result) return;
  angles = {
    topic,
    items: result.angles || [],
    personalised: result.personalised === true,
    resultsCount: result.results_count || 0,
  };
  render();
  window.scrollTo(0, 0);
};

actions.writeAngle = (btn) => {
  const angle = angles && angles.items[Number(btn.dataset.i)];
  if (!angle) { toast('That angle is no longer there.', true); return; }
  // The topic goes with it: the angle says how, the topic says what.
  return askAi(btn, { kind: 'script', topic: angles.topic, angle });
};

/** "🎯 Find angles" — on anything that could become a video. */
const ANGLES_BUTTON = (topic) =>
  `<button type="button" class="btn sm" data-action="findAngles" data-topic="${esc(topic)}">🎯 Find angles</button>`;

// ================= IDEAS =================
let ideaFilter = 'all';
async function renderIdeas() {
  const ideas = await data.ideas.list();
  const counts = { all: ideas.length, new: 0, picked: 0, skipped: 0 };
  ideas.forEach((i) => { counts[i.status] = (counts[i.status] || 0) + 1; });
  const list = ideas.filter((i) => ideaFilter === 'all' || i.status === ideaFilter);
  const groups = new Map();
  for (const i of list) {
    const d = (i.date || i.origin_at || '').slice(0, 10) || 'No date';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(i);
  }
  const fields = [['hook', 'Hook'], ['tool', 'Tool'], ['show', 'Show'], ['why', 'Why'], ['format', 'Format']];
  const body = [...groups.entries()].map(([d, items]) => `
    <section class="day-group">
      <h2>${esc(d === 'No date' ? d : new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</h2>
      <div class="grid">${items.map((i) => `
        <article class="card idea ${i.status}">
          <div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(i.title || '(untitled)')}</h3>
            ${i.status !== 'new' ? `<span class="badge ${i.status === 'picked' ? 'good' : ''}">${i.status === 'picked' ? 'Picked' : 'Skipped'}</span>` : ''}</div>
          <dl>${fields.filter(([k]) => i[k]).map(([k, l]) => `<dt>${l}</dt><dd>${esc(i[k])}</dd>`).join('')}</dl>
          <div class="row" style="justify-content:space-between">
            <div class="seg">
              <button type="button" class="${i.status === 'picked' ? 'on-good' : ''}" data-action="ideaStatus" data-id="${esc(i.id)}" data-v="${i.status === 'picked' ? 'new' : 'picked'}">✓ Picked</button>
              <button type="button" class="${i.status === 'skipped' ? 'on-bad' : ''}" data-action="ideaStatus" data-id="${esc(i.id)}" data-v="${i.status === 'skipped' ? 'new' : 'skipped'}">✕ Skip</button>
            </div>
            ${copyBtn([i.title, i.hook, i.tool, i.show, i.why].filter(Boolean).join('\n'), 'Copy')}
          </div>
          <div class="actions">
            <button type="button" class="sm primary" data-action="writeScript" data-topic="${esc([i.title, i.hook, i.tool].filter(Boolean).join(' — ').slice(0, 300))}">✍️ Write script</button>
            ${ANGLES_BUTTON([i.title, i.hook, i.tool].filter(Boolean).join(' — ').slice(0, 300))}
          </div>
        </article>`).join('')}</div>
    </section>`).join('');

  return `
    <div class="page-head"><h1>Ideas</h1><button type="button" class="primary" data-action="generateIdeas">✨ Generate ideas</button>${PASTE_BUTTON()}</div>
    ${renderAngles()}
    <div class="chips" style="margin-bottom:14px">
      ${[['all', 'All'], ['new', 'New'], ['picked', 'Picked'], ['skipped', 'Skipped']].map(([k, l]) =>
        `<button type="button" class="chip ${ideaFilter === k ? 'on' : ''}" data-action="ideaFilter" data-v="${k}">${l} · ${counts[k] || 0}</button>`).join('')}
    </div>
    ${body || `<div class="empty"><span class="big">💡</span>${ideas.length ? 'Nothing here with this filter.' : 'No ideas yet. Export ideas from Shorts Studio and they will appear here.'}</div>`}`;
}
actions.ideaFilter = (btn) => { ideaFilter = btn.dataset.v; render(); };
actions.ideaStatus = async (btn) => {
  try { await data.ideas.setStatus(btn.dataset.id, btn.dataset.v); render(); }
  catch (e) { toast(e.message, true); }
};

// ================= SCRIPTS =================
const STAGES = [['to_shoot', 'To shoot'], ['shot', 'Shot'], ['edited', 'Edited'], ['posted', 'Posted']];
const stageIdx = (s) => STAGES.findIndex(([k]) => k === s);

async function renderScripts(params) {
  if (params[0]) return renderScriptDetail(params[0]);
  const scripts = await data.scripts.list();
  const canDrag = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const cols = STAGES.map(([key, label], idx) => {
    const items = scripts.filter((s) => s.stage === key);
    return `<section class="col" data-stage="${key}">
      <h2><span>${label}</span><span>${items.length}</span></h2>
      <div class="cards">${items.map((s) => `
        <article class="card script-card" data-id="${esc(s.id)}" data-action="openScript" ${canDrag ? 'draggable="true"' : ''}>
          <div class="t">${esc(s.title || s.yt_title || s.topic || s.id)}</div>
          ${s.topic && s.title ? `<div class="muted small">${esc(s.topic)}</div>` : ''}
          <div class="actions">
            ${idx > 0 ? `<button type="button" class="sm ghost" data-action="moveScript" data-id="${esc(s.id)}" data-v="${STAGES[idx - 1][0]}" title="Move back">← ${STAGES[idx - 1][1]}</button>` : '<span></span>'}
            ${idx < STAGES.length - 1 ? `<button type="button" class="sm" data-action="moveScript" data-id="${esc(s.id)}" data-v="${STAGES[idx + 1][0]}">${STAGES[idx + 1][1]} →</button>` : ''}
          </div>
        </article>`).join('') || '<div class="muted small" style="padding:8px 4px">Empty</div>'}</div>
    </section>`;
  }).join('');
  return `
    <div class="page-head"><h1>Scripts</h1><span class="muted small">${canDrag ? 'Drag cards between columns, or use the arrows.' : 'Tap the arrow to move a script.'}</span>${PASTE_BUTTON()}</div>
    <div class="card row" style="margin-bottom:14px;gap:8px">
      <input type="text" id="scriptTopic" placeholder="Write a script about…  e.g. a free site that removes image backgrounds" style="flex:1">
      <button type="button" class="primary" data-action="writeScriptFromBox">✍️ Write script</button>
    </div>
    ${scripts.length ? `<div class="board">${cols}</div>` : '<div class="empty"><span class="big">🎬</span>No scripts yet. Write one above, paste an export, or generate an idea first.</div>'}`;
}
actions.openScript = (card) => { location.hash = `#/scripts/${encodeURIComponent(card.dataset.id)}`; };
async function moveScript(id, stage) {
  try {
    await data.scripts.setStage(id, stage);
    render();
  } catch (e) { toast(e.message, true); }
}
actions.moveScript = (btn) => moveScript(btn.dataset.id, btn.dataset.v);

afterRender.scripts = () => {
  let dragId = null;
  $$('.script-card[draggable=true]').forEach((c) => {
    c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; });
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); $$('.col').forEach((x) => x.classList.remove('drop')); });
  });
  $$('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); col.classList.add('drop'); } });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const id = dragId || e.dataTransfer.getData('text/plain');
      dragId = null;
      const card = $(`.script-card[data-id="${CSS.escape(id)}"]`);
      if (id && card && card.closest('.col') !== col) moveScript(id, col.dataset.stage);
    });
  });
  if ($('.prompter')) setupPrompter();
};

async function renderScriptDetail(id) {
  const s = await data.scripts.get(id);
  const beats = Array.isArray(s.beats) ? s.beats : [];
  const tags = (s.hashtags || []).map((t) => (String(t).startsWith('#') ? t : '#' + t)).join(' ');
  const fullScript = beats.map((b) => b.say).filter(Boolean).join('\n\n');
  const outputs = [
    ['Thumbnail text', s.thumbnail_text],
    ['YouTube title', s.yt_title],
    ['Instagram caption', s.ig_caption],
    ['Facebook caption', s.fb_caption],
    ['Hashtags', tags],
    ['Pinned comment', s.pinned_comment],
    ['B-roll', (s.broll || []).join('\n')],
    ['Audio', s.audio],
    ['Full voiceover', fullScript],
  ].filter(([, v]) => v);
  const idx = stageIdx(s.stage);
  // The export's own timestamp lives on in raw; the column is when the row was made.
  const created = (s.raw && s.raw.created_at) || s.origin_at;

  return `
    <div class="detail-head">
      <a class="btn sm ghost" href="#/scripts">← Board</a>
      <h1>${esc(s.title || s.yt_title || s.id)}</h1>
    </div>
    <div class="row" style="margin-bottom:14px">
      <div class="seg">${STAGES.map(([k, l], i) => `<button type="button" class="${i === idx ? 'on' : ''}" data-action="setStage" data-id="${esc(s.id)}" data-v="${k}">${l}</button>`).join('')}</div>
      <button type="button" class="sm" data-action="openScriptProject" data-id="${esc(s.id)}">📁 Open project</button>
      ${s.topic ? `<span class="muted small">Topic: ${esc(s.topic)}</span>` : ''}
      ${created ? `<span class="muted small">Created ${esc(when(created))}</span>` : ''}
      ${s.source && s.source !== 'shorts-studio' ? `<span class="badge accent">Written by ${esc(s.source)}</span>` : ''}
    </div>

    <section class="prompter" id="prompter">
      <div class="prompter-tools">
        <button type="button" class="sm primary" data-action="prompterFull">⛶ Teleprompter</button>
        <button type="button" class="sm" data-action="prompterPlay" data-full-only hidden>▶ Play</button>
        <button type="button" class="sm" data-action="prompterSpeed" data-v="-1" data-full-only hidden>Slower</button>
        <button type="button" class="sm" data-action="prompterSpeed" data-v="1" data-full-only hidden>Faster</button>
        <button type="button" class="sm" data-action="prompterSize" data-v="-1">A−</button>
        <button type="button" class="sm" data-action="prompterSize" data-v="1">A+</button>
        <button type="button" class="sm" data-action="prompterMirror" data-full-only hidden>Mirror</button>
        <button type="button" class="sm" data-action="prompterExit" data-full-only hidden>✕ Close</button>
        ${fullScript ? copyBtn(fullScript, 'Copy script') : ''}
      </div>
      <div class="beats">
        ${beats.length ? beats.map((b) => `<div class="beat">
          ${b.t ? `<div class="bt">${esc(b.t)}</div>` : ''}
          <div class="say">${esc(b.say || '')}</div>
          ${b.screen ? `<div class="screen">🎥 ${esc(b.screen)}</div>` : ''}
        </div>`).join('') : '<p class="muted">This script has no beats.</p>'}
      </div>
    </section>

    ${renderEditPlan(s)}

    <div class="outputs grid">
      ${outputs.map(([label, value]) => `<div class="card out">
        <div class="out-head"><h3>${esc(label)}</h3>${copyBtn(value)}</div>
        <pre>${esc(value)}</pre>
      </div>`).join('')}
    </div>
    <p style="margin-top:20px"><button type="button" class="sm ghost" data-action="deleteScript" data-id="${esc(s.id)}">Delete script</button></p>`;
}
// ---- edit plan ----
//
// Shorts Studio can attach a shooting-and-editing plan to a script. It has no
// column of its own: it rides along in `raw`, so it has been arriving since the
// first import. Scripts without one show nothing at all, which is most of them.
function renderEditPlan(script) {
  const plan = readEditPlan(script);
  const makeButton = (label) =>
    `<button type="button" class="sm" data-action="makeEditPlan" data-id="${esc(script.id)}">${esc(label)}</button>`;

  // No plan yet: offer to write one rather than showing nothing and leaving
  // people to wonder whether the feature exists.
  if (!plan) {
    return `
      <section class="edit-plan">
        <div class="page-head" style="margin-top:22px">
          <h2 style="margin:0">Edit plan</h2>
          ${makeButton('✨ Make edit plan')}
        </div>
        <p class="muted small">A shot-by-shot plan for filming and editing this one: timeline, captions, music, cover and a checklist.</p>
      </section>`;
  }

  const step = (s) => {
    const head = [s.at, s.clip, s.action].filter(Boolean).map(esc).join('<span class="sep">·</span>');
    const detail = [
      s.text && `<div class="on-screen">“${esc(s.text)}”</div>`,
      s.sfx && `<div class="muted small">🔊 ${esc(s.sfx)}</div>`,
      s.tip && `<div class="muted small">💡 ${esc(s.tip)}</div>`,
    ].filter(Boolean).join('');
    return `<li>${head ? `<div class="step-head">${head}</div>` : ''}${detail}</li>`;
  };

  const music = [
    plan.music.mood && ['Mood', plan.music.mood],
    plan.music.search && ['Search for', plan.music.search],
    plan.music.volume && ['Volume', plan.music.volume],
  ].filter(Boolean);
  const cover = [
    plan.cover.frame && ['Frame', plan.cover.frame],
    plan.cover.text && ['Text', plan.cover.text],
  ].filter(Boolean);

  const block = (title, body) => (body ? `<section class="card stack"><h3>${title}</h3>${body}</section>` : '');
  const pairs = (rows) => `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

  return `
    <section class="edit-plan">
      <div class="page-head" style="margin-top:22px">
        <h2 style="margin:0">Edit plan${plan.total_sec ? ` <span class="muted small">${plan.total_sec}s</span>` : ''}</h2>
        <div class="row" style="gap:6px">
          ${copyBtn(editPlanText(plan), 'Copy edit plan', 'sm primary')}
          ${makeButton('↻ Redo')}
        </div>
      </div>
      ${plan.timeline.length ? `<section class="card"><ol class="timeline">${plan.timeline.map(step).join('')}</ol></section>` : ''}
      <div class="grid">
        ${block('Captions', plan.captions ? `<p class="small">${esc(plan.captions)}</p>` : '')}
        ${block('Music', music.length ? pairs(music) : '')}
        ${block('Cover', cover.length ? pairs(cover) : '')}
        ${block('Before you post', plan.checklist.length
          ? `<ul class="checklist">${plan.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '')}
      </div>
    </section>`;
}

actions.setStage = async (btn) => {
  try { await data.scripts.setStage(btn.dataset.id, btn.dataset.v); render(); }
  catch (e) { toast(e.message, true); }
};

/**
 * The folder for this script, made the first time it is asked for.
 *
 * One button for "open" and "create" on purpose: from here they are the same
 * intention, and being asked to name a folder you are already looking at the
 * script for is a question with only one sensible answer.
 */
actions.openScriptProject = async (btn) => {
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const script = await data.scripts.get(btn.dataset.id);
    const project = await data.projects.forScript(script);
    location.hash = `#/projects/${encodeURIComponent(project.id)}`;
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = '📁 Open project';
  }
};
actions.deleteScript = async (btn) => {
  if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Tap again to delete'; btn.classList.add('copied'); return; }
  try {
    await data.scripts.remove(btn.dataset.id);
    toast('Script deleted');
    location.hash = '#/scripts';
  } catch (e) { toast(e.message, true); }
};

// ---- teleprompter ----
const prompter = { raf: 0, playing: false, speed: 1.2, size: 1.6, last: 0 };
function setupPrompter() {
  try { prompter.size = Number(localStorage.getItem('vr-prompt-size')) || prompter.size; } catch { /* ignore */ }
  $('#prompter').style.setProperty('--prompt-size', prompter.size + 'rem');
}
function stopPrompter() {
  cancelAnimationFrame(prompter.raf);
  prompter.playing = false;
  document.body.style.overflow = '';
}
function tick(ts) {
  const el = $('#prompter');
  if (!el || !prompter.playing) return;
  const dt = prompter.last ? Math.min(ts - prompter.last, 100) : 16;
  prompter.last = ts;
  el.scrollTop += prompter.speed * dt * 0.03;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) { togglePlay(false); return; }
  prompter.raf = requestAnimationFrame(tick);
}
function togglePlay(force) {
  prompter.playing = force ?? !prompter.playing;
  const b = $('[data-action=prompterPlay]');
  if (b) b.textContent = prompter.playing ? '❚❚ Pause' : '▶ Play';
  cancelAnimationFrame(prompter.raf);
  if (prompter.playing) { prompter.last = 0; prompter.raf = requestAnimationFrame(tick); }
}
actions.prompterFull = () => {
  const el = $('#prompter');
  el.classList.add('full');
  el.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  $$('[data-full-only]', el).forEach((b) => (b.hidden = false));
  $('[data-action=prompterFull]').hidden = true;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
};
actions.prompterExit = () => {
  const el = $('#prompter');
  togglePlay(false);
  el.classList.remove('full', 'mirror');
  document.body.style.overflow = '';
  $$('[data-full-only]', el).forEach((b) => (b.hidden = true));
  $('[data-action=prompterFull]').hidden = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
};
actions.prompterPlay = () => togglePlay();
actions.prompterSpeed = (b) => { prompter.speed = Math.max(0.3, Math.min(6, prompter.speed + Number(b.dataset.v) * 0.3)); toast(`Speed ${prompter.speed.toFixed(1)}×`, false, 900); };
actions.prompterSize = (b) => {
  prompter.size = Math.max(1, Math.min(4.5, prompter.size + Number(b.dataset.v) * 0.25));
  $('#prompter').style.setProperty('--prompt-size', prompter.size + 'rem');
  try { localStorage.setItem('vr-prompt-size', prompter.size); } catch { /* ignore */ }
};
actions.prompterMirror = () => $('#prompter').classList.toggle('mirror');
// Tap the text in full-screen mode to play/pause.
view.addEventListener('click', (e) => {
  const el = $('#prompter.full');
  if (el && e.target.closest('.beats')) togglePlay();
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && $('#prompter.full')) actions.prompterExit(); });
document.addEventListener('keydown', (e) => {
  if (!$('#prompter.full')) return;
  if (e.key === 'Escape') actions.prompterExit();
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});

// ================= RESULTS =================
let resultDim = 'format';
function hbars(rows, valueKey, format) {
  if (!rows.length) return '<p class="muted small">No data.</p>';
  const max = Math.max(...rows.map((r) => r[valueKey]), 0) || 1;
  return `<div class="hbar">${rows.slice(0, 10).map((r) => {
    const pct = (r[valueKey] / max) * 82; // leave room for the value at the tip
    const tip = `${r.label}: ${format(r[valueKey])} · ${r.count} video${r.count === 1 ? '' : 's'}`;
    return `<div class="lab" title="${esc(r.label)}">${esc(r.label)}</div>
      <div class="track" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><div class="bar" style="width:${pct}%"></div><span class="val">${format(r[valueKey])}</span></div>`;
  }).join('')}</div>`;
}

async function renderResults() {
  const rows = await data.results.list();
  if (!rows.length) return '<div class="page-head"><h1>Results</h1></div><div class="empty"><span class="big">📈</span>No results yet. Log results in Shorts Studio and export them here.</div>';
  const st = await data.results.stats();
  const dims = [['format', 'Format'], ['hook', 'Hook'], ['len', 'Length'], ['cta', 'CTA']];
  const groups = [...st.by[resultDim]];
  const bySave = [...groups].sort((a, b) => b.save_rate - a.save_rate);
  const dimLabel = dims.find(([k]) => k === resultDim)[1];
  return `
    <div class="page-head"><h1>Results</h1></div>
    <div class="tiles">
      <div class="card tile"><div class="k">Videos</div><div class="v">${fmt(st.count)}</div></div>
      <div class="card tile"><div class="k">Total views</div><div class="v">${compact(st.total_views)}</div></div>
      <div class="card tile"><div class="k">Avg views</div><div class="v">${compact(st.avg_views)}</div></div>
      <div class="card tile"><div class="k">Save rate</div><div class="v">${st.save_rate}%</div></div>
      <div class="card tile"><div class="k">Streak 🔥</div><div class="v">${st.streak.current} day${st.streak.current === 1 ? '' : 's'}</div></div>
      <div class="card tile"><div class="k">Best streak</div><div class="v">${st.streak.longest}</div></div>
    </div>

    <div class="chips" style="margin-bottom:12px">${dims.map(([k, l]) => `<button type="button" class="chip ${resultDim === k ? 'on' : ''}" data-action="resultDim" data-v="${k}">By ${l}</button>`).join('')}</div>
    <div class="charts" style="margin-bottom:16px">
      <section class="card"><h2>Average views by ${esc(dimLabel.toLowerCase())}</h2>${hbars(groups, 'avg_views', compact)}</section>
      <section class="card"><h2>Save rate by ${esc(dimLabel.toLowerCase())}</h2>${hbars(bySave, 'save_rate', (v) => v + '%')}</section>
    </div>

    <div class="charts" style="margin-bottom:16px">
      <section class="card"><h2>Top 5 videos</h2>
        <ol class="top5">${st.top.map((t) => `<li><b>${esc(t.title || t.id)}</b><br><span class="muted small">${fmt(t.views)} views · ${fmt(t.saves)} saves · ${esc(t.posted_on || '')}${t.format ? ' · ' + esc(t.format) : ''}</span></li>`).join('')}</ol>
      </section>
      <section class="card"><h2>Posting</h2>
        <p class="small">Current streak: <b>${st.streak.current}</b> day(s). Longest: <b>${st.streak.longest}</b>. Last posted: <b>${esc(st.streak.last_posted || '—')}</b>.</p>
        <p class="muted small">Streak counts consecutive days with at least one result posted, including today or ending yesterday.</p>
      </section>
    </div>

    <h2>All results</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Posted</th><th>Title</th><th>Platforms</th><th>Format</th><th>Hook</th><th>Len</th><th>CTA</th>
        <th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Shares</th><th class="num">Saves</th><th class="num">Save %</th><th class="num">Follows</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.posted_on || '')}</td><td style="white-space:normal;min-width:200px">${esc(r.title || r.id)}</td><td>${esc((r.platforms || []).join(', '))}</td>
        <td>${esc(r.format || '')}</td><td>${esc(r.hook || '')}</td><td>${esc(r.len || '')}</td><td>${esc(r.cta || '')}</td>
        <td class="num">${fmt(r.views)}</td><td class="num">${fmt(r.likes)}</td><td class="num">${fmt(r.comments)}</td><td class="num">${fmt(r.shares)}</td>
        <td class="num">${fmt(r.saves)}</td><td class="num">${r.views ? ((r.saves || 0) / r.views * 100).toFixed(2) + '%' : '—'}</td><td class="num">${fmt(r.follows)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}
actions.resultDim = (btn) => { resultDim = btn.dataset.v; render(); };

// ================= PROJECTS =================
//
// A folder per video, and the one place the phone and the laptop meet. Notes,
// links, screenshots and a thumbnail draft go in; raw video never does — it is
// far bigger than the 300 MB this app allows itself out of a shared Supabase
// project, and Part 2 sends it device to device instead.

const PROJECT_STATUSES = [['active', 'Active'], ['posted', 'Posted'], ['archived', 'Archived']];
const ITEM_ICON = { text: '📝', link: '🔗', image: '🖼️', file: '📎', video_ref: '📹' };

async function renderProjects(params) {
  if (params[0]) return renderProjectDetail(params[0]);

  const [list, usage] = await Promise.all([data.projects.list(), data.storage.usage()]);
  const cards = list.map((p) => {
    const latest = p.latest
      ? `<div class="muted small">${esc(itemPreview(p.latest, 70))}${p.latest.from_device ? ` · from ${esc(p.latest.from_device)}` : ''} · ${esc(ago(p.latest.created_at))}</div>`
      : '<div class="muted small">Empty. Open it and send something.</div>';
    return `<article class="card project" data-id="${esc(p.id)}" data-action="openProject">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <h3 style="margin:0">${p.is_inbox ? '📥 ' : '📁 '}${esc(p.title)}</h3>
        ${p.status !== 'active' ? `<span class="badge ${p.status === 'posted' ? 'good' : ''}">${esc(p.status === 'posted' ? 'Posted' : 'Archived')}</span>` : ''}
      </div>
      <div class="muted small">${p.item_count} item${p.item_count === 1 ? '' : 's'}${p.bytes ? ` · ${esc(formatBytes(p.bytes))}` : ''}</div>
      ${latest}
    </article>`;
  }).join('');

  return `
    <div class="page-head">
      <h1>Projects</h1>
      <span class="muted small">${esc(usage.text)}</span>
    </div>
    <div class="card row" style="margin-bottom:14px;gap:8px">
      <input type="text" id="newProject" placeholder="New project…  e.g. Background remover demo" style="flex:1">
      <button type="button" class="primary" data-action="createProject">📁 Create</button>
      <button type="button" data-action="openInbox">📥 Inbox</button>
    </div>
    ${list.length ? `<div class="grid">${cards}</div>`
      : '<div class="empty"><span class="big">📁</span>No projects yet.<br>Create one above, or open one from a script.</div>'}
    <p class="muted small">Files in a project marked <b>Posted</b> are deleted after ${POSTED_RETENTION_DAYS} days, so this
      shared Supabase project is never filled up. Notes and links are kept.</p>`;
}

actions.openProject = (card) => { location.hash = `#/projects/${encodeURIComponent(card.dataset.id)}`; };

actions.openInbox = async (btn) => {
  btn.disabled = true;
  try {
    const inbox = await data.projects.inbox();
    location.hash = `#/projects/${encodeURIComponent(inbox.id)}`;
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
};

actions.createProject = async (btn) => {
  const input = $('#newProject');
  const title = input.value.trim();
  if (!title) { toast('What is the project called?', true); input.focus(); return; }
  btn.disabled = true;
  try {
    const project = await data.projects.create({ title });
    location.hash = `#/projects/${encodeURIComponent(project.id)}`;
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
};

async function renderProjectDetail(id) {
  const [project, list, usage] = await Promise.all([
    data.projects.get(id),
    data.projects.items(id),
    data.storage.usage(),
  ]);

  // Signed URLs, because nothing in this bucket is public. They last five
  // minutes, which is longer than anyone looks at a screen before reloading,
  // and they are only made for the items actually on screen.
  const stored = list.filter((i) => i.storage_path).slice(0, 60);
  const urls = new Map();
  await Promise.all(stored.map(async (item) => {
    try {
      urls.set(item.id, await data.items.fileUrl(item.storage_path));
    } catch {
      // A file that has been cleaned up, or a transient failure. The item
      // still shows; it just says the file is gone rather than offering a
      // button that would do nothing.
    }
  }));

  const idx = PROJECT_STATUSES.findIndex(([k]) => k === project.status);
  const rows = list.map((item) => {
    const icon = ITEM_ICON[item.kind] || '📎';
    const url = urls.get(item.id) || '';
    // A video_ref's size is in its own summary line, so it is not repeated here.
    const meta = [item.from_device && `from ${item.from_device}`, ago(item.created_at),
      item.kind !== 'video_ref' && item.size_bytes && formatBytes(item.size_bytes)].filter(Boolean).join(' · ');

    let body = '';
    let buttons = '';
    if (item.kind === 'video_ref') {
      // A note that a video exists, and that it arrived unchanged. The video
      // itself was never uploaded — it went device to device.
      body = `<div class="item-text">${esc(item.file_name)}</div>
        <div class="muted small">${esc(videoRefSummary(item))}</div>`;
      buttons = copyBtn(item.sha256 || '', 'Copy SHA-256');
    } else if (item.kind === 'text') {
      body = `<div class="item-text">${esc(item.content)}</div>`;
      buttons = copyBtn(item.content, 'Copy');
    } else if (item.kind === 'link') {
      body = `<a class="item-link" href="${esc(item.content)}" target="_blank" rel="noopener noreferrer">${esc(item.content)}</a>`;
      buttons = copyBtn(item.content, 'Copy');
    } else if (!url) {
      body = `<div class="muted small">${esc(item.file_name)} — this file is no longer stored.</div>`;
    } else {
      body = item.kind === 'image'
        ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img class="item-image" src="${esc(url)}" alt="${esc(item.file_name)}" loading="lazy"></a>`
        : `<div class="item-text">${esc(item.file_name)}</div>`;
      // A cross-origin `download` attribute is ignored, so the saving is asked
      // for in the URL instead — see downloadUrl() in shared/projects.mjs.
      buttons = `<a class="btn sm primary" href="${esc(downloadUrl(url, item.file_name))}" target="_blank" rel="noopener noreferrer">⬇ Download</a>`;
    }

    return `<li class="item">
      <div class="item-head">
        <span class="muted small">${icon} ${esc(meta)}</span>
        <div class="row" style="gap:6px">
          ${buttons}
          <button type="button" class="sm ghost" data-action="deleteItem" data-id="${esc(item.id)}">Delete</button>
        </div>
      </div>
      ${body}
    </li>`;
  }).join('');

  return `
    <div class="detail-head">
      <a class="btn sm ghost" href="#/projects">← Projects</a>
      <h1>${project.is_inbox ? '📥 ' : '📁 '}${esc(project.title)}</h1>
    </div>
    <div class="row" style="margin-bottom:14px">
      <div class="seg">${PROJECT_STATUSES.map(([k, l], i) =>
        `<button type="button" class="${i === idx ? 'on' : ''}" data-action="setProjectStatus" data-id="${esc(project.id)}" data-v="${k}">${l}</button>`).join('')}</div>
      ${project.script_id ? `<a class="btn sm" href="#/scripts/${encodeURIComponent(project.script_id)}">🎬 Its script</a>` : ''}
      <span class="muted small">Sending as <b>${esc(deviceName())}</b></span>
    </div>
    ${project.status === 'posted' ? `<div class="notice">Posted${project.posted_at ? ` ${esc(ago(project.posted_at))}` : ''}.
      Its files are deleted ${POSTED_RETENTION_DAYS} days after that; notes and links stay.</div>` : ''}

    <div class="card stack" style="margin-bottom:16px">
      <div>
        <label class="field" for="sendBox">Send a note or a link</label>
        <textarea id="sendBox" rows="3" placeholder="Paste a link, or type a line you thought of…" spellcheck="false"></textarea>
      </div>
      <div class="row">
        <button type="button" class="primary" data-action="sendText" data-id="${esc(project.id)}">➤ Send</button>
        <label class="btn" for="projectFile">📎 Add files or images…</label>
        <input type="file" id="projectFile" multiple hidden>
        <span class="muted small">Up to ${esc(formatBytes(MAX_FILE_BYTES))} each · ${esc(usage.text)}</span>
      </div>
      <div id="projectResult"></div>
    </div>

    <div class="card stack" style="margin-bottom:16px">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0;font-size:1rem">📹 Send a video to your other device</h2>
        <button type="button" class="primary" data-action="sendVideo" data-id="${esc(project.id)}">Choose a video…</button>
      </div>
      <input type="file" id="videoFile" accept="video/*" hidden>
      ${devicesLine()}
      <p class="muted small" style="margin:0">The video goes straight from this device to the other one — it is never
        uploaded, so its size does not matter and nothing is re-encoded. Both ends work out the file's SHA-256 as it
        goes past and compare them, so “identical to the original” is checked rather than assumed. Only a note saying
        the video exists is saved here.</p>
    </div>

    ${list.length ? `<ul class="items">${rows}</ul>`
      : '<div class="empty"><span class="big">📥</span>Nothing here yet.<br>Send a note from this device, or share something into ViralRadar from your phone.</div>'}`;
}

/**
 * Which of my devices are online, in one line.
 *
 * Shown wherever sending a video is offered, because "nothing happens when I
 * press the button" is almost always "the other device is not open", and that
 * is worth saying before the button is pressed rather than after.
 */
function devicesLine() {
  if (state.deviceError) {
    return `<div class="notice small">${esc(state.deviceError)}</div>`;
  }
  const peers = state.peers || [];
  if (!peers.length) {
    return `<p class="muted small" style="margin:0">Nothing else is online. Open ViralRadar on your other device,
      signed in to the same account, and it will appear here within a second or two.
      Both devices need to be on the same Wi-Fi for a transfer to connect.</p>`;
  }
  return `<p class="small" style="margin:0">Online now: ${peers.map((p) =>
    `<b>${esc(p.device)}</b>${p.canStream ? '' : ' <span class="muted">(downloads rather than saving to disk)</span>'}`).join(', ')}</p>`;
}

actions.setProjectStatus = async (btn) => {
  try {
    await data.projects.setStatus(btn.dataset.id, btn.dataset.v);
    toast(btn.dataset.v === 'posted'
      ? `Marked posted. Its files are deleted in ${POSTED_RETENTION_DAYS} days.`
      : 'Saved');
    render();
  } catch (e) { toast(e.message, true); }
};

actions.sendText = async (btn) => {
  const box = $('#sendBox');
  const text = box.value.trim();
  if (!text) { toast('Type or paste something first.', true); box.focus(); return; }
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await data.items.addText(btn.dataset.id, text, deviceName());
    box.value = '';
    toast('Sent');
    render();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = '➤ Send';
  }
};

actions.deleteItem = async (btn) => {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again';
    btn.classList.add('copied');
    return;
  }
  const projectId = parseHash().params[0];
  try {
    const list = await data.projects.items(projectId);
    const item = list.find((i) => i.id === btn.dataset.id);
    if (!item) throw new Error('That item is already gone.');
    await data.items.remove(item);
    toast('Deleted');
    render();
  } catch (e) { toast(e.message, true); }
};

/**
 * Upload the chosen files, one at a time, saying where it has got to.
 *
 * One at a time rather than all at once: on a phone, three 20 MB uploads in
 * parallel on mobile data is how you get three timeouts instead of one
 * success. The running total of what has been used is kept here so the cap is
 * applied across the whole batch, instead of each file being checked against
 * the figure from before any of them started.
 */
async function uploadFiles(projectId, files) {
  if (!files.length) return;
  const box = $('#projectResult');
  const say = (message, bad = false) => {
    if (box) box.innerHTML = `<div class="badge ${bad ? 'bad' : 'good'}" style="display:block;border-radius:10px;padding:10px 12px;white-space:normal">${esc(message)}</div>`;
  };

  let used;
  try {
    used = await data.storage.used();
  } catch (e) {
    say(e.message, true);
    return;
  }

  let done = 0;
  const failed = [];
  for (const [n, file] of files.entries()) {
    say(`Uploading ${n + 1} of ${files.length}: ${file.name} (${formatBytes(file.size)})…`);
    // Checked here as well as inside the data layer, so the batch stops being
    // uploaded the moment the cap is reached rather than failing file by file.
    const verdict = checkUpload({ size: file.size, usedBytes: used, fileName: file.name });
    if (!verdict.ok) {
      failed.push(verdict.message);
      continue;
    }
    try {
      await data.items.addFile(projectId, file, { userId: userId(), fromDevice: deviceName(), usedBytes: used });
      used += file.size;
      done += 1;
    } catch (e) {
      failed.push(`${file.name}: ${e.message}`);
    }
  }

  if (done) toast(`${done} file${done === 1 ? '' : 's'} added`);
  // Redraw first, then write the message: the redraw replaces the whole screen,
  // so saying it beforehand would wipe the one explanation of what went wrong.
  await render();
  if (failed.length) {
    say(failed.join('\n'), true);
    toast(failed[0], true, 9000);
  } else {
    say(`Added ${done} file${done === 1 ? '' : 's'}. ${usageSummary(used).text}.`);
  }
}

afterRender.projects = () => {
  const input = $('#projectFile');
  if (input) {
    input.addEventListener('change', async (e) => {
      const projectId = parseHash().params[0];
      const files = [...e.target.files];
      e.target.value = '';
      if (projectId) await uploadFiles(projectId, files);
    });
  }
  // Choosing a video does not start anything: it opens the panel asking which
  // device to send it to, so the size and the warnings can be seen first.
  const video = $('#videoFile');
  if (video) {
    video.addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      transfer.file = file;
      transfer.stage = 'offering';
      drawTransfer();
    });
  }
  // Ctrl/Cmd+Enter sends, because a note worth sending is often several lines.
  const box = $('#sendBox');
  if (box) {
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        actions.sendText($('[data-action=sendText]'));
      }
    });
  }
};

// ================= SENDING A VIDEO BETWEEN DEVICES =================
//
// A video export is hundreds of megabytes to a few gigabytes. This Supabase
// project has about 1 GB of file storage for two apps and ViralRadar keeps to
// 300 MB of it, so the video never goes to a server at all: the two devices
// open a WebRTC data channel and the bytes go between them. All that reaches
// the database is a row saying it exists and which devices hold it.
//
// The panel lives in #transfer, outside #view, because a transfer can take half
// an hour and every render replaces #view. Moving between screens must not kill
// one — that would be the worst possible moment to lose it.
//
// Everything that decides anything is in shared/transfer.mjs and is tested in
// Node, including a corrupted byte and a cancel half way. What is here is the
// screen.

const panel = $('#transfer');

// One transfer at a time, on purpose. Two 2 GB transfers over one Wi-Fi link
// are slower than two in sequence, and on a phone they are two ways to run out
// of memory instead of one.
const transfer = {
  // 'idle' | 'offering' | 'invited' | 'asking' | 'connecting' | 'sending' | 'receiving' | 'done' | 'failed'
  stage: 'idle',
  file: null,
  projectId: null,
  invite: null,
  progress: null,
  message: '',
  verdict: null,
  cancelled: false,
};

const resetTransfer = (patch = {}) => {
  Object.assign(transfer, {
    stage: 'idle', file: null, projectId: null, invite: null,
    progress: null, message: '', verdict: null, cancelled: false,
  }, patch);
  drawTransfer();
};

const busy = () => ['asking', 'connecting', 'sending', 'receiving'].includes(transfer.stage);

function drawTransfer() {
  if (transfer.stage === 'idle') {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;

  // ---- an offer arriving from the other device ----
  if (transfer.stage === 'invited') {
    const { ask, warning } = acceptPrompt(transfer.invite);
    panel.innerHTML = `
      <div class="transfer-card">
        <h3>📹 Incoming video</h3>
        <p class="small">${esc(ask)}</p>
        ${warning ? `<div class="notice">${esc(warning)}</div>` : ''}
        <p class="muted small">${canStreamToDisk()
          ? 'You will be asked where to save it before it starts.'
          : 'It will download when it finishes, so it has to fit in memory first.'}</p>
        <div class="row">
          <button type="button" class="primary" data-action="acceptVideo">Accept</button>
          <button type="button" data-action="declineVideo">No thanks</button>
        </div>
      </div>`;
    return;
  }

  // ---- picking which device to send to ----
  if (transfer.stage === 'offering') {
    const peers = state.peers || [];
    const warnings = new Map(peers.map((p) => [p.id, sendWarning({ size: transfer.file.size, target: p })]));
    panel.innerHTML = `
      <div class="transfer-card">
        <h3>📹 Send “${esc(transfer.file.name)}”</h3>
        <p class="muted small">${esc(formatBytes(transfer.file.size))} · sent straight to the other device, never uploaded.</p>
        ${peers.length ? `<div class="stack">${peers.map((p) => `
          <div class="peer">
            <button type="button" class="primary" data-action="sendVideoTo" data-id="${esc(p.id)}">➤ ${esc(p.device)}</button>
            ${warnings.get(p.id) ? `<div class="notice small">${esc(warnings.get(p.id))}</div>`
              : `<span class="muted small">${p.canStream ? 'can save straight to disk' : 'saves by downloading'}</span>`}
          </div>`).join('')}</div>`
          : `<div class="notice">None of your other devices are online. Open ViralRadar on the other
               device — signed in, on the same Wi-Fi — and it will appear here.</div>`}
        <div class="row"><button type="button" data-action="cancelVideo">Cancel</button></div>
      </div>`;
    return;
  }

  // ---- in flight ----
  const p = transfer.progress;
  const percent = p ? p.percent : 0;
  const heading = transfer.stage === 'receiving' ? '📥 Receiving' : transfer.stage === 'sending' ? '📤 Sending' : '🔗 Connecting';
  const name = transfer.file ? transfer.file.name : (transfer.invite && transfer.invite.name) || 'video';

  if (busy()) {
    panel.innerHTML = `
      <div class="transfer-card">
        <h3>${heading} “${esc(name)}”</h3>
        <div class="bar" role="progressbar" aria-valuenow="${Math.round(percent)}" aria-valuemin="0" aria-valuemax="100">
          <div class="fill" style="width:${percent}%"></div>
        </div>
        <p class="small">${esc(p ? p.text : transfer.message || 'Finding the other device…')}</p>
        ${transfer.stage === 'connecting' ? `<p class="muted small">Up to ${Math.round(15)} seconds. Both devices need to be on the same network.</p>` : ''}
        <div class="row"><button type="button" data-action="cancelVideo">Stop</button></div>
      </div>`;
    return;
  }

  // ---- the verdict ----
  const good = transfer.stage === 'done';
  panel.innerHTML = `
    <div class="transfer-card ${good ? 'good' : 'bad'}">
      <h3>${good ? '✓ Identical to original' : 'Transfer failed'}</h3>
      <p class="small">${esc(transfer.message)}</p>
      ${transfer.verdict ? `<p class="muted small digest">${esc(transfer.verdict)}</p>` : ''}
      <div class="row"><button type="button" class="primary" data-action="closeTransfer">Close</button></div>
    </div>`;
}

panel.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const fn = actions[btn.dataset.action];
  if (fn) { e.preventDefault(); fn(btn, e); }
});

actions.closeTransfer = () => resetTransfer();

actions.cancelVideo = () => {
  // The send loop and the receiver both check this; neither leaves a partial
  // file behind, which is what makes "nothing was saved" true.
  transfer.cancelled = true;
  if (transfer.stage === 'offering') resetTransfer();
  else transfer.message = 'Stopping…';
  drawTransfer();
};

// ---- sending ----

actions.sendVideo = (btn) => {
  if (busy()) { toast('One transfer at a time. Wait for the current one to finish.', true); return; }
  const peers = state.peers || [];
  if (!state.devices) {
    toast('Your devices cannot find each other yet. Reload and try again.', true);
    return;
  }
  if (!peers.length) {
    toast('No other device is online. Open ViralRadar on the other one first.', true, 7000);
  }
  transfer.projectId = btn.dataset.id;
  $('#videoFile').click();
};

actions.sendVideoTo = async (btn) => {
  const peer = (state.peers || []).find((p) => p.id === btn.dataset.id);
  if (!peer) { toast('That device has gone offline.', true); return; }

  const file = transfer.file;
  const projectId = transfer.projectId;
  transfer.cancelled = false;
  transfer.stage = 'asking';
  transfer.message = `Asking ${peer.device}…`;
  drawTransfer();

  try {
    const result = await sendTo({
      signaling: state.devices,
      me: state.peerId,
      peer,
      file,
      cancelled: () => transfer.cancelled,
      onStage: (stage) => {
        transfer.stage = stage === 'asking' ? 'asking' : stage === 'connecting' ? 'connecting' : 'sending';
        drawTransfer();
      },
      onProgress: (progress) => { transfer.progress = progress; drawTransfer(); },
    });

    // The row goes in only now, with the digest both ends agreed on.
    try {
      await data.items.addVideoRef({
        projectId,
        name: file.name,
        size: file.size,
        sha256: result.sha256,
        devices: [deviceName(), peer.device],
        fromDevice: deviceName(),
      });
    } catch (e) {
      toast(`Sent, but the note could not be saved: ${e.message}`, true, 9000);
    }

    transfer.stage = 'done';
    transfer.message = `“${file.name}” reached ${peer.device} unchanged. ${formatBytes(file.size)} sent.`;
    transfer.verdict = `SHA-256 ${result.sha256}`;
    drawTransfer();
    if (currentRoute() === 'projects') render();
  } catch (e) {
    transfer.stage = 'failed';
    transfer.message = e instanceof TransferCancelled
      ? 'You stopped the transfer. Nothing was saved on the other device.'
      : e.message;
    transfer.verdict = null;
    drawTransfer();
  }
};

// ---- receiving ----

function onVideoOffer(message) {
  if (busy()) {
    // Politely refuse rather than silently ignore, so the other device is not
    // left waiting fifteen seconds for an answer that is not coming.
    state.devices.send({
      type: SIGNAL.DECLINE, transferId: message.transferId, from: state.peerId, to: message.from,
      reason: `${deviceName()} is busy with another transfer.`,
    });
    return;
  }
  transfer.invite = { ...message, from: peerName(message.from) };
  transfer.stage = 'invited';
  drawTransfer();
  toast(`${peerName(message.from)} wants to send you a video.`, false, 8000);
}

const peerName = (id) => ((state.peers || []).find((p) => p.id === id) || {}).device || 'Your other device';

actions.declineVideo = () => {
  const message = transfer.invite;
  if (message) {
    state.devices.send({
      type: SIGNAL.DECLINE, transferId: message.transferId, from: state.peerId, to: message.from,
      reason: `${deviceName()} declined.`,
    });
  }
  resetTransfer();
};

actions.acceptVideo = async (btn) => {
  const message = transfer.invite;
  if (!message) { resetTransfer(); return; }
  btn.disabled = true;

  // Where it goes is chosen NOW, while this click still counts as a gesture:
  // showSaveFilePicker() needs one, and there will not be another twenty
  // minutes into a transfer.
  let sink;
  try {
    sink = await pickSink(message.name || 'video.mp4');
  } catch {
    // The person closed the file picker. That is a decline, not a failure.
    actions.declineVideo();
    return;
  }

  transfer.cancelled = false;
  transfer.stage = 'connecting';
  transfer.message = 'Connecting to the other device…';
  drawTransfer();

  try {
    const result = await receiveFrom({
      signaling: state.devices,
      me: state.peerId,
      peer: message.from,
      transferId: message.transferId,
      sink,
      expect: { size: message.size },
      // Stop is a flag, polled on both sides, because neither a connection
      // being set up nor a sender that has gone quiet gives any other moment
      // at which it could be noticed.
      cancelled: () => transfer.cancelled,
      onStage: (stage) => { transfer.stage = stage === 'connecting' ? 'connecting' : 'receiving'; drawTransfer(); },
      onProgress: (progress) => { transfer.progress = progress; drawTransfer(); },
    });

    transfer.stage = 'done';
    transfer.message = `“${result.name}” arrived unchanged — ${formatBytes(result.bytes)}.`
      + (sink.kind === 'disk' ? ' Saved where you chose.' : ' Check your Downloads.');
    transfer.verdict = `SHA-256 ${result.sha256}`;
    drawTransfer();
  } catch (e) {
    transfer.stage = 'failed';
    transfer.message = e instanceof TransferCancelled
      ? 'The transfer stopped. Nothing was saved.'
      : e.message;
    transfer.verdict = null;
    drawTransfer();
    // The sink is aborted by the receiver itself, so there is nothing partial
    // left on disk to tidy up here.
  }
};

// ---- the channel the two devices find each other on ----

async function startDevices() {
  if (state.devices || !userId()) return;
  state.peerId = state.peerId || newPeerId();
  try {
    state.devices = await data.devices.join({
      userId: userId(),
      peerId: state.peerId,
      deviceName: deviceName(),
      canStream: canStreamToDisk(),
      onSignal: (message) => {
        // Only the invite starts something. Everything else belongs to a
        // transfer already under way and is handled inside it.
        if (message.type === SIGNAL.INVITE) onVideoOffer(message);
      },
      onPeers: (peers) => {
        state.peers = peers;
        // The device list is on two screens, and the send panel shows it live.
        if (transfer.stage === 'offering') drawTransfer();
        if (['projects', 'settings'].includes(currentRoute())) render();
      },
    });
    state.peers = state.devices.peers();
  } catch (e) {
    // Nothing else depends on this channel, so a failure costs only the
    // transfer feature — and says so rather than looking like a dead button.
    state.deviceError = e.message;
    console.warn('[app] could not join the device channel:', e);
  }
}

function stopDevices() {
  if (state.devices) state.devices.leave();
  state.devices = null;
  state.peers = [];
}

// ---------- things shared into ViralRadar from Android ----------
//
// The service worker takes the POST from Android's Share menu and parks it in a
// cache, because writing to Supabase needs the signed-in session and that lives
// here, not in the worker. This drains that cache into the Inbox.
//
// It runs on every boot, not only when the app was opened by a share: a share
// that arrived while the phone had no signal is still sitting there, and this
// is what finally delivers it.
const SHARE_CACHE = 'viralradar-shared';
const SHARE_PREFIX = '/shared-inbox/';

async function drainShares() {
  if (!('caches' in window)) return;
  let cache;
  try {
    cache = await caches.open(SHARE_CACHE);
  } catch {
    return; // private mode, or storage refused
  }

  const keys = await cache.keys();
  const metaKeys = keys.filter((r) => new URL(r.url).pathname.endsWith('/meta'));
  if (!metaKeys.length) return;

  let inbox;
  try {
    inbox = await data.projects.inbox();
  } catch (e) {
    toast(`Something was shared to ViralRadar, but its Inbox could not be opened: ${e.message}`, true, 9000);
    return;
  }

  let notes = 0;
  let files = 0;
  const failed = [];

  // Oldest first, so several shares arrive in the order they were made.
  for (const metaKey of metaKeys.sort((a, b) => a.url.localeCompare(b.url))) {
    let meta;
    try {
      meta = await (await cache.match(metaKey)).json();
    } catch {
      await cache.delete(metaKey);
      continue;
    }

    const used = await data.storage.used().catch(() => 0);
    let spent = 0;

    for (const text of meta.text || []) {
      try {
        await data.items.addText(inbox.id, text, deviceName());
        notes += 1;
      } catch (e) { failed.push(e.message); }
    }

    for (const file of meta.files || []) {
      const response = await cache.match(file.key);
      if (!response) continue;
      try {
        const blob = await response.blob();
        // A Blob has no name; the worker kept it in a header.
        const named = new File([blob], file.name || 'shared', { type: file.type || blob.type });
        const verdict = checkUpload({ size: named.size, usedBytes: used + spent, fileName: named.name });
        if (!verdict.ok) throw new Error(verdict.message);
        await data.items.addFile(inbox.id, named, {
          userId: userId(), fromDevice: deviceName(), usedBytes: used + spent,
        });
        spent += named.size;
        files += 1;
      } catch (e) {
        failed.push(`${file.name}: ${e.message}`);
      }
      await cache.delete(file.key);
    }
    await cache.delete(metaKey);
  }

  const parts = [notes && `${notes} note${notes === 1 ? '' : 's'}`, files && `${files} file${files === 1 ? '' : 's'}`].filter(Boolean);
  if (parts.length) toast(`Added to your Inbox: ${parts.join(' and ')}`, false, 6000);
  if (failed.length) toast(failed[0], true, 9000);
  if (parts.length || failed.length) {
    if (currentRoute() === 'projects') render();
  }
}

/**
 * The confirmation after a share, and the three ways it can go.
 *
 * Android gives no feedback of its own beyond closing the share sheet, so
 * without this a share that failed looks exactly like one that worked.
 */
function reportShare() {
  const shared = new URLSearchParams(location.hash.split('?')[1] || '').get('shared');
  if (!shared) return;
  // Take it off the URL, so a reload does not say it again.
  history.replaceState(null, '', location.pathname + '#/projects');
  if (shared === 'empty') toast('Nothing came through from that share.', true);
  else if (shared === 'failed') toast('That share could not be read. Try sharing it again.', true, 7000);
  else toast('Shared to ViralRadar. Adding it to your Inbox…');
}

// ================= IMPORT =================
const KIND_ICON = { idea: '💡', script: '🎬', result: '📈' };

async function renderImport() {
  const recent = await data.imports.recent(30);
  return `
    <div class="page-head"><h1>Import</h1>${PASTE_BUTTON()}</div>
    <div class="card stack">
      <div>
        <label class="field" for="pasteBox">Paste a Shorts Studio export</label>
        <textarea id="pasteBox" rows="9" placeholder='{ "app": "shorts-studio", "schema": 1, "type": "script", ... }' spellcheck="false" autocapitalize="off" autocorrect="off"></textarea>
      </div>
      <div class="row">
        <button type="button" class="primary" data-action="doImport">Import</button>
        <label class="btn" for="fileInput">Upload .json file…</label>
        <input type="file" id="fileInput" accept=".json,application/json" multiple hidden>
        <span class="muted small">Or run the folder watcher on your laptop and files import themselves.</span>
      </div>
      <div id="importResult"></div>
    </div>

    <h2 style="margin-top:22px">Recently added</h2>
    <div class="card">
      ${recent.length ? `<ul class="log">${recent.map((l) => `<li>
        <span class="badge">${KIND_ICON[l.kind] || ''} ${esc(l.kind)}</span>
        <span class="msg">${esc(l.title || l.yt_title || l.id)}</span>
        <span class="when">${esc(when(l.created_at))}</span>
      </li>`).join('')}</ul>` : '<p class="muted">Nothing imported yet.</p>'}
    </div>`;
}

// ---- asking the AI for something ----
//
// Every one of these takes long enough that a button with no feedback looks
// broken, so they all say what is happening and roughly how long it takes.
// Failures come back as whole sentences from the function — "Gemini has hit its
// limit for now", "No AI key is set" — and are shown as they are.
const GENERATING = {
  ideas: 'Writing ideas… up to 40 sec',
  angles: 'Finding angles… up to 40 sec',
  script: 'Writing script… up to 40 sec',
  edit_plan: 'Planning the edit… up to 40 sec',
};

async function askAi(btn, body) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${esc(GENERATING[body.kind] || 'Working…')}`;
  try {
    const result = await data.ai.generate(body);
    const by = result.provider ? ` (by ${result.provider})` : '';
    // Say when the creator's own results shaped it. Silent when they did not,
    // which is the honest state until there are five logged videos.
    const tuned = result.personalised ? ` · ${lessonLabel({ active: true, count: result.results_count })}` : '';
    toast((result.message || 'Done') + by + tuned);
    render();
    return result;
  } catch (e) {
    toast(e.message, true, 9000);
    btn.disabled = false;
    btn.innerHTML = original;
    return null;
  }
}

actions.generateIdeas = (btn) => askAi(btn, { kind: 'ideas', count: 6 });

actions.writeScript = (btn) => askAi(btn, { kind: 'script', topic: btn.dataset.topic });

actions.writeScriptFromBox = (btn) => {
  const input = $('#scriptTopic');
  const topic = input.value.trim();
  if (!topic) {
    toast('What should the script be about? Type a line first.', true);
    input.focus();
    return;
  }
  return askAi(btn, { kind: 'script', topic });
};

actions.makeEditPlan = (btn) => askAi(btn, { kind: 'edit_plan', script_id: btn.dataset.id });

// ---- paste from Shorts Studio ----
//
// One button, on three screens. It reads the clipboard and imports whatever is
// there, so copying an export in Shorts Studio and tapping once is the whole
// job — no switching screens, no finding the paste box.
//
// Reading the clipboard needs permission, and some browsers do not allow it at
// all. When that happens the paste box is still right there, so the button
// says so and takes you to it rather than just failing.
const PASTE_BUTTON = (label = '📋 Paste from Shorts Studio') =>
  `<button type="button" class="primary" data-action="pasteImport">${esc(label)}</button>`;

actions.pasteImport = async (btn) => {
  const original = btn.textContent;
  const fail = (message) => {
    toast(message, true, 7000);
    showImportResult(false, message);
  };

  if (!navigator.clipboard || !navigator.clipboard.readText) {
    fail('This browser will not let a page read the clipboard. Use the paste box on the Import screen instead.');
    if (currentRoute() !== 'import') location.hash = '#/import';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Reading clipboard…';
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Either the permission was refused, or the browser asked and nothing was
    // allowed. Either way the paste box always works.
    fail('ViralRadar was not allowed to read the clipboard. Use the paste box on the Import screen instead.');
    if (currentRoute() !== 'import') location.hash = '#/import';
    btn.disabled = false;
    btn.textContent = original;
    return;
  }

  if (!text.trim()) {
    fail('There is nothing on the clipboard. Copy an export from Shorts Studio first.');
    btn.disabled = false;
    btn.textContent = original;
    return;
  }

  btn.textContent = 'Importing…';
  try {
    const result = await data.imports.send(text);
    toast(result.message);
    showImportResult(true, result.message);
    render();
  } catch (e) {
    fail(e.message);
    btn.disabled = false;
    btn.textContent = original;
  }
};

function showImportResult(ok, msg) {
  const box = $('#importResult');
  if (box) box.innerHTML = `<div class="badge ${ok ? 'good' : 'bad'}" style="display:block;border-radius:10px;padding:10px 12px;font-size:.9rem;white-space:normal">${esc(msg)}</div>`;
}

actions.doImport = async (btn) => {
  const text = $('#pasteBox').value;
  if (!text.trim()) { showImportResult(false, 'Paste the export text first.'); return; }
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const r = await data.imports.send(text);
    showImportResult(true, r.message);
    toast(r.message);
    $('#pasteBox').value = '';
    render();
  } catch (e) {
    showImportResult(false, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import';
  }
};

afterRender.import = () => {
  $('#fileInput').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      try {
        const r = await data.imports.send(await file.text());
        toast(`${file.name}: ${r.message}`);
      } catch (err) {
        showImportResult(false, `${file.name}: ${err.message}`);
        toast(`${file.name}: ${err.message}`, true);
      }
    }
    e.target.value = '';
    render();
  });
};

// ================= SETTINGS =================
async function renderSettings() {
  const [s, tokens, usage, storage] = await Promise.all([
    data.settings.get(userId()),
    data.tokens.list(),
    data.usage.today(),
    // Never worth failing the whole screen over: this is one card out of seven,
    // and its figure comes from an extra round trip that can time out.
    data.storage.usage().catch(() => null),
  ]);
  state.settings = s;
  const yt = usage.youtube || { units: 0, requests: 0 };
  const order = (s.ai_order && s.ai_order.length ? s.ai_order : DEFAULT_AI_ORDER);
  const email = state.session?.user?.email || '';

  return `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="grid">
      <section class="card stack">
        <h2>Account</h2>
        <p class="small">Signed in as <b>${esc(email)}</b></p>
        <p class="muted small">Your data syncs to every device you sign in on. Nobody else can see it.</p>
        <div><button type="button" class="sm ghost" data-action="signOut">Sign out</button></div>
      </section>

      <section class="card stack">
        <h2>Niche keywords</h2>
        <textarea id="keywords" rows="7" style="font-family:inherit">${esc((s.niche_keywords || []).join('\n'))}</textarea>
        <p class="muted small">One per line. Each keyword is one YouTube search per refresh; the radar stops at 25 searches a day. Today: <b>${yt.requests}</b> searches, <b>${fmt(yt.units)}</b> units.</p>
        <div><button type="button" class="primary" data-action="saveKeywords">Save keywords</button></div>
      </section>

      <section class="card stack">
        <h2>Writing</h2>
        <label class="field" for="language">Language</label>
        <input type="text" id="language" value="${esc(s.language || 'English')}">
        <label class="field" for="length">Default video length</label>
        <select id="length">${LENGTHS.map((l) => `<option value="${l}" ${l === s.default_length ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="field" for="aiOrder">AI providers, in order</label>
        <input type="text" id="aiOrder" value="${esc(order.join(', '))}" spellcheck="false">
        <p class="muted small">Tried left to right. A provider with no key on the server is skipped.</p>
        <label class="field" for="geminiModel">Gemini model</label>
        <input type="text" id="geminiModel" value="${esc(s.gemini_model || '')}" spellcheck="false">
        <label class="field" for="openrouterModel">OpenRouter model</label>
        <input type="text" id="openrouterModel" value="${esc(s.openrouter_model || '')}" spellcheck="false">
        <div class="row">
          <button type="button" class="primary" data-action="saveWriting">Save</button>
          <button type="button" data-action="testAi">Test AI</button>
        </div>
        <div id="aiResult"></div>
      </section>

      <section class="card stack">
        <h2>Import tokens</h2>
        <p class="muted small">For the folder watcher on your laptop. Only a hash is stored here, so a token cannot be read back — if you lose one, revoke it and make another.</p>
        ${tokens.length ? `<ul class="log">${tokens.map((t) => `<li>
          <span class="msg">${esc(t.label || 'Unnamed')}</span>
          <span class="when">${t.last_used_at ? 'used ' + esc(ago(t.last_used_at)) : 'never used'} · made ${esc(when(t.created_at))}</span>
          <button type="button" class="sm ghost" data-action="revokeToken" data-id="${esc(t.id)}">Revoke</button>
        </li>`).join('')}</ul>` : '<p class="muted small">No tokens yet.</p>'}
        <div class="row">
          <input type="text" id="tokenLabel" placeholder="What is it for? e.g. laptop" style="flex:1">
          <button type="button" class="primary" data-action="createToken">Create token</button>
        </div>
        <div id="tokenResult"></div>
      </section>

      <section class="card stack">
        <h2>This device</h2>
        <label class="field" for="deviceName">What to call this device</label>
        <input type="text" id="deviceName" value="${esc(deviceName())}" maxlength="24" placeholder="Laptop">
        <p class="muted small">Used when you send something to a project, so the other device can say
          “New from ${esc(deviceName())}”. Stored on this device only, never in the database.</p>
        <div><button type="button" class="primary" data-action="saveDevice">Save name</button></div>
        <h3 style="margin:0;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Your devices</h3>
        ${devicesLine()}
        <p class="muted small">This device ${canStreamToDisk()
          ? 'can save a received video straight to disk, so its size does not matter.'
          : `has to hold a received video in memory before saving it, so files over ${esc(formatBytes(BIG_FILE_BYTES))} usually fail. A laptop does not have this limit.`}</p>
      </section>

      <section class="card stack">
        <h2>Project files</h2>
        ${storage ? `
          <p class="small"><b>${esc(storage.text)}</b></p>
          <div class="meter" role="img" aria-label="${esc(storage.text)}"><div class="fill ${storage.percent > 85 ? 'hot' : ''}" style="width:${storage.percent}%"></div></div>
          <p class="muted small">This Supabase project is shared with another app and has about 1 GB of file storage in
            total, so ViralRadar keeps to ${esc(formatBytes(TOTAL_BYTES_CAP))} of it and refuses uploads past that.
            One file can be at most ${esc(formatBytes(MAX_FILE_BYTES))}. Raw video is never uploaded.</p>
          <p class="muted small">Files in a project marked <b>Posted</b> are deleted ${POSTED_RETENTION_DAYS} days
            later, by itself, every night. Notes and links are kept.</p>
          <div class="row">
            <button type="button" data-action="purgeFiles">Clean up now</button>
            <a class="btn sm ghost" href="#/projects">Open Projects</a>
          </div>
          <div id="purgeResult"></div>
        ` : '<p class="muted small">Could not read how much storage is used. Reload to try again.</p>'}
      </section>

      <section class="card stack">
        <h2>Backup &amp; restore</h2>
        <p class="small">Download everything as one JSON file. Worth doing now and then: a free Supabase project keeps no backups of its own.</p>
        <div class="row">
          <button type="button" class="primary" data-action="downloadBackup">Download backup</button>
          <label class="btn" for="restoreFile">Restore from file…</label>
          <input type="file" id="restoreFile" accept=".json,application/json" hidden>
        </div>
        <p class="muted small">Restoring <b>adds and updates</b>; it never deletes, so it cannot lose anything you have now.</p>
        <div id="restoreConfirm"></div>
      </section>

      <section class="card stack">
        <h2>About</h2>
        <p class="muted small">Built ${esc(when(window.__VR_ENV?.BUILT_AT))}<br>Database: ${esc((window.__VR_ENV?.SUPABASE_URL || '').replace('https://', ''))}</p>
        <p class="muted small">The radar refreshes by itself at 7:00 AM IST.</p>
      </section>
    </div>`;
}

const saveSettings = async (patch, message) => {
  try {
    state.settings = await data.settings.update(userId(), patch);
    toast(message);
    render();
  } catch (e) { toast(e.message, true); }
};

actions.saveKeywords = () => {
  const list = [...new Set($('#keywords').value.split(/[\n,]/).map((k) => k.trim()).filter(Boolean))].slice(0, 25);
  if (!list.length) { toast('Add at least one keyword.', true); return; }
  return saveSettings({ niche_keywords: list }, 'Keywords saved');
};

actions.saveWriting = () => {
  const order = $('#aiOrder').value.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const unknown = order.filter((p) => !['gemini', 'openrouter', 'claude'].includes(p));
  if (unknown.length) { toast(`Unknown provider: ${unknown.join(', ')}`, true); return; }
  return saveSettings({
    language: $('#language').value.trim() || 'English',
    default_length: $('#length').value,
    ai_order: order.length ? order : DEFAULT_AI_ORDER,
    gemini_model: $('#geminiModel').value.trim(),
    openrouter_model: $('#openrouterModel').value.trim(),
  }, 'Saved');
};

actions.testAi = async (btn) => {
  const box = $('#aiResult');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  box.innerHTML = '<p class="muted small">Asking each provider for one short line. This can take up to 30 seconds.</p>';
  try {
    const r = await data.callFunction('vr-generate', { kind: 'test' }, 'test the AI providers');
    const rows = (r.providers || []).map((p) => `<li><span class="badge ${p.ok ? 'good' : 'bad'}">${p.ok ? 'works' : 'failed'}</span> <span class="msg">${esc(p.name)}${p.model ? ' · ' + esc(p.model) : ''}</span><span class="when">${esc(p.detail || '')}</span></li>`).join('');
    box.innerHTML = rows ? `<ul class="log">${rows}</ul>` : '<p class="muted small">No providers are set up.</p>';
  } catch (e) {
    box.innerHTML = `<div class="badge bad" style="display:block;border-radius:10px;padding:10px 12px;white-space:normal">${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test AI';
  }
};

actions.saveDevice = () => {
  const saved = setDeviceName($('#deviceName').value);
  toast(`This device is “${saved}”`);
  // Presence is carrying the old name until this is done, so the other device
  // would offer to send to a name that no longer exists.
  if (state.devices) state.devices.rename(saved).catch(() => {});
  // The redraw is what makes the name the screen quotes back the new one.
  render();
};

actions.purgeFiles = async (btn) => {
  btn.disabled = true;
  btn.textContent = 'Cleaning up…';
  // Both branches redraw before writing their message, because the redraw
  // replaces the whole screen — and here it also refreshes the usage figure,
  // which is the thing a clean-up was run to change.
  const say = (message, bad = false) => {
    const box = $('#purgeResult');
    if (!box) return;
    box.innerHTML = bad
      ? `<div class="badge bad" style="display:block;border-radius:10px;padding:10px 12px;white-space:normal">${esc(message)}</div>`
      : `<p class="muted small">${esc(message)}</p>`;
  };
  try {
    const r = await data.storage.purge();
    toast(r.message || 'Done');
    await render();
    say(r.message || 'Done');
  } catch (e) {
    toast(e.message, true, 9000);
    say(e.message, true);
    btn.disabled = false;
    btn.textContent = 'Clean up now';
  }
};

actions.createToken = async (btn) => {
  btn.disabled = true;
  try {
    const token = newToken();
    const hash = await hashToken(token);
    await data.tokens.create(userId(), $('#tokenLabel').value.trim(), token, hash);
    // Shown once, here, and nowhere else: only the hash was stored.
    $('#tokenResult').innerHTML = `<div class="notice">
      <b>Copy this now — it is not shown again.</b>
      <pre style="white-space:pre-wrap;word-break:break-all;margin:8px 0">${esc(token)}</pre>
      ${copyBtn(token, 'Copy token', 'sm primary')}
      <p class="muted small" style="margin-top:8px">Put it in the <code>.env</code> on your laptop as <code>VR_IMPORT_TOKEN</code>.</p>
    </div>`;
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
};

actions.revokeToken = async (btn) => {
  if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Tap again'; return; }
  try {
    await data.tokens.revoke(btn.dataset.id);
    toast('Token revoked. The watcher using it will stop working.');
    render();
  } catch (e) { toast(e.message, true); }
};

actions.downloadBackup = async (btn) => {
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const backup = await data.backup.download();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadJson(`viralradar-backup-${stamp}.json`, backup);
    toast('Backup downloaded');
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Download backup'; }
};

let pendingRestore = null;
afterRender.settings = () => {
  $('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      pendingRestore = JSON.parse(await file.text());
    } catch {
      toast('That file is not valid JSON.', true);
      return;
    }
    $('#restoreConfirm').innerHTML = `<div class="notice">Restore from <b>${esc(file.name)}</b>? Nothing is deleted; rows are added or updated.
      <div class="row" style="margin-top:8px"><button type="button" class="sm primary" data-action="restoreYes">Yes, restore</button><button type="button" class="sm" data-action="restoreNo">Cancel</button></div></div>`;
  });
};
actions.restoreNo = () => { pendingRestore = null; $('#restoreConfirm').innerHTML = ''; };
actions.restoreYes = async (btn) => {
  btn.disabled = true;
  btn.textContent = 'Restoring…';
  try {
    const counts = await data.backup.restore(pendingRestore, userId());
    toast(`Restored: ${counts.scripts || 0} scripts, ${counts.ideas || 0} ideas, ${counts.results || 0} results`);
    pendingRestore = null;
    render();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = 'Yes, restore';
  }
};

// ---------- boot ----------

function fatal(message) {
  $('#nav').hidden = true;
  view.innerHTML = `<div class="empty"><span class="big">⚠️</span>${esc(message)}</div>`;
}

async function signedIn(session) {
  state.session = session;
  document.body.classList.remove('signed-out');
  $('#nav').hidden = false;
  // A magic link comes back with its tokens in the hash; the library has taken
  // what it needs by now, so put the router back on a real route.
  if (!location.hash || /access_token|error_description/.test(location.hash)) {
    history.replaceState(null, '', location.pathname + '#/radar');
  }
  startLive();
  startProjectLive();
  // The channel the two devices find each other on. Nothing else depends on
  // it, so it is started without being waited for: a failure costs the video
  // feature and nothing else, and says so on the screens that offer it.
  startDevices().then(() => {
    if (['projects', 'settings'].includes(currentRoute())) render();
  });
  // Say what happened before the drain starts, so a share is acknowledged
  // immediately rather than after an upload.
  reportShare();
  await render();
  // Make sure the settings row exists, but never block the first paint on it.
  // The data layer has already turned this into a sentence; wrapping it again
  // produced "Could not read your settings: Could not read your settings: ...".
  data.settings.get(session.user.id).catch((e) => toast(e.message, true));
  // Anything shared from Android's Share menu, including while there was no
  // signal. Deliberately after the first paint: an upload must not be what
  // stands between someone and their own screen.
  drainShares().catch((e) => toast(`Could not add what was shared: ${e.message}`, true, 9000));
}

// ---------- installing ----------
//
// The service worker only makes the app open faster and work with no signal;
// nothing depends on it, so every failure here is swallowed. It is skipped on
// plain http, where browsers refuse to register one anyway.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;

  navigator.serviceWorker.register('/sw.js').then((registration) => {
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        // A worker that reaches "installed" while one is already controlling
        // the page means a new version is deployed and waiting.
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version is ready. Reload to use it.', false, 9000);
        }
      });
    });
  }).catch((e) => console.warn('[app] service worker not registered:', e));
}

async function boot() {
  registerServiceWorker();
  if (!data) {
    fatal('This build has no Supabase configuration, so it cannot reach your data. Rebuild with SUPABASE_URL and SUPABASE_ANON_KEY set.');
    return;
  }
  // Signing in or out in another tab should be reflected here too.
  data.auth.onChange((session) => {
    if (session && !state.session) signedIn(session);
    else if (!session && state.session) { stopLive(); state.session = null; renderLogin('You are signed out.'); }
    else state.session = session;
  });

  try {
    const session = await data.auth.session();
    if (session) await signedIn(session);
    else renderLogin();
  } catch (e) {
    fatal(e.message);
  }
}

boot();
