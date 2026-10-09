// The browser half of local project folders: everything that cannot run in
// Node — showDirectoryPicker, the permission dance, and remembering the
// chosen folder between visits — kept as thin as public/transfer.js keeps
// WebRTC, for the same reason. Every decision about what the folder is
// called and what goes in it lives in shared/localfolder.mjs instead.

const DB_NAME = 'vr-localfolder';
const STORE = 'handles';
const KEY = 'root';

/** Chrome and Edge on desktop only. Everywhere else this feature does not exist. */
export const isSupported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open local storage.'));
  });
}

/** A FileSystemDirectoryHandle is structured-cloneable, so IndexedDB can hold it as is. */
async function idbGet() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** The folder remembered from a previous visit, or null if none was ever chosen. */
export async function loadRootHandle() {
  try {
    return await idbGet();
  } catch {
    return null;
  }
}

/**
 * Ask for a folder. Needs a user gesture — this can only be called from
 * directly inside a click handler, never from startup or a background sync.
 */
export async function chooseRootFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbSet(handle);
  return handle;
}

/** Stop using this folder. The folder itself and everything in it is untouched. */
export async function forgetRootFolder() {
  await idbClear();
}

export { checkPermission, requestPermission } from './shared/localfolder.mjs';
