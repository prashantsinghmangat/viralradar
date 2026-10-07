// Copies shared/*.mjs to the two places that cannot reach the repository root.
//
//   supabase/functions/_shared/core/   a deployed Edge Function only receives
//                                      files under supabase/functions/
//   public/shared/                     the browser fetches files by URL, and
//                                      there is no bundler to resolve anything
//                                      outside the site root
//
// Rather than hope a bundler reaches outside those folders, the modules are
// copied in, and test/functions-sync.test.js fails if a copy drifts. So there
// is still one source of truth — shared/ — and the copies are generated, never
// edited.
//
//   npm run sync:shared              update the copies
//   npm run sync:shared -- --check   report drift without writing
//
// Only self-contained modules can go to the browser: it fetches them exactly as
// they are, so a relative import inside one would 404 at runtime.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_DIR = join(ROOT, 'shared');
export const TARGET_DIR = join(ROOT, 'supabase', 'functions', '_shared', 'core');
export const BROWSER_DIR = join(ROOT, 'public', 'shared');

// What the browser needs:
//   stats     the Results screen's numbers, worked out in the browser
//   defaults  the same lists the database and the functions use
//   time      "today" in IST, so a day means the same thing everywhere
//   tokens    an import token is made and hashed in the browser, so the token
//             itself never travels anywhere it does not have to
export const BROWSER_SHARED = ['stats.mjs', 'defaults.mjs', 'time.mjs', 'tokens.mjs'];

const BANNER = [
  '// GENERATED FILE - DO NOT EDIT.',
  '// Copied from shared/SOURCE by scripts/sync-shared.mjs.',
  '// Edit the original and run: npm run sync:shared',
  '',
].join('\n');

// Git rewrites line endings on checkout on Windows, so a copy that is perfectly
// in sync can still differ byte for byte from what was written. Compare the
// text, not the line endings.
const sameText = (a, b) => a.split(String.fromCharCode(13)).join('') === b.split(String.fromCharCode(13)).join('');

/** Every .mjs under a directory, as relative paths like "sources/youtube.mjs". */
export function sharedFiles(dir = SOURCE_DIR, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sharedFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.mjs')) out.push(prefix + entry.name);
  }
  return out.sort();
}

export const expectedContent = (relative) =>
  BANNER.replace('SOURCE', relative) + readFileSync(join(SOURCE_DIR, relative), 'utf8');

/** The two copies, and which files belong in each. */
export const targets = () => [
  { dir: TARGET_DIR, files: sharedFiles(), label: 'supabase/functions/_shared/core' },
  { dir: BROWSER_DIR, files: BROWSER_SHARED, label: 'public/shared' },
];

/** Files that are missing, out of date, or no longer belong. */
export function drift() {
  const stale = [];
  for (const { dir, files, label } of targets()) {
    for (const relative of files) {
      const target = join(dir, relative);
      if (!existsSync(target) || !sameText(readFileSync(target, 'utf8'), expectedContent(relative))) {
        stale.push(`${label}/${relative}`);
      }
    }
    const wanted = new Set(files);
    for (const relative of sharedFiles(dir)) {
      if (!wanted.has(relative)) stale.push(`${label}/${relative} (should not be there)`);
    }
  }
  return stale;
}

export function sync() {
  const written = [];
  for (const { dir, files, label } of targets()) {
    for (const relative of files) {
      const target = join(dir, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, expectedContent(relative));
      written.push(`${label}/${relative}`);
    }
    const wanted = new Set(files);
    for (const relative of sharedFiles(dir)) {
      if (!wanted.has(relative)) rmSync(join(dir, relative));
    }
  }
  return written;
}

if (process.argv[1] && process.argv[1].endsWith('sync-shared.mjs')) {
  if (process.argv.includes('--check')) {
    const stale = drift();
    if (stale.length) {
      console.error(`The copies are out of date:\n  ${stale.join('\n  ')}\n\nRun: npm run sync:shared`);
      process.exit(1);
    }
    console.log('In sync.');
  } else {
    const written = sync();
    console.log(`Copied ${written.length} file(s):`);
    for (const f of written) console.log(`  ${f}`);
  }
}
