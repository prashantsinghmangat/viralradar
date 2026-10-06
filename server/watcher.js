// Watches WATCH_DIR for viralradar-*.json, imports them, then moves them aside.
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { importExport } = require('./importer');
const { broadcast } = require('./events');

const PATTERN = /^viralradar-.*\.json$/i;
const IMPORTED = 'viralradar-imported';
const FAILED = 'viralradar-failed';

function uniqueTarget(dir, name) {
  let target = path.join(dir, name);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${base}.${stamp}${ext}`);
}

function moveTo(file, subdir) {
  const dir = path.join(path.dirname(file), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const target = uniqueTarget(dir, path.basename(file));
  try {
    fs.renameSync(file, target);
  } catch {
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
  }
  return target;
}

function processFile(db, file) {
  const name = path.basename(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`[watcher] could not read ${name}: ${e.message}`);
    return;
  }
  try {
    const result = importExport(db, text, { method: 'folder', filename: name });
    moveTo(file, IMPORTED);
    console.log(`[watcher] ${name}: ${result.message}`);
    broadcast('import', { ok: true, message: result.message, type: result.type, filename: name });
  } catch (e) {
    try {
      const target = moveTo(file, FAILED);
      fs.writeFileSync(`${target}.error.txt`, `${new Date().toISOString()}\n${name}\n\n${e.message}\n`);
    } catch (moveErr) {
      console.warn(`[watcher] could not move ${name} to ${FAILED}: ${moveErr.message}`);
    }
    console.warn(`[watcher] ${name} failed: ${e.message}`);
    broadcast('import', { ok: false, message: `${name}: ${e.message}`, filename: name });
  }
}

function createWatcher(db) {
  let watcher = null;
  let currentDir = null;

  async function start(dir) {
    await stop();
    currentDir = dir;
    if (!dir || !fs.existsSync(dir)) {
      console.warn(`[watcher] folder not found, not watching: ${dir}`);
      return false;
    }
    watcher = chokidar.watch(dir, {
      depth: 0,
      ignoreInitial: false, // also pick up exports that landed while the app was off
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
      ignored: (p, stats) => {
        const base = path.basename(p);
        if (p === dir) return false;
        if (stats && stats.isDirectory()) return true;
        return stats ? !PATTERN.test(base) : base === IMPORTED || base === FAILED;
      },
    });
    watcher.on('add', (file) => {
      if (path.dirname(file) === path.resolve(dir) && PATTERN.test(path.basename(file))) processFile(db, file);
    });
    watcher.on('error', (e) => console.warn(`[watcher] ${e.message}`));
    console.log(`[watcher] watching ${dir} for viralradar-*.json`);
    return true;
  }

  async function stop() {
    if (watcher) await watcher.close();
    watcher = null;
  }

  return { start, stop, get dir() { return currentDir; }, get active() { return !!watcher; } };
}

module.exports = { createWatcher, processFile, PATTERN };
