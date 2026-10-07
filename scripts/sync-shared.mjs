// Copies shared/*.mjs into supabase/functions/_shared/core/.
//
// Why a copy exists at all: a deployed Edge Function only gets the files under
// supabase/functions/, so it cannot import shared/ at the repository root.
// Rather than hope the bundler reaches outside that folder, the modules are
// copied in, and test/functions-sync.test.js fails if the copy ever drifts from
// the original. So there is still one source of truth — shared/ — and the copy
// is generated, never edited.
//
//   npm run sync:shared          update the copy
//   npm run sync:shared -- --check   report drift without writing (used by the tests)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_DIR = join(ROOT, 'shared');
export const TARGET_DIR = join(ROOT, 'supabase', 'functions', '_shared', 'core');

const BANNER = [
  '// GENERATED FILE - DO NOT EDIT.',
  '// Copied from shared/SOURCE by scripts/sync-shared.mjs.',
  '// Edit the original and run: npm run sync:shared',
  '',
].join('\n');

/** Every .mjs under shared/, as repo-relative paths like "sources/youtube.mjs". */
export function sharedFiles(dir = SOURCE_DIR, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sharedFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.mjs')) out.push(prefix + entry.name);
  }
  return out.sort();
}

export const expectedContent = (relative) =>
  BANNER.replace('SOURCE', relative) + readFileSync(join(SOURCE_DIR, relative), 'utf8');

/** Returns the list of files that are missing or out of date. */
export function drift() {
  const stale = [];
  for (const relative of sharedFiles()) {
    const target = join(TARGET_DIR, relative);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== expectedContent(relative)) stale.push(relative);
  }
  // Anything in the copy that no longer exists in shared/ is also drift.
  if (existsSync(TARGET_DIR)) {
    const wanted = new Set(sharedFiles());
    for (const relative of sharedFiles(TARGET_DIR)) {
      if (!wanted.has(relative)) stale.push(`${relative} (no longer in shared/)`);
    }
  }
  return stale;
}

export function sync() {
  const written = [];
  for (const relative of sharedFiles()) {
    const target = join(TARGET_DIR, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, expectedContent(relative));
    written.push(relative);
  }
  // Remove copies of files that have been deleted from shared/.
  if (existsSync(TARGET_DIR)) {
    const wanted = new Set(sharedFiles());
    for (const relative of sharedFiles(TARGET_DIR)) {
      if (!wanted.has(relative)) rmSync(join(TARGET_DIR, relative));
    }
  }
  return written;
}

if (process.argv[1] && process.argv[1].endsWith('sync-shared.mjs')) {
  if (process.argv.includes('--check')) {
    const stale = drift();
    if (stale.length) {
      console.error(`supabase/functions/_shared/core is out of date:\n  ${stale.join('\n  ')}\n\nRun: npm run sync:shared`);
      process.exit(1);
    }
    console.log(`In sync: ${sharedFiles().length} file(s).`);
  } else {
    const written = sync();
    console.log(`Copied ${written.length} file(s) into supabase/functions/_shared/core/:`);
    for (const f of written) console.log(`  ${f}`);
  }
}
