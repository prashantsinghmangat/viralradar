// GENERATED FILE - DO NOT EDIT.
// Copied from shared/localfolder.mjs by scripts/sync-shared.mjs.
// Edit the original and run: npm run sync:shared
// A local folder on the laptop, one per project, kept in step with what is in
// the database — the research, the script, the captions, the edit plan.
//
// WHY THIS IS NOT JUST "SAVE TO DISK"
//   ViralRadar already has a project folder in the database (shared/projects.mjs):
//   notes, links, files, a video_ref. This is a SECOND, optional mirror of part
//   of that onto a real folder the editing software can open directly — the
//   File System Access API gives a website write access to a folder a person
//   chose, which only Chrome and Edge on desktop support. Everywhere else the
//   feature does not exist, and the Settings screen says so rather than
//   pretending.
//
// WHY THERE IS A PORT HERE RATHER THAN IN THE BROWSER FILE
//   A real directory handle cannot run in Node, so nothing written next to one
//   can be tested — the same reason shared/transfer.mjs exists. Every decision
//   here — what a folder is called, what files get written, which of those are
//   safe to delete again, what a rescan should show — is written against an
//   object shaped like a FileSystemDirectoryHandle (getDirectoryHandle,
//   getFileHandle, removeEntry, an async values() iterator) rather than a real
//   one, so test/localfolder.test.js can run all of it against a fake.
//
// THE ONE RULE THAT MATTERS MOST
//   Only the files this module generates are ever overwritten or deleted by a
//   sync — a fixed, named list (research-pack.md, note-<id>.md, script.md,
//   captions.txt, edit-plan.md). Anything else a person put in the folder —
//   b-roll, a half-finished edit, a screenshot dragged in by hand — is never
//   touched. isGeneratedName() is the single gate every write and delete goes
//   through, and it is the thing test/localfolder.test.js holds to hardest.

import { readEditPlan, editPlanText } from './edit-plan.mjs';

export const SUBFOLDERS = ['01-research', '02-script', '03-raw', '04-edit', '05-final', '06-cover'];

// Windows device names, reserved regardless of extension or case.
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export const MAX_NAME_LENGTH = 120;

// How long a project's raw footage sits in 03-raw after the video is posted
// before ViralRadar even offers to delete it. Offered, never automatic — see
// rawCleanupDue() and deleteRawFiles().
export const LOCAL_RAW_RETENTION_DAYS = 30;

const str = (v) => String(v ?? '');
const trim = (v) => str(v).replace(/\s+/g, ' ').trim();

/**
 * One path segment, safe on Windows (and therefore everywhere else too).
 *
 * `\ / : * ? " < > |` cannot appear in a Windows file or folder name at all;
 * a trailing dot or space is silently stripped by the OS, which would make
 * "Idea." and "Idea" collide; and a handful of device names (CON, COM1, ...)
 * are reserved regardless of extension. None of this is optional the way it
 * would be for a URL — get it wrong and `showDirectoryPicker` itself refuses
 * the write.
 */
export function sanitizeFolderName(name) {
  let out = trim(name)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.+$/, '')
    .trim();
  if (!out) out = 'Untitled';
  if (out.length > MAX_NAME_LENGTH) out = out.slice(0, MAX_NAME_LENGTH).trim();
  // A reserved name is reserved with or without an extension ("CON.md" fails
  // exactly like "CON" does), so only the part before the first dot counts.
  const head = out.split('.')[0].toUpperCase();
  if (RESERVED_NAMES.has(head)) out = `_${out}`;
  return out;
}

/**
 * The folder name for a project: "<date> <title>", sanitised as one segment.
 *
 * Computed once, when the folder is first made, and then stored on the
 * project (`local_folder_name`) rather than ever recomputed from the title —
 * see the migration. Recomputing it after a rename would make a second folder
 * next to the one that already holds the research and the script.
 */
export function projectFolderName({ title, date } = {}) {
  const day = str(date).slice(0, 10);
  const name = trim(title) || 'Untitled';
  return sanitizeFolderName(day ? `${day} ${name}` : name);
}

// ---------- content: what goes in each generated file ----------

const FACT_TAG = { verified: '[VERIFIED]', unverified: '[UNVERIFIED]', unchecked: '[NOT CHECKED]' };

/** The research pack, as Markdown rather than as the JSON it is stored as. */
export function researchPackMarkdown(pack) {
  const p = pack && typeof pack === 'object' ? pack : {};
  const tool = p.main_tool || {};
  const lines = [`# Research: ${p.topic || '(untitled)'}`, ''];

  if (tool.name || tool.url) {
    lines.push(`## ${tool.name || 'The tool'}`);
    if (tool.url) lines.push(tool.url);
    if (tool.what_it_does) lines.push('', tool.what_it_does);
    if (tool.how_it_works_simple) lines.push('', tool.how_it_works_simple);
    const free = tool.free_details || {};
    for (const [label, value] of [
      ['Signup', free.signup], ['Watermark', free.watermark],
      ['Free limits', free.limits], ['Export quality', free.export_quality],
    ]) {
      if (value) lines.push(`- **${label}:** ${value}`);
    }
    lines.push('');
  }

  const section = (title, items) => {
    if (!items || !items.length) return;
    lines.push(`## ${title}`, ...items.map((x) => `- ${x}`), '');
  };
  section('Steps', tool.steps);
  section('Prompts to try', tool.prompts);
  section('Best inputs for a good demo', tool.best_inputs);
  section('Settings worth changing', tool.settings);

  if ((p.alternatives || []).length) {
    lines.push('## Alternatives', ...p.alternatives.map((a) => `- **${a.name}** — ${a.one_line}${a.url ? ` (${a.url})` : ''}`), '');
  }

  if ((p.fact_check || []).length) {
    lines.push('## Fact check');
    for (const f of p.fact_check) {
      lines.push(`- ${FACT_TAG[f.status] || FACT_TAG.unchecked} ${f.claim}${f.source_url ? ` — ${f.source_url}` : ''}`);
    }
    lines.push('');
  }

  section('How to prove it on camera', p.test_plan);
  section('Before you record', p.recording_checklist);

  if ((p.sources || []).length) lines.push('## Sources', ...p.sources.map((s) => `- ${s}`), '');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** A stable name for a note's own file, so editing it overwrites rather than duplicates. */
export const noteFileName = (item) => `note-${str(item?.id)}.md`;

/** A text note, or a saved link, as a small Markdown file. */
export function noteMarkdown(item) {
  const i = item || {};
  const when = str(i.created_at).slice(0, 10);
  const head = [when, i.from_device && `from ${i.from_device}`].filter(Boolean).join(' · ');
  const body = i.kind === 'link' ? `<${str(i.content)}>` : str(i.content);
  return [`# Note`, head ? `_${head}_` : '', '', body].filter((l) => l !== '').join('\n') + '\n';
}

/** The shooting script: every beat, with its timecode. */
export function scriptMarkdown(script) {
  const s = script || {};
  const beats = Array.isArray(s.beats) ? s.beats : [];
  const lines = [`# ${s.title || s.yt_title || s.topic || 'Script'}`, ''];
  if (s.topic) lines.push(`Topic: ${s.topic}`, '');
  for (const b of beats) {
    lines.push(`## ${b.t || '—'}`, b.say || '', ...(b.screen ? [`🎥 ${b.screen}`] : []), '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Everything a caption box needs to be pasted straight in, platform by platform. */
export function captionsText(script) {
  const s = script || {};
  const tags = (s.hashtags || []).map((t) => (String(t).startsWith('#') ? t : `#${t}`)).join(' ');
  const parts = [
    ['Thumbnail text', s.thumbnail_text],
    ['YouTube title', s.yt_title],
    ['Instagram caption', s.ig_caption],
    ['Facebook caption', s.fb_caption],
    ['Hashtags', tags],
    ['Pinned comment', s.pinned_comment],
  ].filter(([, v]) => v);
  return parts.map(([label, value]) => `${label}:\n${value}`).join('\n\n') + '\n';
}

/** The edit plan, in the same plain text the teleprompter screen already shows. */
export function editPlanFileText(script) {
  return editPlanText(readEditPlan(script));
}

// ---------- which files should exist right now ----------

/**
 * Every file the sync should currently write, grouped by subfolder.
 *
 * Pure: given the project's own data, says what the folder OUGHT to look
 * like. Nothing here touches a filesystem — see syncGeneratedFiles() for the
 * side-effecting half, which is this list reconciled against what is really
 * there.
 */
export function wantedFiles({ items = [], script = null } = {}) {
  const files = [];

  const research = items.filter((i) => i.kind === 'research')
    .slice().sort((a, b) => str(a.created_at).localeCompare(str(b.created_at)));
  research.forEach((item, i) => {
    let pack;
    try { pack = JSON.parse(item.content || '{}'); } catch { pack = {}; }
    const last = i === research.length - 1;
    const name = last ? 'research-pack.md' : `research-pack-${i + 1}.md`;
    files.push({ subfolder: '01-research', name, content: researchPackMarkdown(pack) });
  });

  for (const item of items) {
    if (item.kind !== 'text' && item.kind !== 'link') continue;
    files.push({ subfolder: '01-research', name: noteFileName(item), content: noteMarkdown(item) });
  }

  if (script) {
    files.push({ subfolder: '02-script', name: 'script.md', content: scriptMarkdown(script) });
    files.push({ subfolder: '02-script', name: 'captions.txt', content: captionsText(script) });
    const plan = editPlanFileText(script);
    if (plan) files.push({ subfolder: '04-edit', name: 'edit-plan.md', content: plan });
  }

  return files;
}

/**
 * Is this name one the sync itself would ever write? The gate every write and
 * delete goes through — see the module comment. 03-raw, 05-final and 06-cover
 * are never auto-managed at all: nothing in them ever matches, so a sync can
 * never remove so much as one byte of actual footage.
 */
export function isGeneratedName(subfolder, name) {
  if (subfolder === '01-research') return name === 'research-pack.md' || /^research-pack-\d+\.md$/.test(name) || /^note-.+\.md$/.test(name);
  if (subfolder === '02-script') return name === 'script.md' || name === 'captions.txt';
  if (subfolder === '04-edit') return name === 'edit-plan.md';
  return false;
}

/**
 * What a sync should write and delete in one subfolder, given what is
 * currently there and what is wanted.
 *
 * `existingNames` is every name the sync CAN see — including files it did not
 * write — and `isGeneratedName` is what keeps those out of `toDelete`: a name
 * already in `wanted` is always written (there is no skip-if-unchanged; a
 * generated file is cheap to rewrite and "did it change" is itself a question
 * worth not having to answer), and a name that looks generated but is no
 * longer wanted (a note that was deleted, say) is removed. Nothing else in
 * `existingNames` is ever mentioned in the result.
 */
export function diffGeneratedFiles({ subfolder, existingNames = [], wanted = [] }) {
  const wantedNames = new Set(wanted.map((f) => f.name));
  const toDelete = existingNames.filter((name) => isGeneratedName(subfolder, name) && !wantedNames.has(name));
  return { toWrite: wanted, toDelete };
}

// ---------- the checklist ----------

/**
 * Turn a raw folder scan into the ✓/✗ checklist the Projects screen shows.
 *
 * `scan` is `{ research, script, editPlan, raw: { count, bytes }, final, cover }`
 * — see scanProject() for how it is read off a real folder. Kept separate
 * from the reading so the decision ("offer to move to Edited") is testable
 * without a directory handle at all.
 */
export function projectChecklist(scan = {}, { scriptStage = null } = {}) {
  const raw = scan.raw || { count: 0, bytes: 0 };
  return {
    research: !!scan.research,
    script: !!scan.script,
    editPlan: !!scan.editPlan,
    raw: { count: raw.count || 0, bytes: raw.bytes || 0 },
    final: !!scan.final,
    cover: !!scan.cover,
    // Worth asking, not worth doing by itself: a finished edit sitting in
    // 05-final is the one signal that moving the script to "Edited" is true
    // rather than merely allowed.
    offerMoveToEdited: !!scan.final && scriptStage !== 'edited' && scriptStage !== 'posted',
  };
}

/** 30 days after a project was marked posted, and not a day before. */
export function rawCleanupDue(project, today = new Date()) {
  const p = project || {};
  if (p.status !== 'posted' || !p.posted_at) return false;
  const postedAt = new Date(p.posted_at);
  if (Number.isNaN(postedAt.getTime())) return false;
  const days = (today.getTime() - postedAt.getTime()) / 86400000;
  return days >= LOCAL_RAW_RETENTION_DAYS;
}

// ---------- the directory port ----------
//
// Every function below takes a handle shaped like a real FileSystemDirectoryHandle
// (or FileSystemFileHandle) — getDirectoryHandle(name, {create}),
// getFileHandle(name, {create}), removeEntry(name, {recursive}), an async
// values() iterator, and on a file handle getFile()/createWritable(). That
// shape is what test/localfolder.test.js fakes; the real API needs no adapter
// at all, which is the whole point of writing to the shape rather than to the
// class.

// values() is the real FileSystemDirectoryHandle API, and what the fakes in
// the tests implement too: an async iterator yielding handles with .kind and
// .name, and — for a file handle — .getFile().
async function listNames(dirHandle) {
  const out = [];
  if (!dirHandle) return out;
  for await (const handle of dirHandle.values()) out.push(handle);
  return out;
}

/** A subfolder handle, or null if it is not there — never created by reading. */
async function openSubfolder(root, folderName, subfolder) {
  try {
    const project = await root.getDirectoryHandle(folderName, { create: false });
    return await project.getDirectoryHandle(subfolder, { create: false });
  } catch {
    return null;
  }
}

/** The project's folder, with all six subfolders present, making anything missing. */
export async function ensureProjectFolder(root, folderName) {
  const project = await root.getDirectoryHandle(folderName, { create: true });
  for (const sub of SUBFOLDERS) await project.getDirectoryHandle(sub, { create: true });
  return project;
}

/** Write (or overwrite) one file's whole content. */
async function writeWhole(dirHandle, name, content) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Bring the folder's generated files into step with `files` (wantedFiles()'s
 * output), one subfolder at a time. Only ever writes or deletes a name
 * isGeneratedName() allows — see diffGeneratedFiles().
 */
export async function syncGeneratedFiles(root, folderName, files) {
  const project = await ensureProjectFolder(root, folderName);
  const bySubfolder = new Map();
  for (const f of files) {
    if (!bySubfolder.has(f.subfolder)) bySubfolder.set(f.subfolder, []);
    bySubfolder.get(f.subfolder).push(f);
  }
  // Every subfolder isGeneratedName() knows about, not only ones with
  // something wanted right now — a subfolder that lost its last note still
  // needs that note's file removed.
  const subfolders = new Set([...bySubfolder.keys(), '01-research', '02-script', '04-edit']);

  for (const sub of subfolders) {
    const dir = await project.getDirectoryHandle(sub, { create: true });
    const existing = await listNames(dir);
    const existingNames = existing.filter((h) => h.kind === 'file').map((h) => h.name);
    const { toWrite, toDelete } = diffGeneratedFiles({ subfolder: sub, existingNames, wanted: bySubfolder.get(sub) || [] });
    for (const file of toWrite) await writeWhole(dir, file.name, file.content);
    for (const name of toDelete) await dir.removeEntry(name).catch(() => {});
  }
}

/** The raw facts a checklist is built from — see projectChecklist(). */
export async function scanProject(root, folderName) {
  const research = await openSubfolder(root, folderName, '01-research');
  const script = await openSubfolder(root, folderName, '02-script');
  const editPlan = await openSubfolder(root, folderName, '04-edit');
  const raw = await openSubfolder(root, folderName, '03-raw');
  const final = await openSubfolder(root, folderName, '05-final');
  const cover = await openSubfolder(root, folderName, '06-cover');

  const fileNames = async (dir) => (await listNames(dir)).filter((h) => h.kind === 'file');
  const anyFile = async (dir) => (await fileNames(dir)).length > 0;

  const rawFiles = await fileNames(raw);
  let rawBytes = 0;
  for (const h of rawFiles) rawBytes += (await h.getFile()).size;

  return {
    research: (await fileNames(research)).some((h) => isGeneratedName('01-research', h.name) && h.name.startsWith('research-pack')),
    script: (await fileNames(script)).some((h) => h.name === 'script.md'),
    editPlan: (await fileNames(editPlan)).some((h) => h.name === 'edit-plan.md'),
    raw: { count: rawFiles.length, bytes: rawBytes },
    final: await anyFile(final),
    cover: await anyFile(cover),
  };
}

/**
 * The sink port shared/transfer.mjs's createReceiver() expects, writing
 * straight into this project's 03-raw instead of asking for a save location.
 * Same shape public/transfer.js's pickSink() returns, so the caller cannot
 * tell the two apart.
 */
export function rawSink(root, folderName, suggestedName) {
  let writable = null;
  let fileName = suggestedName;
  return {
    kind: 'disk',
    async open(meta) {
      fileName = (meta && meta.name) || suggestedName;
      const project = await ensureProjectFolder(root, folderName);
      const dir = await project.getDirectoryHandle('03-raw', { create: true });
      const fh = await dir.getFileHandle(fileName, { create: true });
      writable = await fh.createWritable();
    },
    write: (chunk) => writable.write(chunk),
    async close() {
      await writable.close();
      return fileName;
    },
    async abort() {
      if (writable) await writable.abort().catch(() => {});
      writable = null;
    },
  };
}

/** Delete everything in 03-raw. Never 05-final — this is the only subfolder this function ever opens. */
export async function deleteRawFiles(root, folderName) {
  const dir = await openSubfolder(root, folderName, '03-raw');
  const files = (await listNames(dir)).filter((h) => h.kind === 'file');
  let bytes = 0;
  for (const h of files) {
    bytes += (await h.getFile()).size;
    await dir.removeEntry(h.name).catch(() => {});
  }
  return { count: files.length, bytes };
}

// ---------- permission ----------
//
// Thin wrappers, kept here rather than inline in public/localfolder.js only so
// a fake handle can be used in the same tests as everything else above.

export const checkPermission = (handle) => handle.queryPermission({ mode: 'readwrite' });
export const requestPermission = (handle) => handle.requestPermission({ mode: 'readwrite' });
