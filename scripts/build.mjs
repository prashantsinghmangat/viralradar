// Builds the static site Netlify serves.
//
//   npm run build        -> dist/
//
// There is no bundler and no framework. The build does three things:
//   1. copies public/ to dist/
//   2. writes dist/env.js, which is the only place the Supabase address and
//      publishable key appear — injected at build time from the environment,
//      never committed
//   3. vendors the supabase-js browser bundle from node_modules, so the page
//      loads nothing from a CDN and keeps working offline as a PWA
//
// It refuses to build without the two environment variables, because a site
// that builds fine and then cannot reach its database is a much worse failure
// than one that does not build.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const OUT_DIR = join(ROOT, 'dist');
const SUPABASE_UMD = join(ROOT, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');

// The browser also needs a few modules from shared/. They are kept in
// public/shared/ by scripts/sync-shared.mjs, so copying public/ brings them
// along and there is nothing extra to do here.
export { BROWSER_SHARED } from './sync-shared.mjs';

// Values that must never reach the browser, whatever happens.
const FORBIDDEN_ENV = ['SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'YOUTUBE_API_KEY'];

/**
 * The role a Supabase key claims, or null if it is not a JWT.
 *
 * This matters because a real service_role key does not contain the words
 * "service_role" anywhere you can see: the role sits in the middle section of
 * the JWT, base64-encoded. Checking the raw text would miss exactly the key it
 * is supposed to catch.
 */
export function keyRole(key) {
  const parts = String(key ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

export function readConfig(env = process.env) {
  const url = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const anonKey = (env.SUPABASE_ANON_KEY ?? '').trim();
  const problems = [];

  if (!url) problems.push('SUPABASE_URL is not set.');
  else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) {
    problems.push(`SUPABASE_URL does not look right: ${url}\n  Expected something like https://abcdefghijkl.supabase.co`);
  }

  if (!anonKey) problems.push('SUPABASE_ANON_KEY is not set.');
  else if (anonKey.length < 40) problems.push('SUPABASE_ANON_KEY looks too short to be a real key.');
  // The service role key is a JWT whose payload says "service_role". Shipping
  // one would hand every visitor full access, so refuse outright.
  else if (keyRole(anonKey) === 'service_role' || /service_role/.test(anonKey) || /^sb_secret_/.test(anonKey)) {
    problems.push('SUPABASE_ANON_KEY looks like the SECRET / service_role key.\n'
      + '  That key bypasses every security rule and must never be in a browser.\n'
      + '  Use the publishable key (older projects call it "anon public").');
  }

  return { url, anonKey, problems };
}

/**
 * Ask the project whether it actually accepts this key.
 *
 * A key can be perfectly well formed and still be refused — most commonly when
 * a project has the legacy anon/service_role keys switched off and is handed
 * one anyway. That failure otherwise shows up much later, as "Legacy API keys
 * are disabled" on the sign-in screen, which is a long way from the cause.
 *
 * Returns { ok, problem }. A network failure is not a problem: an offline build
 * should still produce a site.
 */
export async function verifyKey(url, key, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(`${url}/auth/v1/health`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch {
    return { ok: true, problem: null, checked: false }; // no network; carry on
  }

  if (response.status !== 401 && response.status !== 403) return { ok: true, problem: null, checked: true };

  let hint = '';
  try {
    const body = await response.json();
    hint = body.hint || body.message || body.msg || '';
  } catch { /* no body to read */ }

  if (/legacy api keys/i.test(hint)) {
    return {
      ok: false,
      checked: true,
      problem: 'This project has the legacy API keys switched off, and SUPABASE_ANON_KEY is a legacy one.\n'
        + '  Use the new publishable key instead: Supabase -> Project Settings -> API Keys ->\n'
        + '  the key beginning sb_publishable_. Update it in Netlify and in .env, then deploy again.',
    };
  }
  return {
    ok: false,
    checked: true,
    problem: `The project refused SUPABASE_ANON_KEY (HTTP ${response.status}).${hint ? `\n  ${hint}` : ''}\n`
      + '  Check you copied the publishable key for this project.',
  };
}

/** The contents of dist/env.js. The only generated file carrying configuration. */
export function envScript({ url, anonKey }, builtAt) {
  return `// Generated at build time by scripts/build.mjs. Do not edit, do not commit.
// These two values are meant to be public: Row Level Security is what protects
// the data, not the key. The secret key is never here.
window.__VR_ENV = Object.freeze(${JSON.stringify({ SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, BUILT_AT: builtAt }, null, 2)});
`;
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    else out.push(prefix + entry.name);
  }
  return out;
}

export async function build({ env = process.env, builtAt = new Date().toISOString(), check = true } = {}) {
  const config = readConfig(env);
  if (config.problems.length) {
    const where = env.NETLIFY
      ? 'Netlify: Site configuration -> Environment variables'
      : 'your .env file';
    throw new Error(`Cannot build the site.\n\n  ${config.problems.join('\n  ')}\n\nSet them in ${where}.\n`);
  }

  if (!existsSync(SUPABASE_UMD)) {
    throw new Error(`The supabase-js browser bundle is missing:\n  ${SUPABASE_UMD}\nRun npm install first.`);
  }

  // Ask the project whether it actually accepts this key, so one it refuses
  // fails here rather than on the sign-in screen. Set VR_SKIP_KEY_CHECK=1 to
  // build without asking.
  if (check && env.VR_SKIP_KEY_CHECK !== '1') {
    const verdict = await verifyKey(config.url, config.anonKey);
    if (!verdict.ok) throw new Error(`Cannot build the site.\n\n  ${verdict.problem}\n`);
  }

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // public/package.json only exists to tell Node that these files are ES
  // modules, so the tests can import them. The browser has no use for it.
  cpSync(PUBLIC_DIR, OUT_DIR, { recursive: true, filter: (src) => !src.endsWith(`${sep}package.json`) });

  mkdirSync(join(OUT_DIR, 'vendor'), { recursive: true });
  cpSync(SUPABASE_UMD, join(OUT_DIR, 'vendor', 'supabase.js'));


  writeFileSync(join(OUT_DIR, 'env.js'), envScript(config, builtAt));

  // Last line of defence: nothing secret may be in the output, whatever the
  // environment happened to contain.
  const leaked = [];
  for (const name of FORBIDDEN_ENV) {
    const value = (env[name] ?? '').trim();
    if (value.length < 8) continue;
    for (const file of listFiles(OUT_DIR)) {
      if (readFileSync(join(OUT_DIR, file), 'utf8').includes(value)) leaked.push(`${name} appears in dist/${file}`);
    }
  }
  if (leaked.length) {
    rmSync(OUT_DIR, { recursive: true, force: true });
    throw new Error(`Refusing to publish: a secret ended up in the build.\n  ${leaked.join('\n  ')}`);
  }

  const files = listFiles(OUT_DIR);
  const bytes = files.reduce((n, f) => n + statSync(join(OUT_DIR, f)).size, 0);
  return { files, bytes, builtAt, url: config.url };
}

if (process.argv[1] && process.argv[1].endsWith('build.mjs')) {
  // Load .env for local builds. On Netlify the variables are already set.
  if (!process.env.NETLIFY) {
    try { (await import('dotenv')).config({ quiet: true }); } catch { /* fine without it */ }
  }
  try {
    const { files, bytes, url } = await build();
    console.log(`Built dist/ — ${files.length} files, ${Math.round(bytes / 1024)} KB`);
    console.log(`  Supabase: ${url}`);
    for (const f of files) console.log(`  ${f}`);
  } catch (e) {
    console.error(`\n${e.message}`);
    // exitCode rather than exit(), so an in-flight request can finish closing
    // instead of tripping an assertion on the way out.
    process.exitCode = 1;
  }
}
