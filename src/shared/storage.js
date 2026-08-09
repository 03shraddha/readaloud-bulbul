/**
 * src/shared/storage.js
 *
 * Typed chrome.storage.local accessors for the shared_contracts §7 schema.
 *
 * Write policy (per §7): only the background service worker should call the
 * write paths (patchSettings, putProgress, deleteProgress, putSessionSnapshot).
 * This module lives in `shared/` (rather than `background/`) purely so the
 * options page can read settings directly; content scripts and the offscreen
 * document must never write storage.
 *
 * NOTE: This is foundation scaffolding. Function bodies are placeholders
 * (documented no-ops / minimal implementations) for later tasks to fill in
 * fully — the exported shape and semantics below are the contract every
 * caller may rely on.
 */

import {
  SETTINGS_KEY,
  PROGRESS_INDEX_KEY,
  SESSION_KEY,
  progressKey,
} from './keys.js';
import {
  DEFAULT_BACKEND_BASE_URL,
  DEFAULT_SPEAKER,
  MAX_PROGRESS_ENTRIES,
} from './constants.js';

const SETTINGS_SCHEMA_VERSION = 1;
const PROGRESS_SCHEMA_VERSION = 1;

/** @returns {import('./types.js').Settings} */
function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
    rate: 1.0,
    languageCode: 'en-IN',
    speaker: DEFAULT_SPEAKER,
    pace: 1.0,
    temperature: 0.6,
    autoScroll: true,
    skipPromoted: true,
    announceRetweets: true,
    highlightStyle: 'gradient',
    widgetPosition: { x: null, y: null },
    volume: 1.0,
    mockBackend: false,
  };
}

/**
 * Read settings, merged over defaults. Discards (falls back to defaults for)
 * any stored record whose schemaVersion doesn't match.
 * @returns {Promise<import('./types.js').Settings>}
 */
export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const record = stored[SETTINGS_KEY];
  const defaults = defaultSettings();
  if (!record || record.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return defaults;
  }
  return { ...defaults, ...record };
}

/**
 * Shallow-merge a patch into stored settings and persist.
 * @param {Partial<import('./types.js').Settings>} patch
 * @returns {Promise<import('./types.js').Settings>}
 */
export async function patchSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch, schemaVersion: SETTINGS_SCHEMA_VERSION };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Read a progress record for a content key.
 * @param {string} contentKey
 * @returns {Promise<import('./types.js').ProgressRecord|null>}
 */
export async function getProgress(contentKey) {
  const key = progressKey(contentKey);
  const stored = await chrome.storage.local.get(key);
  const record = stored[key];
  if (!record || record.schemaVersion !== PROGRESS_SCHEMA_VERSION) {
    return null;
  }
  return record;
}

/**
 * Persist a progress record, update the LRU progress index, and evict the
 * oldest entries beyond MAX_PROGRESS_ENTRIES.
 *
 * Debouncing per PROGRESS_SAVE_DEBOUNCE_MS is the caller's (background
 * session manager's) responsibility — this function performs an immediate
 * write.
 * @param {import('./types.js').ProgressRecord} record
 * @returns {Promise<void>}
 */
export async function putProgress(record) {
  const key = progressKey(record.contentKey);
  const toStore = { ...record, schemaVersion: PROGRESS_SCHEMA_VERSION };
  await chrome.storage.local.set({ [key]: toStore });

  const indexStored = await chrome.storage.local.get(PROGRESS_INDEX_KEY);
  /** @type {Array<{contentKey:string, updatedAt:number}>} */
  let index = indexStored[PROGRESS_INDEX_KEY] || [];

  index = index.filter((entry) => entry.contentKey !== record.contentKey);
  index.unshift({ contentKey: record.contentKey, updatedAt: record.updatedAt });

  const evicted = index.slice(MAX_PROGRESS_ENTRIES);
  index = index.slice(0, MAX_PROGRESS_ENTRIES);

  await chrome.storage.local.set({ [PROGRESS_INDEX_KEY]: index });

  if (evicted.length) {
    const evictedKeys = evicted.map((entry) => progressKey(entry.contentKey));
    await chrome.storage.local.remove(evictedKeys);
  }
}

/**
 * Delete a progress record and remove it from the index.
 * @param {string} contentKey
 * @returns {Promise<void>}
 */
export async function deleteProgress(contentKey) {
  await chrome.storage.local.remove(progressKey(contentKey));
  const indexStored = await chrome.storage.local.get(PROGRESS_INDEX_KEY);
  /** @type {Array<{contentKey:string, updatedAt:number}>} */
  const index = indexStored[PROGRESS_INDEX_KEY] || [];
  const next = index.filter((entry) => entry.contentKey !== contentKey);
  await chrome.storage.local.set({ [PROGRESS_INDEX_KEY]: next });
}

/**
 * Read the crash/SW-restart recovery snapshot.
 * @returns {Promise<import('./types.js').SessionSnapshot|null>}
 */
export async function getSessionSnapshot() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

/**
 * Persist the crash/SW-restart recovery snapshot.
 * @param {import('./types.js').SessionSnapshot} snapshot
 * @returns {Promise<void>}
 */
export async function putSessionSnapshot(snapshot) {
  await chrome.storage.local.set({ [SESSION_KEY]: snapshot });
}
