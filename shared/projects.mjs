// Project folders: one folder per video, and the rules about what may go in one.
//
// Everything in here is a decision that has to come out the same in three
// places — the browser that uploads, the database that stores, and the Edge
// Function that cleans up — so it lives in one module rather than being
// restated. Nothing here touches the network or the DOM, so it can all be
// tested in Node.
//
// THE TWO LIMITS, AND WHY THEY EXIST
//   This Supabase project is shared with another app ("tracebug") and the free
//   tier gives the whole project about 1 GB of file storage. ViralRadar is a
//   guest there, so it takes a fixed slice and never more:
//
//     MAX_FILE_BYTES    25 MB   one file, so a stray 4K export cannot fill the
//                               project in a single upload
//     TOTAL_BYTES_CAP  300 MB   everything ViralRadar holds, so tracebug always
//                               has most of the quota left
//
//   Raw videos are NEVER uploaded. They are far bigger than either limit, and
//   Part 2 sends them device to device instead. A video only ever appears here
//   as a note saying it exists.

export const PROJECT_STATUS = ['active', 'posted', 'archived'];
export const ITEM_KINDS = ['text', 'link', 'image', 'file'];

/** The folder every share and every stray note lands in. One per user. */
export const INBOX_TITLE = 'Inbox';

export const BUCKET = 'vr-project-files';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 26214400
export const TOTAL_BYTES_CAP = 300 * 1024 * 1024; // 314572800

/**
 * How long a file survives once its project is marked "posted".
 *
 * The video is up; the screenshots and the thumbnail draft are no longer worth
 * a slice of a shared quota. Two weeks is long enough to notice a mistake and
 * re-post, which is the only reason you would want them back.
 */
export const POSTED_RETENTION_DAYS = 14;

/** Bytes, for a person. Deliberately short: these go in folder cards. */
export function formatBytes(n) {
  // A note has no size at all, and "0 B" would read as an empty file rather
  // than as a thing that is not a file.
  if (n === null || n === undefined || n === '') return '—';
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * A file name that is safe to put in a storage path.
 *
 * Storage keys are just strings, so a name carrying "../" or a slash would
 * claim a path outside the folder it was meant for. The policies would still
 * refuse anything outside the user's own prefix, but a name that cannot express
 * the attempt in the first place is better than one that is caught.
 */
export function safeFileName(name) {
  const raw = String(name ?? '').replace(/\\/g, '/');
  // Only the last segment: a browser on Android sometimes hands over a path.
  const base = raw.slice(raw.lastIndexOf('/') + 1)
    // Control characters, and the handful of characters that mean something to
    // a URL or a filesystem.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["*:<>?|#%]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot hides the file on every Unix system, and "." and ".." are
    // not names at all.
    .replace(/^\.+/, '');
  if (!base) return 'file';
  if (base.length <= 120) return base;
  // Keep the extension: it is what decides whether the file opens.
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || base.length - dot > 12) return base.slice(0, 120);
  return base.slice(0, 120 - (base.length - dot)) + base.slice(dot);
}

/**
 * Where one file lives: <user_id>/<project_id>/<stamp>-<name>.
 *
 * The user id comes first because that is what the storage policies match on,
 * and the project id second so a whole folder can be listed with one prefix.
 * The stamp is there so uploading the same screenshot twice keeps both rather
 * than silently replacing the first.
 */
export function storagePath(userId, projectId, fileName, stamp) {
  const user = String(userId ?? '').trim();
  const project = String(projectId ?? '').trim();
  if (!user || !project) throw new Error('A file needs both a user and a project to belong to.');
  const prefix = stamp === undefined ? Date.now().toString(36) : String(stamp);
  return `${user}/${project}/${prefix}-${safeFileName(fileName)}`;
}

/** Is this path inside the folder it claims to be in? The check the database also makes. */
export const pathBelongsTo = (path, userId, projectId) =>
  String(path ?? '').startsWith(`${userId}/${projectId}/`);

/** An image gets shown; anything else gets a download button. */
export function kindForFile(mime, name = '') {
  const type = String(mime ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  // A phone sometimes hands over an empty type, so fall back to the name.
  if (!type && /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|svg)$/i.test(String(name))) return 'image';
  return 'file';
}

/** Text that looks like a link gets the link treatment, and a Copy button that is worth having. */
export function kindForText(text) {
  const value = String(text ?? '').trim();
  return /^https?:\/\/\S+$/i.test(value) && !/\s/.test(value) ? 'link' : 'text';
}

/**
 * May this file be uploaded? Returns { ok, message }.
 *
 * Both limits are answered in one place so the browser can refuse before
 * spending someone's mobile data, and say which limit it was and by how much.
 * The database and the storage policies enforce the same two numbers; this is
 * the version that can explain itself.
 */
export function checkUpload({ size, usedBytes = 0, fileName = '' } = {}) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 0) return { ok: false, message: 'That file has no size, so something is wrong with it.' };
  if (bytes === 0) return { ok: false, message: 'That file is empty.' };

  const name = fileName ? `“${safeFileName(fileName)}” ` : '';
  if (bytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      message: `${name}is ${formatBytes(bytes)}. One file can be at most ${formatBytes(MAX_FILE_BYTES)}.`
        + ' Raw video is never uploaded — send it device to device instead.',
    };
  }

  const used = Math.max(0, Number(usedBytes) || 0);
  if (used + bytes > TOTAL_BYTES_CAP) {
    const free = Math.max(0, TOTAL_BYTES_CAP - used);
    return {
      ok: false,
      message: `ViralRadar is using ${formatBytes(used)} of its ${formatBytes(TOTAL_BYTES_CAP)}, so there is only ${formatBytes(free)} free`
        + ` and ${name}needs ${formatBytes(bytes)}. Mark a finished project as posted, or delete some files.`,
    };
  }
  return { ok: true, message: '' };
}

/** How full ViralRadar's slice is, for the Settings screen. */
export function usageSummary(usedBytes) {
  const used = Math.max(0, Number(usedBytes) || 0);
  const free = Math.max(0, TOTAL_BYTES_CAP - used);
  return {
    used,
    free,
    cap: TOTAL_BYTES_CAP,
    percent: Math.min(100, Math.round((used / TOTAL_BYTES_CAP) * 100)),
    full: used >= TOTAL_BYTES_CAP,
    text: `${formatBytes(used)} of ${formatBytes(TOTAL_BYTES_CAP)} used`,
  };
}

/**
 * A one-line description of an item, for the "New from Laptop: …" toast and for
 * the folder cards. Never longer than `max`, and never multi-line: both of
 * those places have one line to work with.
 */
export function itemPreview(item, max = 60) {
  const i = item || {};
  // project_items.preview is a generated column holding exactly this, so a
  // list of folders never has to read every note in full. A row that arrived
  // over Realtime, or an older one, has the whole thing instead.
  const raw = i.preview !== undefined && i.preview !== null
    ? String(i.preview)
    : (i.kind === 'text' || i.kind === 'link' ? String(i.content ?? '') : String(i.file_name ?? ''));
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return i.kind === 'image' ? 'an image' : 'a file';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * What to call this device, guessed from the user agent.
 *
 * Only ever a first suggestion: the real name is whatever is typed in Settings,
 * because "Phone" and "Laptop" are the words that actually mean something when
 * an item arrives, and no user agent knows which one you call this.
 */
export function guessDeviceName(userAgent = '') {
  const ua = String(userAgent);
  if (/\biPad\b|Tablet|\bSM-T/i.test(ua)) return 'Tablet';
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return 'Phone';
  return 'Laptop';
}

/** A device name worth storing: short, one line, and not empty. */
export function cleanDeviceName(name, fallback = 'This device') {
  const value = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return value || fallback;
}

/** SHA-256 of some bytes, lowercase hex. Web Crypto only, so it runs everywhere. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Turn a signed URL into one the browser will save rather than display.
 *
 * Storage answers a signed URL with "?download=<name>", which sets
 * Content-Disposition. The HTML `download` attribute cannot do this job: the
 * file comes from the Supabase host, and a download attribute is ignored
 * cross-origin, so the browser would navigate to the image instead of saving it.
 */
export function downloadUrl(signedUrl, fileName) {
  const url = String(signedUrl ?? '');
  if (!url) return '';
  const name = safeFileName(fileName);
  return url + (url.includes('?') ? '&' : '?') + `download=${encodeURIComponent(name)}`;
}

/** The title to give a folder opened from a script. */
export const titleForScript = (script) => {
  const s = script || {};
  const title = String(s.title || s.yt_title || s.topic || '').replace(/\s+/g, ' ').trim();
  return (title || `Script ${s.id ?? ''}`.trim()).slice(0, 120);
};
