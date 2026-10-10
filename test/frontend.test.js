// Checks on the frontend that do not need a browser.
//
// The view layer itself can only really be judged by opening it, but a few
// things can be stated as facts and held to: that nothing still calls the
// Express server that no longer exists, that the page never hands a secret to
// the browser, and that every data call the view makes is one the data layer
// actually provides — a typo there is a blank screen with a console error, and
// nothing else would catch it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const appjs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const datajs = fs.readFileSync(path.join(PUBLIC, 'data.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

test('nothing calls the Express server any more', () => {
  // The cloud build has no server of ours. A leftover /api/ call would look
  // like a broken screen with no explanation.
  const offenders = [...appjs.matchAll(/['"`](\/api\/[^'"`]*)['"`]/g)].map((m) => m[1]);
  assert.deepEqual(offenders, [], `app.js still calls ${offenders.join(', ')}`);
  assert.ok(!/\bEventSource\b/.test(appjs), 'Server-Sent Events were the old server; live updates come over Realtime now');
  assert.ok(!/fetch\(\s*['"`]\//.test(appjs), 'the app should not fetch from its own origin');
});

test('every data call the view makes exists in the data layer', () => {
  // Collect what data.js offers: the groups createData returns. There are
  // several `return { ... }` statements in the file, so pick the one that is
  // actually the public surface rather than the first one found.
  const returns = [...datajs.matchAll(/return \{([^{}]*)\};/g)].map((m) => m[1]);
  const surface = returns.find((r) => r.includes('auth') && r.includes('backup'));
  assert.ok(surface, 'could not find what createData returns');
  const groups = surface.split(',').map((s) => s.trim()).filter(Boolean);

  const used = new Set([...appjs.matchAll(/\bdata\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)].map((m) => `${m[1]}.${m[2]}`));
  const direct = new Set([...appjs.matchAll(/\bdata\.([a-zA-Z]+)\(/g)].map((m) => m[1]));
  assert.ok(used.size >= 10, `expected the view to use the data layer, found ${used.size} calls`);

  for (const call of used) {
    const [group, fn] = call.split('.');
    assert.ok(groups.includes(group), `app.js calls data.${call}, but data.js has no "${group}" group`);
    // The function has to be defined somewhere in that file.
    const defined = new RegExp(`(^|[^a-zA-Z])${fn}\\s*[:(]|${fn}\\s*=`, 'm').test(datajs);
    assert.ok(defined, `app.js calls data.${call}, but data.js never defines ${fn}`);
  }
  for (const fn of direct) {
    assert.ok(groups.includes(fn), `app.js calls data.${fn}(), which data.js does not return`);
  }
});

test('the three live tables are the ones the app redraws for', () => {
  const labels = appjs.match(/const LIVE_LABEL = \{([^}]*)\}/);
  assert.ok(labels, 'the app should name the tables it reacts to');
  const tables = [...labels[1].matchAll(/(\w+):/g)].map((m) => m[1]).sort();
  const live = datajs.match(/export const LIVE_TABLES = \[([^\]]*)\]/);
  const subscribed = live[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  assert.deepEqual(tables, subscribed, 'the app reacts to different tables than it subscribes to');
});

test('signing in never quietly creates an account', () => {
  // The allowlist is the real lock, but a typo creating a stray account in a
  // Supabase project shared with another app would still be wrong.
  assert.match(datajs, /shouldCreateUser: false/);
});

test('the page ships no secret, and loads nothing from another host', () => {
  assert.ok(!/service_role|SUPABASE_SERVICE_ROLE_KEY/.test(appjs + datajs), 'the service key must never appear in browser code');
  assert.ok(!/GEMINI_API_KEY|OPENROUTER_API_KEY|YOUTUBE_API_KEY/.test(appjs + datajs), 'API keys belong in Supabase secrets, read by the functions');
  // No CDNs: everything is vendored, so the app keeps working offline later.
  for (const [file, source] of [['index.html', html], ['app.js', appjs], ['data.js', datajs]]) {
    const remote = [...source.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)/g)].map((m) => m[1]);
    assert.deepEqual(remote, [], `${file} loads ${remote.join(', ')} from another host`);
  }
});

test('every module the browser imports is actually shipped', () => {
  // There is no bundler: an import the browser cannot resolve is a 404 and a
  // blank screen. Adding shared/edit-plan.mjs without adding it to the list the
  // build ships nearly did exactly that.
  const missing = [];
  for (const name of fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    for (const m of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(PUBLIC, m[1]);
      if (!fs.existsSync(target)) missing.push(`${name} imports ${m[1]}, which is not in public/`);
    }
  }
  assert.deepEqual(missing, [], `${missing.join('\n  ')}\n  Add it to BROWSER_SHARED and run: npm run sync:shared`);
});

test('the client targets the viralradar schema', () => {
  // Without this every query hits "public", which belongs to the other app in
  // this Supabase project. It would fail confusingly rather than loudly.
  assert.match(datajs, /db: \{ schema: 'viralradar' \}/);
});

test('user text is escaped wherever it is put into HTML', () => {
  // The screens build HTML as strings, so anything interpolated raw is a bug.
  // Only template literals that actually contain markup are checked: plenty of
  // others build a line for a toast or a clipboard, where escaping would be
  // wrong rather than missing.
  const htmlLiterals = [...appjs.matchAll(/`[^`]*`/g)].map((m) => m[0]).filter((s) => /<[a-z][a-z0-9-]*[\s>/]/i.test(s));
  assert.ok(htmlLiterals.length > 10, `expected to find the screens, found ${htmlLiterals.length} HTML templates`);

  // Values that escape for themselves, or that cannot carry user text.
  // Builders that escape whatever they are given, so their output is markup on
  // purpose rather than by accident.
  // devicesLine(), renderAngles(), renderPack(), hookSheetHead() and the
  // *_BUTTON helpers are in here with the other builders because they escape
  // every value they interpolate — see the
  // tests below, which hold them to that. renderAngles and renderPack put
  // model-written text on screen, so they are the ones that matter most.
  // encodeURIComponent() is on the list for a different reason: it percent-
  // encodes, so its output cannot be markup at all.
  const safe = /^(esc\(|fmt\(|compact\(|ago\(|when\(|copyBtn\(|hbars\(|format\(|formatBytes\(|renderEditPlan\(|renderDemo\(|renderOriginalIdea\(|renderPendingGeneration\(|PASTE_BUTTON\(|makeButton\(|devicesLine\(|renderAngles\(|ANGLES_BUTTON\(|HOOKS_BUTTON\(|hookSheetHead\(|renderPack\(|RESEARCH_BUTTON\(|packLink\(|packList\(|liveBadge\(|factClass\(|renderLocalFolderSettings\(|encodeURIComponent\(|GENERATING\[|KIND_ICON|SOURCE|LIVE_LABEL|STAGES|LENGTHS|DEFAULT_AI_ORDER)/;
  const bad = [];
  for (const literal of htmlLiterals) {
    for (const m of literal.matchAll(/\$\{([^{}]*)\}/g)) {
      const expr = m[1].trim();
      if (!expr || safe.test(expr)) continue;
      // Nested templates, conditionals and loops are assembled from pieces that
      // are themselves checked; numbers and booleans cannot inject markup.
      if (/\?|&&|\|\||\.map\(|\.join\(|\.filter\(|\.length|\.toFixed|\.slice|Math\.|\+ 1|=== |!== |^\d/.test(expr)) continue;
      if (/^[a-zA-Z0-9_.[\]]+$/.test(expr) && !/\.(title|name|label|message|error|summary|topic|hook|email|url|id)\b/.test(expr)) continue;
      bad.push(expr);
    }
  }
  assert.deepEqual(bad, [], `these go into HTML unescaped:\n  ${bad.join('\n  ')}`);
});

test('the sign-in screen explains itself without jargon', () => {
  const screen = appjs.slice(appjs.indexOf('function renderLogin'), appjs.indexOf('actions.signInPassword'));
  assert.match(screen, /stays signed in/i, 'people should know it is once per device, not every visit');
  assert.ok(!/magic link|OTP|JWT|RLS/i.test(screen.replace(/sign-in link/gi, '')), 'say what it does, not what it is called');
});

test('no password or credential is baked into the shipped files', () => {
  // Everything in public/ is served to whoever asks for it, so a password in
  // the code is a password everyone has. The only safe place for one is
  // Supabase, which stores it hashed and never gives it back.
  const files = fs.readdirSync(PUBLIC).filter((n) => /\.(js|html|css)$/.test(n));
  const assigned = /(password|passwd|secret|pwd)\s*[:=]\s*['"`]([^'"`]{3,})['"`]/gi;
  // Naming an input, or an autocomplete hint, is not a stored credential.
  const harmless = /^(current-password|new-password|password|Your password|#password)$/i;

  const suspicious = [];
  for (const name of files) {
    const source = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    for (const m of source.matchAll(assigned)) {
      if (harmless.test(m[2])) continue;
      suspicious.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(suspicious, [], `these look like credentials in shipped code:\n  ${suspicious.join('\n  ')}`);
});

test('the sign-in screen asks for a password and keeps the link as a fallback', () => {
  const screen = appjs.slice(appjs.indexOf('function renderLogin'), appjs.indexOf('actions.sendLink'));
  assert.match(screen, /type="password"/, 'there has to be a password field');
  assert.match(screen, /autocomplete="current-password"/, 'so a password manager can fill it');
  assert.match(screen, /autocomplete="username"/);
  assert.match(screen, /signInPassword/, 'the primary action is signing in with the password');
  assert.match(screen, /sendLink/, 'the email link stays as a way back in');
  assert.match(screen, /stays signed in/i, 'people should know it is once per device');
});

test('the paste button is on the three screens where an export lands', () => {
  // Copying in Shorts Studio and tapping once should be the whole job, from
  // whichever screen you happen to be on.
  for (const screen of ['renderIdeas', 'renderScripts', 'renderImport']) {
    const start = appjs.indexOf(`function ${screen}`);
    assert.ok(start > 0, `${screen} not found`);
    const body = appjs.slice(start, appjs.indexOf('\n}', start));
    assert.match(body, /PASTE_BUTTON\(\)/, `${screen} has no paste button`);
  }
});

test('the paste button copes with a browser that will not allow it', () => {
  // Reading the clipboard needs permission, and some browsers refuse outright.
  // The paste box is always there, so the button must point at it rather than
  // simply failing.
  const fn = appjs.slice(appjs.indexOf('actions.pasteImport'), appjs.indexOf('function showImportResult'));
  assert.match(fn, /navigator\.clipboard\.readText/);
  assert.match(fn, /!navigator\.clipboard/, 'a browser with no clipboard API at all must not throw');
  assert.match(fn, /catch/, 'a refused permission rejects, and must be caught');
  assert.match(fn, /paste box/i, 'the fallback has to be named, not just implied');
  assert.match(fn, /#\/import/, 'and the person should be taken there');
  assert.match(fn, /nothing on the clipboard/i, 'an empty clipboard is its own case');
});

// ---------- project folders ----------

test('the Projects screen is a route, and the hash query does not break it', () => {
  // The service worker reports a share back as "#/projects?shared=1". Splitting
  // the hash on "/" without taking the query off first would make the route
  // name "projects?shared=1", match nothing, and quietly land on the radar.
  assert.match(appjs, /const routes = \{[^}]*projects: renderProjects/);
  const parse = appjs.slice(appjs.indexOf('function parseHash'), appjs.indexOf('const currentRoute'));
  assert.match(parse, /split\('\?'\)/, 'the query has to come off before the path is split');
  // And nothing may go back to reading the hash by hand, or the two disagree.
  assert.ok(!/location\.hash\.split\('\/'\)/.test(appjs), 'the hash should only be read through parseHash()');
});

test('a note or a file says which device it came from', () => {
  // "New from Laptop" is the point of the whole feature; without a device name
  // it reads as "New from null".
  assert.match(appjs, /deviceName\(\)/);
  const live = appjs.slice(appjs.indexOf('function startProjectLive'), appjs.indexOf('// ---------- router'));
  assert.match(live, /New from \$\{from\}/, 'the toast has to name the device');
  // An item this device just added comes back over Realtime too. Announcing it
  // on the device that sent it would be nonsense.
  assert.match(live, /from !== deviceName\(\)/, 'an item must not be announced on the device that sent it');
  assert.match(live, /itemPreview\(/, 'the toast should show what arrived, not just that something did');
});

test('the device name stays on the device and never reaches the database', () => {
  // It is per device, so it cannot live in the settings row, which every
  // device shares.
  const block = appjs.slice(appjs.indexOf('const DEVICE_KEY'), appjs.indexOf('// ---------- live updates'));
  assert.match(block, /localStorage/);
  assert.match(block, /catch/, 'private mode throws on localStorage, and a label is not worth a crash');
  assert.match(block, /guessDeviceName/, 'there has to be a sensible name before anyone sets one');
  // The settings table has no column for it, so sending one would simply fail.
  assert.ok(!/device/i.test(datajs.slice(datajs.indexOf('const settings ='), datajs.indexOf('const ideas ='))),
    'the device name must not be written to the shared settings row');
});

test('the browser refuses an upload itself rather than finding out from the server', () => {
  // The database and the storage policies enforce the same limits, but their
  // refusals arrive after the bytes have been sent, which on mobile data is
  // someone's money.
  const upload = appjs.slice(appjs.indexOf('async function uploadFiles'), appjs.indexOf('afterRender.projects'));
  assert.match(upload, /checkUpload\(/, 'the limits are checked before uploading, not after');
  assert.match(upload, /used \+= file\.size/, 'the running total must grow, or the cap is checked against a stale figure');
  // One at a time: three 20 MB uploads in parallel on mobile data is how you
  // get three timeouts instead of one success.
  assert.match(upload, /for \(const \[n, file\] of files\.entries\(\)\)/);
  assert.match(upload, /Uploading \$\{n \+ 1\} of \$\{files\.length\}/, 'a long upload has to say where it has got to');
  assert.match(upload, /failed\.push/, 'one bad file must not stop the others');
});

test('the screens say that raw video is never uploaded', () => {
  // Otherwise the first thing anyone tries is a video, and a refusal with no
  // explanation reads as a bug rather than as a deliberate limit.
  const screen = appjs.slice(appjs.indexOf('async function renderProjectDetail'), appjs.indexOf('actions.setProjectStatus'));
  assert.match(screen, /device to the other|device to device/i, 'say where video does go, not only that it cannot go here');
  assert.match(screen, /POSTED_RETENTION_DAYS/, 'a folder marked posted loses its files, and should say so before it does');
});

test('files are never served from a public URL', () => {
  // A public bucket would mean a URL that works for anyone who has it, forever.
  assert.match(datajs, /createSignedUrl/);
  assert.ok(!/getPublicUrl/.test(datajs + appjs), 'a public URL would outlive every policy in the database');
});

// ---------- research pack ----------

test('every value a pack puts on screen is escaped', () => {
  // A pack is model-written prose about pages that were fetched from the open
  // web. Both halves of that are other people's text. It is on the safe list
  // above, which is only true while this holds.
  const fn = appjs.slice(appjs.indexOf('let pack = null'), appjs.indexOf('actions.closePack'));
  // Only the templates that actually contain markup. The others build a line
  // for the clipboard, where escaping would be wrong rather than missing.
  const htmlLiterals = [...fn.matchAll(/`[^`]*`/g)].map((m) => m[0]).filter((t) => /<[a-z][a-z0-9-]*[\s>/]/i.test(t));
  const interpolations = htmlLiterals.flatMap((t) => [...t.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1].trim()));
  assert.ok(interpolations.length >= 15, `expected the values it interpolates, found ${interpolations.length}`);
  for (const expr of interpolations) {
    const ok = /^(esc\(|copyBtn\(|packLink\(|packList\(|liveBadge\(|factClass\(|encodeURIComponent\()/.test(expr)
      || expr === 'facts' || /\.map\(|\.join\(|\?|&&|\|\|/.test(expr)
      // A count cannot carry markup.
      || /^p\.downgraded_count$/.test(expr);
    assert.ok(ok, `renderPack puts ${expr} into HTML without escaping it`);
  }
  // The URL is the one field a reader is invited to click, so it is also the
  // one worth naming here: "javascript:" in an href is not stopped by escaping.
  assert.match(fn, /esc\(url\)/, 'a source URL goes into an href');
  assert.match(fn, /rel="noopener noreferrer"/, 'a fetched page is not trusted with the opener');
  for (const field of ['tool.name', 'tool.what_it_does', 'a.name', 'f.claim', 'f.source_url']) {
    assert.ok(fn.includes(`esc(${field}`), `${field} comes from the model and must be escaped`);
  }
});

test('a badge says what the fetch found, never what the model claimed', () => {
  // The whole feature rests on this. If "Live" could come from the model's own
  // JSON, an invented page would be presented as one that loaded.
  const fn = appjs.slice(appjs.indexOf('const liveBadge'), appjs.indexOf('function renderPack'));
  assert.match(fn, /reachable \?/, 'the badge is driven by the reachable flag');
  assert.match(fn, /Live/);
  assert.match(fn, /Not reachable/);

  // And reachable is set by the server from the fetch result, not copied from
  // the model — see normalisePack in shared/research.mjs, where it is enforced.
  const research = fs.readFileSync(path.join(ROOT, 'shared', 'research.mjs'), 'utf8');
  assert.match(research, /reachable: checked \? known\(/, 'reachable has to come from the pages that loaded');
});

test('a verified claim and an unverified one cannot look the same', () => {
  // Showing an unverified claim is deliberate: it is the thing to go and check
  // before recording. Showing it as if it were a fact is the failure this
  // whole feature exists to prevent, so the two must be styled apart.
  const fn = appjs.slice(appjs.indexOf('function renderPack'), appjs.indexOf('actions.closePack'));
  // One of three literal class names, via a function, never the model's own
  // string: a class attribute assembled from JSON is not worth trusting twice.
  assert.match(fn, /class="fact \$\{factClass\(factStatus\(f\)\)\}"/,
    'the status has to reach the markup, via functions that return one of three known names');
  assert.match(fn, /badge good.*Verified/s);
  assert.match(fn, /badge warn.*Unverified/s);
  assert.match(fn, /badge">\? Not checked/s);
  const factClassFn = fn.slice(fn.indexOf('const factClass'), fn.indexOf('const facts ='));
  assert.match(factClassFn, /'verified'/);
  assert.match(factClassFn, /'unverified'/);
  assert.match(factClassFn, /'unchecked'/);

  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  assert.match(css, /\.fact\.verified/, 'a verified claim needs its own look');
  assert.match(css, /\.fact\.unverified/, 'and an unverified one must differ from it');
  assert.match(css, /\.fact\.unchecked/, 'and an unchecked one must differ from both');
});

test('Research Pack is offered on a trend, an idea and in the free-text box', () => {
  // The three places a subject arrives from. A trend carries its own URL, so
  // nothing has to be guessed there.
  const radar = appjs.slice(appjs.indexOf('async function renderRadar'));
  assert.match(radar.slice(0, radar.indexOf('\n}')), /RESEARCH_BUTTON\([^\n]*t\.url\)/,
    'a trend has a URL; using it means no page is guessed');

  for (const screen of ['async function renderIdeas', 'function renderScripts']) {
    const start = appjs.indexOf(screen);
    assert.ok(start > 0, `${screen} not found`);
    const body = appjs.slice(start, appjs.indexOf('\n}', start));
    assert.ok(/RESEARCH_BUTTON\(|data-action="researchFromBox"/.test(body), `${screen} has no way to research`);
    assert.match(body, /renderPack\(\)/, `${screen} never shows the pack it asked for`);
  }
  assert.ok(appjs.includes('actions.researchPack ='));
  assert.ok(appjs.includes('actions.researchFromBox ='));
  assert.ok(appjs.includes('data-action="researchPack"'));
});

test('what a pack hands on to a script is the verified half only', () => {
  // packSummary() drops every unverified claim. If the raw pack were sent
  // instead, a script could repeat something that was never on any page.
  const block = appjs.slice(appjs.indexOf('let pack = null'), appjs.indexOf('// ================= ANGLES'));
  for (const action of ['anglesFromPack', 'scriptFromPack']) {
    const fn = block.slice(block.indexOf(`actions.${action}`));
    assert.match(fn.slice(0, fn.indexOf('};')), /research: packSummary\(pack\.data\)/,
      `${action} must pass the summary, not the pack`);
  }
  assert.ok(!/research: pack\.data|research: JSON\.stringify\(pack/.test(appjs),
    'the unverified claims must never reach a prompt');

  // Writing a script from an angle that came out of a pack carries the facts
  // too — the angles on screen were written from them.
  const write = appjs.slice(appjs.indexOf('actions.writeAngle'));
  assert.match(write.slice(0, write.indexOf('};')), /packSummary\(pack\.data\)/);

  const research = fs.readFileSync(path.join(ROOT, 'shared', 'research.mjs'), 'utf8');
  const summary = research.slice(research.indexOf('export function packSummary'));
  assert.match(summary, /status === 'verified'/, 'the summary is the verified claims and nothing else');
});

// ---------- angles ----------

test('every value an angle puts on screen is escaped', () => {
  // These are the only strings in the app written by a model and rendered as
  // markup. It is on the safe list above, which is only true while this holds.
  const fn = appjs.slice(appjs.indexOf('function renderAngles'), appjs.indexOf('actions.closeAngles'));
  const interpolations = [...fn.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1].trim());
  assert.ok(interpolations.length >= 5, 'expected to find the values it interpolates');
  for (const expr of interpolations) {
    // Escaping builders, assembled pieces that are themselves checked, and the
    // loop index — a number cannot carry markup.
    const ok = expr.startsWith('esc(') || expr.startsWith('copyBtn(') || expr === 'cards'
      || /^i( \+ \d+)?$/.test(expr) || /\.map\(|\.join\(|\?/.test(expr);
    assert.ok(ok, `renderAngles puts ${expr} into HTML without escaping it`);
  }
  for (const field of ['a.type', 'a.title', 'a.hook', 'a.twist', 'angles.topic']) {
    assert.ok(fn.includes(`esc(${field}`) || new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(fn),
      `${field} comes from the model and must be escaped`);
  }
});

test('angles are a step before the script, and are never stored', () => {
  // Writing five angles to the database every time a trend was looked at would
  // fill the Ideas screen with things nobody chose to make.
  const block = appjs.slice(appjs.indexOf('// ================= ANGLES'), appjs.indexOf('// ================= IDEAS'));
  assert.ok(!/data\.ideas\.|data\.scripts\.|upsert|insert/.test(block), 'an angle is a decision, not a row');
  assert.match(block, /let angles = null/, 'they live in memory until dismissed');
  assert.match(block, /actions\.closeAngles/, 'and there has to be a way to dismiss them');

  // Picking one writes a script to that angle, carrying the topic with it.
  const write = block.slice(block.indexOf('actions.writeAngle'));
  assert.match(write, /kind: 'script'/);
  assert.match(write, /topic: angles\.topic/, 'the topic says what, the angle says how');
  assert.match(write, /angle\b/);
});

test('Find angles is offered on both a trend and an idea', () => {
  // The two places a subject arrives from. Pressing "Write script" straight off
  // a trend gives you the video somebody else already made.
  for (const screen of ['async function renderRadar', 'async function renderIdeas']) {
    const start = appjs.indexOf(screen);
    assert.ok(start > 0, `${screen} not found`);
    const body = appjs.slice(start, appjs.indexOf('\n}', start));
    assert.match(body, /ANGLES_BUTTON\(/, `${screen} has no "Find angles"`);
    assert.match(body, /renderAngles\(\)/, `${screen} never shows the angles it asked for`);
  }
  assert.ok(appjs.includes('actions.findAngles ='));
  assert.ok(appjs.includes('data-action="findAngles"'));
});

test('a personalised generation says so, and an unpersonalised one stays quiet', () => {
  // "Personalised from your N logged videos" must never appear on a channel
  // with four results: it would be a claim about a pattern that does not exist.
  assert.match(appjs, /lessonLabel\(/);
  const askAi = appjs.slice(appjs.indexOf('async function askAi'), appjs.indexOf('actions.generateIdeas'));
  assert.match(askAi, /result\.personalised \?/, 'the badge has to be conditional on the server saying so');
  assert.match(askAi, /result\.results_count/);
});

// ---------- sending a video between devices ----------

test('devicesLine escapes every value it puts in markup', () => {
  // It is on the safe list above, which is only true while this holds: a device
  // name is typed by a person and goes straight into HTML.
  const fn = appjs.slice(appjs.indexOf('function devicesLine'), appjs.indexOf('actions.setProjectStatus'));
  const interpolations = [...fn.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1].trim());
  assert.ok(interpolations.length >= 2, 'expected to find the values it interpolates');
  for (const expr of interpolations) {
    const safe = expr.startsWith('esc(') || /\.map\(|\.join\(|\?/.test(expr);
    assert.ok(safe, `devicesLine puts ${expr} into HTML without escaping it`);
  }
  assert.match(fn, /esc\(p\.device\)/, 'a device name is typed by a person');
  assert.match(fn, /esc\(state\.deviceError\)/);
});

test('the video never touches Storage, and the row never claims it does', () => {
  // The whole reason Part 2 exists: a 2 GB video does not fit in a 300 MB slice
  // of a shared project. A stray upload call here would undo the point of it.
  const section = appjs.slice(appjs.indexOf('// ================= SENDING A VIDEO'), appjs.indexOf('// ---------- things shared into'));
  assert.ok(!/addFile|storage\.from|upload\(/.test(section), 'a video must never be uploaded');
  assert.match(section, /addVideoRef/, 'only a note is saved');
  // And the note is written with the digest the two ends agreed on, never before.
  const sendTo = section.slice(section.indexOf('actions.sendVideoTo'), section.indexOf('// ---- receiving'));
  assert.ok(sendTo.indexOf('await sendTo(') < sendTo.indexOf('addVideoRef'),
    'the note must be written after the transfer, with the verified digest');
  assert.match(sendTo, /sha256: result\.sha256/);
});

// ---------- local project folders ----------

test('archived projects are hidden by default, with a way to see them again', () => {
  const fn = appjs.slice(appjs.indexOf('async function renderProjects'), appjs.indexOf('actions.toggleShowArchived'));
  assert.match(fn, /p\.status === 'archived'/, 'archiving has to actually filter something');
  assert.match(fn, /state\.showArchived/);
  assert.ok(!appjs.includes('showArchived: true'), 'it must start hidden, not shown');
});

test('deleting a project asks first, says what it removes, and says the local folder is untouched', () => {
  const fn = appjs.slice(appjs.indexOf('function renderDeleteProjectConfirm'), appjs.indexOf('actions.confirmDeleteProject'));
  for (const expr of ['notes', 'files', 'bytes']) assert.match(fn, new RegExp(expr), `must count ${expr}`);
  assert.match(fn, /esc\(project\.title\)/);
  assert.match(fn, /not deleted — only unlinked/);
  assert.match(fn, /local folder is never touched/);
  assert.match(fn, /esc\(project\.local_folder_name\)/);
  assert.match(fn, /cannot be undone/);
});

test('the Inbox cannot be offered for deletion from its own screen', () => {
  const fn = appjs.slice(appjs.indexOf('async function renderProjectDetail'), appjs.indexOf('async function devicesLine') > -1
    ? appjs.indexOf('function devicesLine') : appjs.length);
  assert.match(fn, /!project\.is_inbox \? '<button type="button" class="sm ghost" data-action="confirmDeleteProject">/);
});

test('deleting a project removes it through data.projects.remove, the files-first path', () => {
  const fn = appjs.slice(appjs.indexOf('actions.deleteProject ='), appjs.indexOf('actions.deleteProject =') + 400);
  assert.match(fn, /data\.projects\.remove\(/);
  assert.match(fn, /location\.hash = '#\/projects'/, 'leave the deleted project\'s own screen');
});

test('the local folder section shows the connected folder\'s name and permission state first, with Change and Forget', () => {
  const fn = appjs.slice(appjs.indexOf('function renderLocalFolderSettings'), appjs.indexOf('actions.chooseLocalFolder'));
  const nameAt = fn.indexOf('state.localRootName');
  const permAt = fn.indexOf('LOCAL_PERMISSION_LABEL');
  const changeAt = fn.indexOf('Change folder');
  const forgetAt = fn.indexOf('data-action="forgetLocalFolder"');
  assert.ok(nameAt > 0 && permAt > nameAt, 'name, then permission state, in that order');
  assert.ok(changeAt > permAt && forgetAt > permAt, 'both actions come after the status, not before it');
  assert.match(fn, /Change folder/);
  assert.match(fn, /Forget folder/);
});

test('the radar language checkboxes are escaped and reflect what is saved', () => {
  const fn = appjs.slice(appjs.indexOf('<h2>Radar languages</h2>'), appjs.indexOf('<h2>Backup &amp; restore</h2>'));
  assert.match(fn, /RADAR_LANGUAGE_OPTIONS\.map/);
  assert.match(fn, /esc\(code\)/);
  assert.match(fn, /esc\(label\)/);
  assert.match(fn, /s\.radar_languages \|\| \[\]\)\.includes\(code\)/);
});

test('saving radar languages refuses an empty selection rather than silently filtering everything', () => {
  const fn = appjs.slice(appjs.indexOf('actions.saveRadarLanguages'), appjs.indexOf('actions.saveWriting'));
  assert.match(fn, /if \(!list\.length\)/, 'an empty list must be refused before it reaches settings');
  assert.match(fn, /radar_languages: list/);
});

test('the local folder is offered only where the API actually exists', () => {
  const section = appjs.slice(appjs.indexOf('function renderLocalFolderSettings'), appjs.indexOf('actions.chooseLocalFolder'));
  assert.match(section, /isLocalFolderSupported\(\)/, 'unsupported browsers must see a message, not a dead button');
  assert.match(section, /Chrome or Edge/i);
});

test('every value the local-folder panels put on screen is escaped', () => {
  for (const [start, end] of [
    ['function renderLocalFolderSettings', 'actions.chooseLocalFolder'],
    ['async function localFolderSection', 'actions.rescanLocalFolder'],
  ]) {
    const fn = appjs.slice(appjs.indexOf(start), appjs.indexOf(end));
    const interpolations = [...fn.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1].trim());
    assert.ok(interpolations.length >= 3, `expected ${start} to interpolate something, found ${interpolations.length}`);
    for (const expr of interpolations) {
      const ok = /^(esc\(|formatBytes\(|item\()/.test(expr)
        // Assembled from pieces checked individually, or a constant/number
        // that cannot carry markup.
        || /\.map\(|\.join\(|\?|&&|\.count\b|LOCAL_RAW_RETENTION_DAYS|LOCAL_SUBFOLDERS/.test(expr);
      assert.ok(ok, `${start} puts ${expr} into HTML without escaping it`);
    }
  }
});

test('a chosen local folder name is persisted once, never recomputed from a renamed title', () => {
  const fn = appjs.slice(appjs.indexOf('async function ensureFolderName'), appjs.indexOf('async function resolveTransferFolder'));
  assert.match(fn, /if \(project\.local_folder_name\) return project\.local_folder_name;/, 'an existing folder name must win over recomputing one');
  assert.match(fn, /setLocalFolderName/, 'a freshly computed name has to be saved, or this check never helps again');
  // Both localFolderSection() (opening a project) and resolveTransferFolder()
  // (a video arriving for one) go through this single function, so neither
  // can drift from the other's idea of what a project's folder is called.
  const section = appjs.slice(appjs.indexOf('async function localFolderSection'), appjs.indexOf('actions.rescanLocalFolder'));
  assert.match(section, /ensureFolderName\(project\)/);
  const resolve = appjs.slice(appjs.indexOf('async function resolveTransferFolder'), appjs.indexOf('async function localFolderSection'));
  assert.match(resolve, /ensureFolderName\(project\)/);
});

test('syncing a project folder never deletes anything outside the generated files', () => {
  // The whole guarantee lives in shared/localfolder.mjs (isGeneratedName,
  // diffGeneratedFiles) and is proved there against a fake handle; this just
  // confirms the browser wiring calls the function that carries it rather
  // than reaching into a directory handle directly.
  const fn = appjs.slice(appjs.indexOf('async function localFolderSection'), appjs.indexOf('actions.rescanLocalFolder'));
  assert.match(fn, /syncGeneratedFiles\(/);
  assert.ok(!/removeEntry|getFileHandle/.test(fn), 'file-level writes and deletes belong in shared/localfolder.mjs, not here');
});

test('a video received for a project resolves its folder from this device\'s own data, never from the sender', () => {
  const section = appjs.slice(appjs.indexOf('// ================= SENDING A VIDEO'), appjs.indexOf('// ---------- things shared into'));
  const accept = section.slice(section.indexOf('actions.acceptVideo'));
  assert.match(accept, /resolveTransferFolder\(message\.projectId\)/,
    'the only thing taken from the message is an id; everything else about the folder comes from this device\'s own lookup');
  assert.match(accept, /rawSink\(/, 'the local-folder sink must be offered as an alternative to the save dialog');
  assert.match(accept, /rawSink\(state\.localRoot, localFolderName,/,
    'the folder name passed to rawSink must be the resolved local variable, not anything read off the message');
  assert.ok(!/message\.projectFolder|message\.folder/.test(accept),
    'no field read straight off the message may ever be used as a folder name');

  // resolveTransferFolder() itself is where the real guarantee lives: an id
  // resolved through this account's own RLS-scoped projects.get(), never a
  // name taken from the signal.
  const resolve = appjs.slice(appjs.indexOf('async function resolveTransferFolder'), appjs.indexOf('async function localFolderSection'));
  assert.match(resolve, /data\.projects\.get\(projectId\)/);
  assert.match(resolve, /ensureFolderName\(project\)/);
  assert.ok(!/projectFolder/.test(resolve), 'nothing here may read a folder name off anything but its own database row');
});

test('sending a video passes this project\'s id along as a hint, never a requirement', () => {
  const section = appjs.slice(appjs.indexOf('// ================= SENDING A VIDEO'), appjs.indexOf('// ---------- things shared into'));
  const sendTo = section.slice(section.indexOf('actions.sendVideoTo'), section.indexOf('// ---- receiving'));
  assert.match(sendTo, /projectId,/, 'the id travels; a folder name never does');
  assert.ok(!/data\.projects\.get\(/.test(sendTo), 'the sender has no reason to look anything up — it already has the id');
});

test('every value the demo section puts on screen is escaped, including the exact prompt text', () => {
  // The prompt is the one line this whole feature exists to get exactly
  // right — literally "copy this and paste it into the tool" — so it is
  // also the one most worth checking actually goes through esc() rather
  // than straight into a <pre>.
  const fn = appjs.slice(appjs.indexOf('function renderDemo'), appjs.indexOf('// ---- edit plan ----'));
  const interpolations = [...fn.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1].trim());
  assert.ok(interpolations.length >= 5, `expected renderDemo to interpolate something, found ${interpolations.length}`);
  for (const expr of interpolations) {
    const ok = /^(esc\(|copyBtn\(|list\()/.test(expr) || /\.map\(|\.join\(|\?/.test(expr) || expr === 'ordered';
    assert.ok(ok, `renderDemo puts ${expr} into HTML without escaping it`);
  }
  assert.match(fn, /esc\(p\)/, 'a prompt has to be escaped before it reaches the <pre>');
  assert.match(fn, /esc\(demo\.url\)/);
});

test('the demo section says "Not checked yet" only when the pack behind it was never fetched', () => {
  const fn = appjs.slice(appjs.indexOf('function renderDemo'), appjs.indexOf('// ---- edit plan ----'));
  assert.match(fn, /demo\.checked === false/, 'the gate must be the explicit false, not falsy');
  assert.match(fn, /Not checked yet/);
  assert.match(fn, /Re-check links/, 'the notice should point at the fix, not just the problem');
});

// ---------- navigating to where a result will appear ----------

test('a script generation survives the tab closing: the request is saved, not only kept in memory', () => {
  const fn = appjs.slice(appjs.indexOf('async function runPendingGeneration'), appjs.indexOf('/** The loading'));
  assert.match(fn, /if \(body\.kind === 'script'\) savePendingScript\(key, body\);/,
    'the request has to be saved before the network call, not after it resolves');
  assert.match(fn, /if \(body\.kind === 'script'\) clearPendingScript\(key\);/,
    'a successful generation must clean up after itself');
  // Saved with try/catch, the same as every other localStorage use in this
  // file — private mode, or a full quota, must not break the loading state.
  const saveFn = appjs.slice(appjs.indexOf('function savePendingScript'), appjs.indexOf('function loadPendingScript'));
  assert.match(saveFn, /try \{/);
  assert.match(saveFn, /catch/);
});

test('reopening an unfinished script offers Retry instead of "Script not found"', () => {
  const fn = appjs.slice(appjs.indexOf('async function renderScriptDetail'), appjs.indexOf('const beats ='));
  // The normal read is wrapped so a failure can be told apart from "this one
  // genuinely does not exist" — only the former has a saved request to retry.
  assert.match(fn, /try \{\s*s = await data\.scripts\.get\(id\);\s*\} catch \(e\) \{/s);
  assert.match(fn, /const saved = loadPendingScript\(id\);/);
  assert.match(fn, /if \(!saved\) throw e;/, 'a genuinely unknown id must still fail, not silently show Retry');
  assert.match(fn, /This script didn't finish/);
  assert.match(fn, /data-action="resumePendingScript" data-id="\$\{esc\(id\)\}"/);
});

test('resuming an unfinished script replays the exact saved request, through whichever mechanism wrote it', () => {
  const fn = appjs.slice(appjs.indexOf('actions.resumePendingScript'), appjs.indexOf('actions.resumePendingScript') + 300);
  assert.match(fn, /loadPendingScript\(btn\.dataset\.id\)/);
  // A plain script write and a New Project pipeline save differently-shaped
  // bodies under the same key, so resuming has to tell them apart rather than
  // always calling one function — see runOwnIdeaPipeline's own save below.
  assert.match(fn, /saved\.__ownIdeaPipeline/);
  assert.match(fn, /runOwnIdeaPipeline\(btn\.dataset\.id, saved\.request\)/);
  assert.match(fn, /runPendingGeneration\(btn\.dataset\.id, saved\)/);
});

test('writing a script goes straight to its own screen, with a loading state, before the generation starts', () => {
  const fn = appjs.slice(appjs.indexOf('async function writeScriptTo'), appjs.indexOf('actions.generateIdeas'));
  assert.match(fn, /location\.hash = `#\/scripts\/\$\{encodeURIComponent\(id\)\}`/, 'the navigation must happen immediately');
  assert.match(fn, /runPendingGeneration\(id,/);
  // The id is made before the request is sent, and sent with it — the
  // navigation and the generation have to agree on where the result lands.
  const order = fn.indexOf('location.hash');
  const sendOrder = fn.indexOf('runPendingGeneration');
  assert.ok(order > 0 && order < sendOrder, 'navigation must come before the request is sent, not after');
});

test('every entry point that writes a script goes through writeScriptTo, not straight to the AI call', () => {
  for (const action of ['writeScript', 'writeScriptFromBox', 'writeAngle', 'scriptFromPack', 'useHook']) {
    const start = appjs.indexOf(`actions.${action} =`);
    assert.ok(start > 0, `actions.${action} is not defined`);
    const body = appjs.slice(start, appjs.indexOf('\n};', start));
    assert.match(body, /writeScriptTo\(/, `actions.${action} must navigate via writeScriptTo()`);
  }
});

test('the script screen shows a loading or failed state instead of "not found" while one is being written', () => {
  const fn = appjs.slice(appjs.indexOf('async function renderScriptDetail'), appjs.indexOf('const beats ='));
  assert.match(fn, /renderPendingGeneration\(id,/);
  // The pending check has to come before the row is actually read, or a
  // script that does not exist yet would just throw "Script not found".
  const pendingAt = fn.indexOf('const writing = renderPendingGeneration');
  const readAt = fn.indexOf('data.scripts.get(id)');
  assert.ok(pendingAt > 0 && pendingAt < readAt, 'the pending check must come before reading the row');
});

// ---------- New Project: from your own idea ----------

test('New Project is reachable from all three entry points: Projects, the desktop top bar, and Ideas', () => {
  assert.match(appjs, /data-action="openNewProject"/, 'the Projects screen button');
  for (const action of ['newScript', 'openNewProject']) {
    const body = appjs.slice(appjs.indexOf(`actions.${action} =`), appjs.indexOf(`actions.${action} =`) + 120);
    assert.match(body, /startNewProject\(\)/, `actions.${action} must open New Project, not do something else`);
  }
});

test('the New Project form is refused before the dialog closes, not after', () => {
  const fn = appjs.slice(appjs.indexOf('function openNewProject'), appjs.indexOf('async function startNewProject'));
  // A native <dialog> form submit closes it immediately unless prevented —
  // validating only in the 'close' handler would be too late to stop it.
  const submitAt = fn.indexOf("addEventListener('submit'");
  assert.ok(submitAt > 0, 'the form needs its own submit handler, not just a close handler');
  const submitBlock = fn.slice(submitAt, fn.indexOf('};', submitAt));
  assert.match(submitBlock, /validateNewProject\(/);
  assert.match(submitBlock, /e\.preventDefault\(\)/);
});

test('cancelling New Project does nothing: no project, no idea, no pipeline', () => {
  const fn = appjs.slice(appjs.indexOf('function openNewProject'), appjs.indexOf('async function startNewProject'));
  assert.match(fn, /returnValue === 'cancel'.*resolve\(null\)/s);
  const startFn = appjs.slice(appjs.indexOf('async function startNewProject'), appjs.indexOf('actions.openNewProject'));
  assert.match(startFn, /if \(!answer\) return;/);
});

test('"just save the idea" writes the idea and a note, but never calls the AI', () => {
  const fn = appjs.slice(appjs.indexOf('async function startNewProject'), appjs.indexOf('actions.openNewProject'));
  const saveOnlyBlock = fn.slice(fn.indexOf("mode === 'save_only'"), fn.indexOf('return;\n  }'));
  assert.match(saveOnlyBlock, /data\.projects\.create\(/);
  assert.match(saveOnlyBlock, /data\.items\.addText\(/);
  assert.match(saveOnlyBlock, /data\.ideas\.create\(/);
  assert.ok(!/data\.ai\.(generate|research)\(/.test(saveOnlyBlock), 'save_only must generate nothing');
});

test('modes a and b create the project and file the original note before the pipeline starts', () => {
  const fn = appjs.slice(appjs.indexOf('async function startNewProject'), appjs.indexOf('actions.openNewProject'));
  const afterSaveOnly = fn.slice(fn.indexOf("return;\n  }"));
  assert.match(afterSaveOnly, /data\.projects\.create\(\{ title: answer\.title, ownIdea: true \}\)/);
  assert.match(afterSaveOnly, /data\.items\.addText\(project\.id, note/);
  assert.match(afterSaveOnly, /runOwnIdeaPipeline\(id, \{ \.\.\.answer, projectId: project\.id, original \}\)/);
  // Navigation must happen before the pipeline, same reason writeScriptTo()'s does.
  const navAt = afterSaveOnly.indexOf('location.hash');
  const pipelineAt = afterSaveOnly.indexOf('runOwnIdeaPipeline(id,');
  assert.ok(navAt > 0 && navAt < pipelineAt);
});

test('runOwnIdeaPipeline saves itself for Retry/resume, wrapped so resumePendingScript can tell it apart', () => {
  const fn = appjs.slice(appjs.indexOf('async function runOwnIdeaPipeline'), appjs.indexOf('actions.generateIdeas'));
  assert.match(fn, /savePendingScript\(id, \{ __ownIdeaPipeline: true, request \}\)/);
  assert.match(fn, /retry: \(\) => runOwnIdeaPipeline\(id, request\)/);
});

test('runOwnIdeaPipeline shows a distinct step label at each stage', () => {
  const fn = appjs.slice(appjs.indexOf('async function runOwnIdeaPipeline'), appjs.indexOf('actions.generateIdeas'));
  const steps = [...fn.matchAll(/step: (.+?)[,}]/g)].map((m) => m[1]);
  assert.ok(steps.some((s) => /Checking your links/.test(s)), 'no step label for the research stage');
  assert.ok(steps.some((s) => s.includes('GENERATING.script')), 'no step label for the writing stage');
  assert.ok(steps.some((s) => s.includes('GENERATING.edit_plan')), 'no step label for the edit-plan stage');
});

test('a failed research step is swallowed: the pipeline continues without a pack rather than failing the whole thing', () => {
  const fn = appjs.slice(appjs.indexOf('async function runOwnIdeaPipeline'), appjs.indexOf('actions.generateIdeas'));
  const researchBlock = fn.slice(fn.indexOf("mode === 'generate'"), fn.indexOf('pendingGen.set(id, { status: \'working\', kind: \'own_idea\', step: GENERATING.script }'));
  assert.match(researchBlock, /try \{/);
  assert.match(researchBlock, /data\.ai\.research\(/);
  assert.match(researchBlock, /catch \(e\) \{/);
  assert.match(researchBlock, /continuing without them/i);
  // The catch must not rethrow — a caught error that is thrown again would
  // still fail the whole pipeline, defeating the point of catching it.
  assert.ok(!/throw/.test(researchBlock), 'the research failure must not propagate and stop the script from being written');
});

test('research only runs for mode "generate", and only when links were given', () => {
  const fn = appjs.slice(appjs.indexOf('async function runOwnIdeaPipeline'), appjs.indexOf('actions.generateIdeas'));
  assert.match(fn, /if \(request\.mode === 'generate' && request\.links\.length\)/);
});

test('own_script mode calls format_script with keep_exact, and both modes pass own_idea and the original input through', () => {
  const fn = appjs.slice(appjs.indexOf('async function runOwnIdeaPipeline'), appjs.indexOf('actions.generateIdeas'));
  assert.match(fn, /kind: 'format_script', id, script: request\.myScript, keep_exact: request\.keepExact/);
  assert.match(fn, /kind: 'script', id, topic:/);
  const genBodies = fn.slice(fn.indexOf('const genBody'), fn.indexOf('const written'));
  assert.match(genBodies, /own_idea: true, original: request\.original/g);
  assert.equal((genBodies.match(/own_idea: true, original: request\.original/g) || []).length, 2, 'both branches must carry it');
});

test('the pipeline writes the script, then the edit plan, in that order, on the same id', () => {
  const fn = appjs.slice(appjs.indexOf('async function runOwnIdeaPipeline'), appjs.indexOf('actions.generateIdeas'));
  const scriptAt = fn.indexOf("data.ai.generate(genBody)");
  const planAt = fn.indexOf("kind: 'edit_plan', script_id: id");
  assert.ok(scriptAt > 0 && planAt > 0 && scriptAt < planAt, 'the edit plan is for a script that must already exist');
});

test('"My idea" is shown on a project card, a script board card, and the script detail, from own_idea alone', () => {
  assert.match(appjs, /p\.own_idea \? '<span class="badge accent">My idea<\/span>' : ''/);
  const scriptsFn = appjs.slice(appjs.indexOf('async function renderScripts'), appjs.indexOf('actions.openScript ='));
  assert.match(scriptsFn, /s\.own_idea \? '<span class="badge accent">My idea<\/span>' : ''/);
  const detailFn = appjs.slice(appjs.indexOf('async function renderScriptDetail'), appjs.indexOf('actions.scrollToEditPlan'));
  assert.match(detailFn, /s\.own_idea \? '<span class="badge accent">My idea<\/span>' : ''/);
});

test('the original idea is shown as a collapsible section, escaped, and absent when there is none', () => {
  const fn = appjs.slice(appjs.indexOf('function renderOriginalIdea'), appjs.indexOf('function renderDemo'));
  assert.match(fn, /<details/, 'it must be collapsible, not always open and in the way');
  assert.match(fn, /esc\(text\)/, 'the creator\'s own words go through esc() like everything else on this screen');
  assert.match(fn, /if \(!original \|\| typeof original !== 'object'\) return '';/);
});

test('an edit plan loads and fails in place, on the script\'s own screen — no navigation needed', () => {
  assert.match(appjs, /actions\.makeEditPlan = \(btn\) => runPendingGeneration\(`edit_plan:\$\{btn\.dataset\.id\}`/);
  const fn = appjs.slice(appjs.indexOf('async function renderScriptDetail'), appjs.indexOf('function renderDemo'));
  assert.match(fn, /renderPendingGeneration\(`edit_plan:\$\{s\.id\}`/, 'the edit-plan section must check its own pending state');
});

test('the language sheet appears before ideas, angles or a script, and never before an edit plan or research', () => {
  // writeScript, writeScriptFromBox, writeAngle and scriptFromPack all go
  // through writeScriptTo() (its own test proves that), which is where their
  // sheet is shown — checked once, here, rather than once per action.
  const writeScriptToFn = appjs.slice(appjs.indexOf('async function writeScriptTo'), appjs.indexOf('actions.generateIdeas'));
  assert.match(writeScriptToFn, /withLanguageSheet\(/);

  for (const action of ['generateIdeas', 'findAngles', 'anglesFromPack']) {
    const start = appjs.indexOf(`actions.${action} =`);
    assert.ok(start > 0, `actions.${action} is not defined`);
    const body = appjs.slice(start, appjs.indexOf('\n};', start));
    assert.match(body, /withLanguageSheet\(/, `actions.${action} must show the language sheet first`);
  }
  // Neither of these has a language of its own to ask about.
  const editPlanLine = appjs.slice(appjs.indexOf('actions.makeEditPlan ='), appjs.indexOf('actions.makeEditPlan =') + 200);
  assert.ok(!/withLanguageSheet/.test(editPlanLine), 'an edit plan always uses the script\'s own language');
  const researchFns = appjs.slice(appjs.indexOf('async function runResearch'), appjs.indexOf('actions.researchPack ='));
  assert.ok(!/withLanguageSheet/.test(researchFns), 'research has no language of its own');
});

test('a cancelled language sheet means nothing is written', () => {
  const fn = appjs.slice(appjs.indexOf('async function withLanguageSheet'), appjs.indexOf('// ---------- a generation'));
  assert.match(fn, /if \(!chosen\) return null;/, 'cancelling the sheet must propagate as null, not an empty choice');
  const writeScriptToFn = appjs.slice(appjs.indexOf('async function writeScriptTo'), appjs.indexOf('actions.generateIdeas'));
  assert.match(writeScriptToFn, /if \(!sheet\) return;/, 'a null sheet must stop before anything navigates or writes');
});

test('the script\'s language is shown as a tag on its own screen', () => {
  const fn = appjs.slice(appjs.indexOf('async function renderScriptDetail'), appjs.indexOf('function renderDemo'));
  assert.match(fn, /s\.language \? `<span class="badge accent">\$\{esc\(s\.language\)\}<\/span>` : ''/);
});

test('a transfer survives moving between screens', () => {
  // render() replaces #view wholesale. A progress panel inside it would be
  // destroyed by tapping Radar half way through a half-hour transfer.
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<div id="transfer"/, 'the panel needs to live outside #view');
  const view = html.indexOf('id="view"');
  const panel = html.indexOf('id="transfer"');
  assert.ok(view !== -1 && panel > view, 'the panel must be a sibling of the view, not inside it');
  assert.ok(!/<div id="transfer"[\s\S]*?<\/main>/.test(html));
  // And it draws itself rather than being drawn by a route.
  assert.match(appjs, /function drawTransfer/);
  assert.ok(!/routes = \{[^}]*transfer/.test(appjs), 'a transfer is not a screen you can navigate away from');
});

test('stopping a transfer is a flag both ends poll, so it is never ignored', () => {
  // A receiver only acts on an incoming message, so with a sender that has gone
  // quiet there is no other moment at which Stop could be noticed.
  assert.match(appjs, /cancelled: \(\) => transfer\.cancelled/);
  const transferjs = fs.readFileSync(path.join(PUBLIC, 'transfer.js'), 'utf8');
  assert.match(transferjs, /function watchForStop/);
  assert.match(transferjs, /receiver\.stop\(/, 'stopping must abort the sink, not just stop reading');
  // Both phases: waiting to connect is the one most likely to be stopped.
  assert.match(transferjs, /offering: true, cancelled/);
  assert.match(transferjs, /offering: false, cancelled/);
});

test('the digest is never computed by the browser file, only used by it', () => {
  // Every decision a transfer makes is in shared/, which is tested in Node.
  // public/transfer.js cannot be, so anything that decides something there
  // would be untested by construction.
  const transferjs = fs.readFileSync(path.join(PUBLIC, 'transfer.js'), 'utf8');
  assert.ok(!/createSha256|sha256Of/.test(transferjs), 'hashing belongs in shared/, where it is tested');
  assert.ok(!/compareDigests/.test(transferjs), 'the comparison belongs in shared/, where it is tested');
  assert.match(transferjs, /from '\.\/shared\/transfer\.mjs'/);
  // The chunk size and the backpressure thresholds are decisions too.
  assert.ok(!/= 16 \* 1024|= 1024 \* 1024/.test(transferjs), 'the limits belong in shared/transfer.mjs');
});

test('there is no TURN server anywhere in the browser code', () => {
  // A relay would carry every byte of every video and would have to be paid
  // for. Its absence is a design decision, and the honest consequence — mobile
  // data usually will not connect — is what the failure message says.
  const transferjs = fs.readFileSync(path.join(PUBLIC, 'transfer.js'), 'utf8');
  assert.ok(!/turn:|turns:|credential/.test(transferjs + appjs));
  assert.match(transferjs, /ICE_SERVERS/, 'the STUN list comes from shared/, in one place');
});

test('a received file is streamed to disk where that is possible', () => {
  const transferjs = fs.readFileSync(path.join(PUBLIC, 'transfer.js'), 'utf8');
  const sink = transferjs.slice(transferjs.indexOf('export async function pickSink'), transferjs.indexOf('// ---------- the connection'));
  // On a desktop, each chunk goes straight to the file, so a 4 GB video needs
  // no more memory than a 4 KB one.
  assert.match(sink, /showSaveFilePicker/);
  assert.match(sink, /createWritable/);
  assert.match(sink, /writable\.abort/, 'abandoning a transfer must leave no partial file');
  // On Android there is no such API, so the pieces are collected — which is
  // exactly why the sender warns above 1 GB.
  assert.match(sink, /new Blob\(parts/);
  assert.match(sink, /kind: 'memory'/);
  assert.match(appjs, /BIG_FILE_BYTES/, 'the warning has to be shown somewhere');
});

test('every way of sending or receiving a video is reachable from a screen', () => {
  for (const action of ['sendVideo', 'sendVideoTo', 'acceptVideo', 'declineVideo', 'cancelVideo', 'closeTransfer']) {
    assert.ok(appjs.includes(`actions.${action} =`), `actions.${action} is not defined`);
    assert.ok(appjs.includes(`data-action="${action}"`), `nothing on screen calls ${action}`);
  }
  // Choosing a video must not start a transfer: the size and the warnings have
  // to be seen first.
  const chooserAt = appjs.indexOf("const video = $('#videoFile')");
  assert.ok(chooserAt > 0, 'the video file input is never wired up');
  const chooser = appjs.slice(chooserAt, appjs.indexOf("const box = $('#sendBox')", chooserAt));
  assert.match(chooser, /stage = 'offering'/);
  assert.ok(!/sendTo\(/.test(chooser), 'picking a file must not begin sending');
});

test('every way of asking the AI is reachable from a screen', () => {
  // These are the buttons the whole vr-generate function exists for. A missing
  // one is a feature that silently is not there.
  const wanted = {
    generateIdeas: 'renderIdeas',
    writeScript: 'renderIdeas',
    writeScriptFromBox: 'renderScripts',
    makeEditPlan: 'renderEditPlan',
  };
  for (const [action, screen] of Object.entries(wanted)) {
    assert.ok(appjs.includes(`actions.${action} =`), `actions.${action} is not defined`);
    assert.ok(appjs.includes(`data-action="${action}"`), `nothing on screen calls ${action}`);
    assert.ok(appjs.includes(`function ${screen}`), `${screen} is missing`);
  }
  // Write script also hangs off a trend, which is the point of having a radar.
  const radar = appjs.slice(appjs.indexOf('async function renderRadar'), appjs.indexOf('actions.radarSource'));
  assert.match(radar, /data-action="writeScript"/, 'a trend should be turnable into a script');
});

test('a slow AI call says what it is doing and roughly how long', () => {
  // Forty seconds of a dead-looking button reads as broken.
  const block = appjs.slice(appjs.indexOf('const GENERATING'), appjs.indexOf('actions.generateIdeas'));
  for (const kind of ['ideas', 'script', 'edit_plan']) {
    assert.match(block, new RegExp(`${kind}:`), `no loading text for ${kind}`);
  }
  assert.match(block, /up to \d+ sec/, 'say roughly how long, so waiting feels finite');
  assert.match(block, /spin/, 'and show something moving');
  assert.match(block, /btn\.disabled = true/, 'a second click would start a second call');
  // On failure the button has to come back, or the screen is stuck.
  assert.match(block, /btn\.disabled = false/);
});
