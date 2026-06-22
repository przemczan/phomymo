/**
 * Optional sync of localStorage data to a shared Phomymo storage server.
 *
 * Offline-first: every read/write still goes through localStorage first via
 * utils/errors.js. This module only mirrors those writes to a server in the
 * background (and pulls server state once on startup) when a server URL has
 * been configured. With no URL configured, every function here is a no-op.
 */

const SERVER_URL_KEY = 'phomymo_sync_server_url';
const SYNC_META_KEY = 'phomymo_sync_meta';

// Bootstrap keys for the sync mechanism itself must never be synced.
const NEVER_SYNC_KEYS = new Set([SERVER_URL_KEY, SYNC_META_KEY]);

let status = 'not-configured'; // 'not-configured' | 'synced' | 'offline'
let statusListener = null;

function getServerUrl() {
  const url = localStorage.getItem(SERVER_URL_KEY);
  return url ? url.replace(/\/+$/, '') : '';
}

function setServerUrl(url) {
  if (url) {
    localStorage.setItem(SERVER_URL_KEY, url);
  } else {
    localStorage.removeItem(SERVER_URL_KEY);
  }
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
 * Subscribe to sync status changes ('not-configured' | 'synced' | 'offline').
 */
export function onSyncStatusChange(listener) {
  statusListener = listener;
  listener(status);
}

export function getSyncStatus() {
  return status;
}

export function configureSync(url) {
  setServerUrl(url);
  setStatus(url ? 'offline' : 'not-configured');
}

export function getConfiguredServerUrl() {
  return getServerUrl();
}

/**
 * Push a single key's value to the server. Fire-and-forget: network errors
 * are swallowed since the local write already succeeded.
 */
export async function pushKey(key, value) {
  if (NEVER_SYNC_KEYS.has(key)) return;
  const serverUrl = getServerUrl();
  if (!serverUrl) return;

  const updatedAt = Date.now();
  try {
    const response = await fetch(`${serverUrl}/api/storage/${encodeURIComponent(key)}`, {
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
  const serverUrl = getServerUrl();
  if (!serverUrl) return;

  const updatedAt = Date.now();
  try {
    const response = await fetch(`${serverUrl}/api/storage/${encodeURIComponent(key)}`, {
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
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    setStatus('not-configured');
    return;
  }

  try {
    const response = await fetch(`${serverUrl}/api/storage`);
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
