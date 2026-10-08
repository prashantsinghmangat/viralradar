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
  // devicesLine(), renderAngles() and ANGLES_BUTTON() are in here with the
  // other builders because they escape every value they interpolate — see the
  // tests below, which hold them to that. renderAngles in particular puts
  // model-written text on screen, so it is the one that matters most.
  const safe = /^(esc\(|fmt\(|compact\(|ago\(|when\(|copyBtn\(|hbars\(|format\(|renderEditPlan\(|PASTE_BUTTON\(|makeButton\(|devicesLine\(|renderAngles\(|ANGLES_BUTTON\(|GENERATING\[|KIND_ICON|SOURCE|LIVE_LABEL|STAGES|LENGTHS|DEFAULT_AI_ORDER)/;
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
