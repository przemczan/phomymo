/**
 * Optional sync of localStorage data to a shared Phomymo storage server.
 *
 * Offline-first: every read/write still goes through localStorage first via
 * utils/errors.js. This module only mirrors those writes in the background
 * (and pulls server state once on startup) to the page's own origin. If the
 * page isn't served by storage_server.py (e.g. a plain static file server),
 * the /api/storage requests simply fail and sync stays offline.
 */

const SYNC_META_KEY = 'phomymo_sync_meta';

// Bootstrap key for the sync mechanism itself must never be synced.
const NEVER_SYNC_KEYS = new Set([SYNC_META_KEY]);

let status = 'offline'; // 'synced' | 'offline'
let statusListener = null;

function getServerUrl() {
  return window.location.origin;
}

function getSyncMeta() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_META_KEY)) || {};
  } catch {
    return {};
  }
}

function setSyncMetaEntry(key, updatedAt) {
  const meta = getSyncMeta();
  meta[key] = updatedAt;
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
}

function setStatus(next) {
  status = next;
  if (statusListener) statusListener(status);
}

/**
 * Subscribe to sync status changes ('synced' | 'offline').
 */
export function onSyncStatusChange(listener) {
  statusListener = listener;
  listener(status);
}

export function getSyncStatus() {
  return status;
}

/**
 * Push a single key's value to the server. Fire-and-forget: network errors
 * are swallowed since the local write already succeeded.
 */
export async function pushKey(key, value) {
  if (NEVER_SYNC_KEYS.has(key)) return;

  const updatedAt = Date.now();
  try {
    const response = await fetch(`${getServerUrl()}/api/storage/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, updatedAt }),
    });
    if (response.ok) {
      setSyncMetaEntry(key, updatedAt);
      setStatus('synced');
    } else {
      setStatus('offline');
    }
  } catch {
    setStatus('offline');
  }
}

/**
 * Push a deletion of a single key to the server.
 */
export async function pushDelete(key) {
  if (NEVER_SYNC_KEYS.has(key)) return;

  const updatedAt = Date.now();
  try {
    const response = await fetch(`${getServerUrl()}/api/storage/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt }),
    });
    if (response.ok) {
      setSyncMetaEntry(key, updatedAt);
      setStatus('synced');
    } else {
      setStatus('offline');
    }
  } catch {
    setStatus('offline');
  }
}

/**
 * Pull all keys from the server on startup. For each key, if the server's
 * copy is newer than what we last synced locally, overwrite localStorage
 * directly (bypassing pushKey, so we don't immediately push it right back).
 */
export async function pullAll() {
  try {
    const response = await fetch(`${getServerUrl()}/api/storage`);
    if (!response.ok) {
      setStatus('offline');
      return;
    }

    const store = await response.json();
    const meta = getSyncMeta();

    for (const [key, entry] of Object.entries(store)) {
      if (NEVER_SYNC_KEYS.has(key)) continue;
      const localUpdatedAt = meta[key] || 0;
      if (entry.updatedAt > localUpdatedAt) {
        localStorage.setItem(key, entry.value);
        setSyncMetaEntry(key, entry.updatedAt);
      }
    }

    setStatus('synced');
  } catch {
    setStatus('offline');
  }
}
