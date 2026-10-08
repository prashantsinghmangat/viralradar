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
  const safe = /^(esc\(|fmt\(|compact\(|ago\(|when\(|copyBtn\(|hbars\(|format\(|renderEditPlan\(|PASTE_BUTTON\(|makeButton\(|GENERATING\[|KIND_ICON|SOURCE|LIVE_LABEL|STAGES|LENGTHS|DEFAULT_AI_ORDER)/;
  const bad = [];
  for (const literal of htmlLiterals) {
    for (const m of literal.matchAll(/\$\{([^{}]*)\}/g)) {
      const expr = m[1].trim();
      if (!expr || safe.test(expr)) continue;
      // Nested templates, conditionals and loops are assembled from pieces that
      // are themselves checked; numbers and booleans cannot inject markup.
      if (/\?|&&|\|\||\.map\(|\.join\(|\.filter\(|\.length|\.toFixed|\.slice|\+ 1|=== |!== |^\d/.test(expr)) continue;
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
