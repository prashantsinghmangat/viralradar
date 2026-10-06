/* ViralRadar frontend — plain JS, hash routing, no build step. */
(function () {
  'use strict';

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

  async function api(path, opts = {}) {
    const init = { ...opts, headers: { ...(opts.headers || {}) } };
    if (opts.json !== undefined) {
      init.body = JSON.stringify(opts.json);
      init.headers['Content-Type'] = 'application/json';
      delete init.json;
    }
    const res = await fetch('/api' + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error((data && (data.error || data.message)) || `Request failed (${res.status})`);
    return data;
  }

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

  // ---------- theme ----------
  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = isDark ? 'light' : 'dark';
    try { localStorage.setItem('vr-theme', root.dataset.theme); } catch { /* private mode */ }
  });

  // ---------- live events (toasts from the folder watcher) ----------
  let sseOpen = false;
  function connectEvents() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    es.onopen = () => { sseOpen = true; };
    es.onerror = () => { sseOpen = false; };
    const onImport = (e) => {
      const d = JSON.parse(e.data);
      toast(d.message, !d.ok);
      if (d.ok && ['ideas', 'scripts', 'results', 'import'].includes(currentRoute())) render();
      else if (!d.ok && currentRoute() === 'import') render();
    };
    es.addEventListener('import', onImport);
    es.addEventListener('radar', (e) => {
      const d = JSON.parse(e.data);
      if (currentRoute() === 'radar') render();
      else toast(d.message);
    });
  }

  // ---------- router ----------
  const currentRoute = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'radar');
  const routes = { radar: renderRadar, ideas: renderIdeas, scripts: renderScripts, results: renderResults, import: renderImport, settings: renderSettings };
  let renderToken = 0;

  async function render() {
    const token = ++renderToken;
    const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
    const route = routes[name] ? name : 'radar';
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
    stopPrompter();
    try {
      const html = await routes[route](rest.map(decodeURIComponent));
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

  // ================= RADAR =================
  let radarSource = '';
  const SOURCE = {
    youtube: { label: 'YouTube', icon: '▶️', unit: 'views/hr' },
    hackernews: { label: 'Hacker News', icon: '🟧', unit: 'pts/hr' },
    reddit: { label: 'Reddit', icon: '👽', unit: 'upvotes/hr' },
    github: { label: 'GitHub', icon: '🐙', unit: 'stars/hr' },
  };

  async function renderRadar() {
    const data = await api('/radar' + (radarSource ? `?source=${radarSource}` : ''));
    const yt = data.youtube;
    const lr = data.last_run;
    const srcStatus = lr ? Object.entries(lr.sources).filter(([, s]) => !s.skipped).map(([k, s]) => {
      const title = s.ok ? (s.notes && s.notes.length ? s.notes.join('; ') : `${s.count} items`) : s.error;
      const label = s.skipped ? 'skipped' : s.ok ? s.count : 'failed';
      return `<span class="badge ${s.ok ? (s.notes && s.notes.length ? 'warn' : 'good') : 'bad'}" title="${esc(title)}">${SOURCE[k] ? SOURCE[k].label : k}: ${label}</span>`;
    }).join('') : '';
    const failures = lr ? Object.entries(lr.sources).filter(([, s]) => !s.ok) : [];

    const cards = data.trends.map((t, i) => {
      const s = SOURCE[t.source] || { label: t.source, icon: '🔗', unit: '/hr' };
      const copy = `${t.title}\n${t.url}\n${t.summary || ''}`.trim();
      const thumb = t.thumbnail
        ? `<img src="${esc(t.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${s.icon}'))">`
        : s.icon;
      const viewsLabel = t.source === 'youtube' ? 'views' : t.source === 'github' ? 'stars' : t.source === 'reddit' ? 'upvotes' : 'points';
      return `<article class="card trend ${t.source === 'youtube' ? '' : 'wide'}">
        <div class="thumb">${thumb}</div>
        <div>
          <div class="rank">#${i + 1} · ${s.icon} ${esc(s.label)}${t.keyword ? ` · ${esc(t.keyword)}` : ''}</div>
          <h3>${esc(t.title)}</h3>
          <div class="meta">${t.views != null ? `<span><b>${compact(t.views)}</b> ${viewsLabel}</span>` : ''}<span><b>${compact(t.score)}</b> ${t.views == null ? 'rank pts/hr' : s.unit}</span><span>${ago(t.published_at)}</span></div>
          <div class="summary">${esc(t.summary || '')}</div>
          <div class="actions">
            <a class="btn sm" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
            ${copyBtn(copy, 'Copy for Shorts Studio', 'sm primary')}
          </div>
        </div>
      </article>`;
    }).join('');

    return `
      <div class="page-head">
        <h1>Radar</h1>
        <button type="button" class="primary" data-action="refreshRadar" ${data.running ? 'disabled' : ''}>${data.running ? '<span class="spin"></span> Refreshing…' : '↻ Refresh now'}</button>
      </div>
      <div class="status-line">
        ${lr ? `<span>Updated ${ago(lr.at)}</span> ${srcStatus}` : '<span>Not run yet. Tap “Refresh now”, or wait for 7:00 AM IST.</span>'}
        <span class="badge ${yt.configured ? 'accent' : 'warn'}" title="search.list costs 100 units, videos.list costs 1">YouTube: ${yt.configured ? `${yt.searches}/${yt.search_cap} searches · ${fmt(yt.units)}/${fmt(yt.unit_quota)} units today` : 'no API key'}</span>
      </div>
      ${failures.length ? `<div class="notice" style="margin-bottom:12px">${failures.map(([k, s]) => `<div><b>${esc(SOURCE[k] ? SOURCE[k].label : k)}:</b> ${esc(s.error)}</div>`).join('')}</div>` : ''}
      <div class="chips" style="margin-bottom:14px">
        ${[['', 'All'], ...Object.entries(SOURCE).map(([k, v]) => [k, v.label])].map(([k, l]) =>
          `<button type="button" class="chip ${radarSource === k ? 'on' : ''}" data-action="radarSource" data-v="${k}">${esc(l)}</button>`).join('')}
      </div>
      ${data.trends.length ? `<div class="grid">${cards}</div>`
        : `<div class="empty"><span class="big">📡</span>No trends yet${data.day ? ' for this source' : ''}.<br>Tap <b>Refresh now</b> to scan YouTube, Hacker News, Reddit and GitHub.</div>`}
      <p class="muted small">Scores are per-hour velocity within each source (views, points, upvotes or stars per hour since posting), so compare within a source using the filter above.</p>`;
  }
  actions.radarSource = (btn) => { radarSource = btn.dataset.v; render(); };
  actions.refreshRadar = async (btn) => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Refreshing…';
    try {
      const r = await api('/radar/refresh', { method: 'POST' });
      const failed = Object.entries(r.sources).filter(([, s]) => !s.ok).map(([k]) => k);
      toast(`Found ${r.total} trends${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`, false);
    } catch (e) { toast(e.message, true); }
    render();
  };

  // ================= IDEAS =================
  let ideaFilter = 'all';
  async function renderIdeas() {
    const ideas = await api('/ideas');
    const counts = { all: ideas.length, new: 0, picked: 0, skipped: 0 };
    ideas.forEach((i) => counts[i.status]++);
    const list = ideas.filter((i) => ideaFilter === 'all' || i.status === ideaFilter);
    const groups = new Map();
    for (const i of list) {
      const d = (i.date || '').slice(0, 10) || 'No date';
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
          </article>`).join('')}</div>
      </section>`).join('');

    return `
      <div class="page-head"><h1>Ideas</h1></div>
      <div class="chips" style="margin-bottom:14px">
        ${[['all', 'All'], ['new', 'New'], ['picked', 'Picked'], ['skipped', 'Skipped']].map(([k, l]) =>
          `<button type="button" class="chip ${ideaFilter === k ? 'on' : ''}" data-action="ideaFilter" data-v="${k}">${l} · ${counts[k]}</button>`).join('')}
      </div>
      ${body || `<div class="empty"><span class="big">💡</span>${ideas.length ? 'Nothing here with this filter.' : 'No ideas yet. Export ideas from Shorts Studio and they will appear here.'}</div>`}`;
  }
  actions.ideaFilter = (btn) => { ideaFilter = btn.dataset.v; render(); };
  actions.ideaStatus = async (btn) => {
    try { await api(`/ideas/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', json: { status: btn.dataset.v } }); render(); }
    catch (e) { toast(e.message, true); }
  };

  // ================= SCRIPTS =================
  const STAGES = [['to_shoot', 'To shoot'], ['shot', 'Shot'], ['edited', 'Edited'], ['posted', 'Posted']];
  const stageIdx = (s) => STAGES.findIndex(([k]) => k === s);

  async function renderScripts(params) {
    if (params[0]) return renderScriptDetail(params[0]);
    const scripts = await api('/scripts');
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
      <div class="page-head"><h1>Scripts</h1><span class="muted small">${canDrag ? 'Drag cards between columns, or use the arrows.' : 'Tap the arrow to move a script.'}</span></div>
      ${scripts.length ? `<div class="board">${cols}</div>` : '<div class="empty"><span class="big">🎬</span>No scripts yet. Export a script from Shorts Studio and it lands in “To shoot”.</div>'}`;
  }
  actions.openScript = (card) => { location.hash = `#/scripts/${encodeURIComponent(card.dataset.id)}`; };
  async function moveScript(id, stage) {
    try {
      await api(`/scripts/${encodeURIComponent(id)}`, { method: 'PATCH', json: { stage } });
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
    const s = await api(`/scripts/${encodeURIComponent(id)}`);
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

    return `
      <div class="detail-head">
        <a class="btn sm ghost" href="#/scripts">← Board</a>
        <h1>${esc(s.title || s.yt_title || s.id)}</h1>
      </div>
      <div class="row" style="margin-bottom:14px">
        <div class="seg">${STAGES.map(([k, l], i) => `<button type="button" class="${i === idx ? 'on' : ''}" data-action="setStage" data-id="${esc(s.id)}" data-v="${k}">${l}</button>`).join('')}</div>
        ${s.topic ? `<span class="muted small">Topic: ${esc(s.topic)}</span>` : ''}
        ${s.created_at ? `<span class="muted small">Created ${esc(when(s.created_at))}</span>` : ''}
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

      <div class="outputs grid">
        ${outputs.map(([label, value]) => `<div class="card out">
          <div class="out-head"><h3>${esc(label)}</h3>${copyBtn(value)}</div>
          <pre>${esc(value)}</pre>
        </div>`).join('')}
      </div>
      <p style="margin-top:20px"><button type="button" class="sm ghost" data-action="deleteScript" data-id="${esc(s.id)}">Delete script</button></p>`;
  }
  actions.setStage = async (btn) => {
    try { await api(`/scripts/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', json: { stage: btn.dataset.v } }); render(); }
    catch (e) { toast(e.message, true); }
  };
  actions.deleteScript = async (btn) => {
    if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Tap again to delete'; btn.classList.add('copied'); return; }
    await api(`/scripts/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
    toast('Script deleted');
    location.hash = '#/scripts';
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
    const [rows, st] = await Promise.all([api('/results'), api('/results/stats')]);
    if (!rows.length) return '<div class="page-head"><h1>Results</h1></div><div class="empty"><span class="big">📈</span>No results yet. Log results in Shorts Studio and export them here.</div>';
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

  // ================= IMPORT =================
  async function renderImport() {
    const log = await api('/imports?limit=40');
    return `
      <div class="page-head"><h1>Import</h1></div>
      <div class="card stack">
        <div>
          <label class="field" for="pasteBox">Paste a Shorts Studio export</label>
          <textarea id="pasteBox" rows="9" placeholder='{ "app": "shorts-studio", "schema": 1, "type": "script", ... }' spellcheck="false" autocapitalize="off" autocorrect="off"></textarea>
        </div>
        <div class="row">
          <button type="button" class="primary" data-action="doImport">Import</button>
          <label class="btn" for="fileInput">Upload .json file…</label>
          <input type="file" id="fileInput" accept=".json,application/json" multiple hidden>
          <span class="muted small">Files named viralradar-*.json in your Downloads folder import automatically.</span>
        </div>
        <div id="importResult"></div>
      </div>

      <h2 style="margin-top:22px">Recent imports</h2>
      <div class="card">
        ${log.length ? `<ul class="log">${log.map((l) => `<li>
          <span class="badge ${l.ok ? 'good' : 'bad'}">${l.ok ? 'OK' : 'Failed'}</span>
          <span class="msg">${esc(l.message)}</span>
          <span class="when">${esc(when(l.at))} · ${esc(l.method)}${l.filename ? ' · ' + esc(l.filename) : ''}</span>
        </li>`).join('')}</ul>` : '<p class="muted">Nothing imported yet.</p>'}
      </div>`;
  }
  async function sendImport(text, method, filename) {
    const q = new URLSearchParams({ method });
    if (filename) q.set('filename', filename);
    return api(`/import?${q}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  function showImportResult(ok, msg) {
    const box = $('#importResult');
    if (box) box.innerHTML = `<div class="badge ${ok ? 'good' : 'bad'}" style="display:block;border-radius:10px;padding:10px 12px;font-size:.9rem;white-space:normal">${esc(msg)}</div>`;
  }
  actions.doImport = async (btn) => {
    const text = $('#pasteBox').value;
    if (!text.trim()) { showImportResult(false, 'Paste the export text first.'); return; }
    btn.disabled = true;
    try {
      // The server broadcasts a toast and this tab re-renders on that event.
      const r = await sendImport(text, 'paste');
      if (!sseOpen) { toast(r.message); render(); }
    } catch (e) {
      showImportResult(false, e.message);
    } finally { btn.disabled = false; }
  };
  afterRender.import = () => {
    $('#fileInput').addEventListener('change', async (e) => {
      for (const file of e.target.files) {
        try {
          const r = await sendImport(await file.text(), 'upload', file.name);
          if (!sseOpen) { toast(r.message); render(); }
        } catch (err) {
          showImportResult(false, `${file.name}: ${err.message}`);
          toast(`${file.name}: ${err.message}`, true);
        }
      }
      e.target.value = '';
    });
  };

  // ================= SETTINGS =================
  async function renderSettings() {
    const s = await api('/settings');
    const yt = s.youtube;
    return `
      <div class="page-head"><h1>Settings</h1></div>
      <div class="grid">
        <section class="card stack">
          <h2>Watch folder</h2>
          <div class="row"><span class="badge ${s.watch_active ? 'good' : 'bad'}">${s.watch_active ? 'Watching' : 'Not watching'}</span></div>
          <input type="text" id="watchDir" value="${esc(s.watch_dir)}" spellcheck="false">
          <p class="muted small">Files named <code>viralradar-*.json</code> here are imported, then moved to <code>viralradar-imported/</code> (or <code>viralradar-failed/</code> with an error note). Default from .env: ${esc(s.watch_dir_default)}</p>
          <div><button type="button" class="primary" data-action="saveWatch">Save folder</button></div>
        </section>

        <section class="card stack">
          <h2>Niche keywords</h2>
          <textarea id="keywords" rows="7" style="font-family:inherit">${esc(s.keywords.join('\n'))}</textarea>
          <p class="muted small">One per line. Each keyword is one YouTube search (100 units) per refresh; the app stops at ${yt.search_cap} searches a day.</p>
          <div><button type="button" class="primary" data-action="saveKeywords">Save keywords</button></div>
        </section>

        <section class="card stack">
          <h2>YouTube API</h2>
          <div class="row"><span class="badge ${yt.configured ? 'good' : 'warn'}">${yt.configured ? 'Key is set' : 'No key in .env'}</span></div>
          <p class="small">Today: <b>${yt.searches}</b> / ${yt.search_cap} searches · <b>${fmt(yt.units)}</b> / ${fmt(yt.unit_quota)} units</p>
          <p class="muted small">${yt.configured ? 'The key lives in the .env file on your laptop and is never sent to the browser.' : 'Add YOUTUBE_API_KEY=... to the .env file and restart. See README for the steps. Radar still works with Hacker News, Reddit and GitHub.'}</p>
          <p class="muted small">GitHub token: ${s.github_token ? 'set' : 'not set (optional, raises GitHub rate limits)'} · Daily refresh: ${esc(s.radar_schedule)}</p>
        </section>

        <section class="card stack">
          <h2>Open on your phone</h2>
          ${s.lan_urls.length ? s.lan_urls.map((u) => `<div class="row"><code>${esc(u)}</code>${copyBtn(u)}</div>`).join('') : '<p class="muted">No network address found.</p>'}
          <p class="muted small">Phone and laptop must be on the same Wi-Fi. The QR code is printed in the terminal when the app starts.</p>
        </section>

        <section class="card stack">
          <h2>Backup &amp; restore</h2>
          <p class="small">Download everything (ideas, scripts, results, trends, settings, import log) as one JSON file.</p>
          <div class="row">
            <a class="btn primary" href="/api/backup" download>Download backup</a>
            <label class="btn" for="restoreFile">Restore from file…</label>
            <input type="file" id="restoreFile" accept=".json,application/json" hidden>
          </div>
          <p class="muted small">Restoring <b>replaces</b> all current data with the backup.</p>
          <div id="restoreConfirm"></div>
        </section>
      </div>`;
  }
  actions.saveWatch = async () => {
    try { const s = await api('/settings', { method: 'PUT', json: { watch_dir: $('#watchDir').value } }); toast(s.watch_active ? 'Now watching ' + s.watch_dir : 'Saved, but the folder is not being watched', !s.watch_active); render(); }
    catch (e) { toast(e.message, true); }
  };
  actions.saveKeywords = async () => {
    try { await api('/settings', { method: 'PUT', json: { keywords: $('#keywords').value } }); toast('Keywords saved'); render(); }
    catch (e) { toast(e.message, true); }
  };
  let pendingRestore = null;
  afterRender.settings = () => {
    $('#restoreFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      pendingRestore = await file.text();
      $('#restoreConfirm').innerHTML = `<div class="notice">Replace ALL current data with <b>${esc(file.name)}</b>?
        <div class="row" style="margin-top:8px"><button type="button" class="sm primary" data-action="restoreYes">Yes, restore</button><button type="button" class="sm" data-action="restoreNo">Cancel</button></div></div>`;
    });
  };
  actions.restoreNo = () => { pendingRestore = null; $('#restoreConfirm').innerHTML = ''; };
  actions.restoreYes = async () => {
    try {
      const r = await api('/restore', { method: 'POST', body: pendingRestore, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      toast(`Restored: ${r.counts.scripts} scripts, ${r.counts.ideas} ideas, ${r.counts.results} results`);
      pendingRestore = null;
      render();
    } catch (e) { toast(e.message, true); }
  };

  // ---------- boot ----------
  if (!location.hash) history.replaceState(null, '', '#/radar');
  render();
  connectEvents();
})();
