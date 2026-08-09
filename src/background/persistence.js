/**
 * src/background/persistence.js
 *
 * All chrome.storage.local writes for the background service worker
 * (shared_contracts §7). Wraps the foundation `src/shared/storage.js`
 * accessors with:
 *  - an in-memory settings cache (so per-sentence TTS calls don't hit
 *    chrome.storage on every request) + CONTROL_SET_OPTION handling,
 *  - debounced (2000ms) progress saves with immediate-flush entry points
 *    for pause / stop / session-end / suspend,
 *  - per-kind ProgressRecord construction: articles persist index +
 *    contentHash; X/Twitter persists lastStatusId + a capped readStatusIds
 *    ring instead of a raw sentence index,
 *  - the CONTENT_READY -> lookup -> RESUME_AVAILABLE flow, including the
 *    "refuse to resume if the article's contentHash no longer matches"
 *    rule.
 *
 * Only this module (background) writes chrome.storage.local, per §7.
 */

import {
  getSettings,
  patchSettings,
  getProgress,
  putProgress,
  getSessionSnapshot,
  putSessionSnapshot,
} from '../shared/storage.js';
import { PROGRESS_INDEX_KEY, SESSION_KEY, SETTINGS_KEY, twitterContentKey } from '../shared/keys.js';
import { fnv1a32, normalizeUrl } from '../shared/hash.js';
import { PROGRESS_SAVE_DEBOUNCE_MS } from '../shared/constants.js';
import { MSG, TARGET, makeEnvelope, safeSendTabMessage } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('background:persistence');

/** X/Twitter readStatusIds ring cap (documented in shared/storage.js §7 JSDoc). */
const MAX_READ_STATUS_IDS = 500;

// ---------------------------------------------------------------------------
// Settings cache
// ---------------------------------------------------------------------------

/** @type {import('../shared/types.js').Settings|null} */
let settingsCache = null;

/** @type {Promise<import('../shared/types.js').Settings>|null} */
let settingsLoadPromise = null;

/**
 * Loads (once) and caches settings from storage. Safe to call repeatedly;
 * subsequent calls return the same in-flight/resolved promise.
 * @returns {Promise<import('../shared/types.js').Settings>}
 */
export async function loadSettingsCache() {
  if (!settingsLoadPromise) {
    settingsLoadPromise = getSettings()
      .then((settings) => {
        settingsCache = settings;
        return settings;
      })
      .catch((err) => {
        log.error('failed to load settings, using defaults', err);
        settingsLoadPromise = null; // allow retry on next call
        return settingsCache;
      });
  }
  return settingsLoadPromise;
}

/**
 * Synchronous read of the last-loaded settings snapshot. May be null very
 * briefly at cold start before loadSettingsCache() resolves.
 * @returns {import('../shared/types.js').Settings|null}
 */
export function getCachedSettings() {
  return settingsCache;
}

// The options page (src/options/options.js) writes `ra.settings` directly via
// shared/storage.js rather than through CONTROL_SET_OPTION, and the message
// catalog has no "settings changed" notification. Watching storage keeps the
// cache honest so a mid-session TTS request can't keep using a stale
// speaker/pace/backendBaseUrl.
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[SETTINGS_KEY];
    if (!change || !change.newValue) return;
    settingsCache = change.newValue;
    log.debug('settings cache refreshed from storage change');
  });
} catch (err) {
  log.warn('could not subscribe to storage changes', err);
}

/**
 * Handles CONTROL_SET_OPTION (and the internal rate-persist call from
 * CONTROL_SET_RATE): merges into the cache immediately (so the very next TTS
 * request already sees it) and persists to storage.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<import('../shared/types.js').Settings|null>}
 */
export async function updateSetting(key, value) {
  if (!key) return settingsCache;
  settingsCache = { ...(settingsCache || {}), [key]: value };
  try {
    settingsCache = await patchSettings({ [key]: value });
  } catch (err) {
    log.error(`failed to persist setting "${key}"`, err);
  }
  return settingsCache;
}

// ---------------------------------------------------------------------------
// Progress: debounced saves + immediate flush
// ---------------------------------------------------------------------------

/** @type {Map<string, ReturnType<typeof setTimeout>>} sessionId -> timer */
const debounceTimers = new Map();

/**
 * @param {import('./session.js').Session} session
 * @returns {import('../shared/types.js').ProgressRecord}
 */
function buildProgressRecord(session) {
  const sentence = session.cursor >= 0 ? session.sentences[session.cursor] : null;
  const previewText = (sentence?.text || '').slice(0, 120);

  /** @type {import('../shared/types.js').ProgressRecord} */
  const record = {
    schemaVersion: 1,
    contentKey: session.contentKey,
    kind: session.kind,
    url: session.url,
    title: session.title,
    contentHash: session.kind === 'article' ? session.contentHash ?? null : null,
    index: session.cursor,
    unitId: sentence?.unitId ?? null,
    sentenceId: sentence?.id ?? null,
    previewText,
    totalSentences: session.totalSentences,
    lastStatusId: session.kind === 'twitter' ? session.lastStatusId ?? null : null,
    readStatusIds: session.kind === 'twitter' ? (session.readStatusIds || []).slice(-MAX_READ_STATUS_IDS) : [],
    updatedAt: Date.now(),
  };

  return record;
}

/**
 * Schedule a debounced progress save (PROGRESS_SAVE_DEBOUNCE_MS). Repeated
 * calls for the same session coalesce into a single write.
 * @param {import('./session.js').Session} session
 */
export function scheduleProgressSave(session) {
  if (!session?.sessionId || !session.contentKey) return;

  const existing = debounceTimers.get(session.sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(session.sessionId);
    flushProgress(session).catch((err) => log.error('debounced progress save failed', err));
  }, PROGRESS_SAVE_DEBOUNCE_MS);

  debounceTimers.set(session.sessionId, timer);
}

/**
 * Immediately persist progress (and the session snapshot), bypassing any
 * pending debounce timer. Call on CONTROL_PAUSE, CONTROL_STOP, SESSION_ENDED,
 * and chrome.runtime.onSuspend.
 * @param {import('./session.js').Session} session
 * @returns {Promise<void>}
 */
export async function flushProgress(session) {
  if (!session?.contentKey) return;

  const existing = debounceTimers.get(session.sessionId);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(session.sessionId);
  }

  // A session that never ingested any content has nothing worth persisting,
  // and buildProgressRecord() would produce a record with kind/url/title/
  // contentHash nulled and totalSentences 0 — actively WORSE than whatever is
  // already stored under this contentKey. That is exactly the shape of a
  // session rebuilt by session.js's recoverSessionForTab(): the snapshot
  // carries only sessionId/tabId/contentKey/index/status/rate, so a
  // CONTROL_PAUSE or CONTROL_STOP arriving right after a service-worker
  // restart would otherwise overwrite the real ProgressRecord with a stub
  // (dropping contentHash => the next resume offer is refused as "this
  // article changed", and dropping readStatusIds on X). Skip the write; the
  // cursor it would save is the one it was just restored FROM.
  if (session.totalSentences > 0) {
    try {
      await putProgress(buildProgressRecord(session));
    } catch (err) {
      log.error('putProgress failed', err);
    }
  } else {
    log.debug('skipping progress write for a session with no ingested content', session.contentKey);
  }

  await saveSessionSnapshot(session);
}

/**
 * Cancel any pending debounced save for a session (e.g. once it has ended
 * and a final flush already happened).
 * @param {string} sessionId
 */
export function cancelProgressSave(sessionId) {
  const existing = debounceTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Resume lookup (CONTENT_READY -> RESUME_AVAILABLE) + RESUME_DECISION
// ---------------------------------------------------------------------------

/** @type {Map<number, {contentKey:string, record:import('../shared/types.js').ProgressRecord}>} tabId -> pending offer */
const pendingResumeByTab = new Map();

/**
 * @returns {Promise<Array<{contentKey:string, updatedAt:number}>>}
 */
async function listProgressIndex() {
  const stored = await chrome.storage.local.get(PROGRESS_INDEX_KEY);
  return stored[PROGRESS_INDEX_KEY] || [];
}

/**
 * Best-effort article progress lookup by URL alone (contentHash is not known
 * until after extraction, so we match on the URL-derived prefix of the
 * contentKey and pick the most recently updated candidate).
 * @param {string} url
 * @returns {Promise<import('../shared/types.js').ProgressRecord|null>}
 */
async function findArticleProgressForUrl(url) {
  const prefix = `article:${fnv1a32(normalizeUrl(url))}:`;
  const index = await listProgressIndex();
  const candidates = index
    .filter((entry) => entry.contentKey.startsWith(prefix))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const candidate of candidates) {
    const record = await getProgress(candidate.contentKey);
    if (record) return record;
  }
  return null;
}

/**
 * @param {{url:string, extractorId:string|null}} params
 * @returns {Promise<import('../shared/types.js').ProgressRecord|null>}
 */
export async function findResumeCandidate({ url, extractorId }) {
  try {
    if (extractorId === 'twitter') {
      const parsed = new URL(url);
      const contentKey = twitterContentKey({ pathname: parsed.pathname, search: parsed.search });
      return await getProgress(contentKey);
    }
    if (extractorId === 'article') {
      return await findArticleProgressForUrl(url);
    }
  } catch (err) {
    log.error('findResumeCandidate failed', err);
  }
  return null;
}

/**
 * Handles CONTENT_READY: looks up any stored progress for this page and, if
 * found, remembers it as a pending offer for the tab and sends
 * RESUME_AVAILABLE.
 * @param {import('../shared/types.js').ContentReadyPayload} payload
 * @param {number|null} tabId
 */
export async function handleContentReady(payload, tabId) {
  if (tabId == null) return;

  const record = await findResumeCandidate({ url: payload.url, extractorId: payload.extractorId });
  if (!record) {
    pendingResumeByTab.delete(tabId);
    return;
  }

  pendingResumeByTab.set(tabId, { contentKey: record.contentKey, record });

  await safeSendTabMessage(
    tabId,
    makeEnvelope(MSG.RESUME_AVAILABLE, TARGET.CONTENT, null, {
      contentKey: record.contentKey,
      index: record.index,
      unitId: record.unitId,
      previewText: record.previewText,
      savedAt: record.updatedAt,
      totalSentences: record.totalSentences,
    })
  );
}

/**
 * @param {number} tabId
 * @returns {{contentKey:string, record:import('../shared/types.js').ProgressRecord}|null}
 */
export function getPendingResume(tabId) {
  return pendingResumeByTab.get(tabId) || null;
}

/**
 * @param {number} tabId
 */
export function clearPendingResume(tabId) {
  pendingResumeByTab.delete(tabId);
}

/**
 * Handles RESUME_DECISION. Returns true iff the caller (service-worker)
 * should now activate the tab (send ACTIVATE) to kick off extraction; the
 * actual index/hash application happens later, once START_READING lands
 * with real content (see session.js `tryApplyResume`).
 * @param {import('../shared/types.js').ResumeDecisionPayload} payload
 * @param {number|null} tabId
 * @returns {boolean}
 */
export function handleResumeDecision(payload, tabId) {
  if (tabId == null) return false;
  const pending = pendingResumeByTab.get(tabId);

  if (!payload?.accept) {
    pendingResumeByTab.delete(tabId);
    return false;
  }

  if (!pending || pending.contentKey !== payload.contentKey) {
    log.warn('RESUME_DECISION accept for unknown/stale contentKey, ignoring', payload?.contentKey);
    pendingResumeByTab.delete(tabId);
    return false;
  }

  return true;
}

/**
 * The "refuses to offer a resume when the stored contentHash differs" rule
 * for articles. X/Twitter has no hash to check here (its authoritative
 * anchor is lastStatusId, validated separately by the caller).
 * @param {{kind:string, contentHash:string|null}} session
 * @param {import('../shared/types.js').ProgressRecord|null} record
 * @returns {boolean}
 */
export function isArticleResumeValid(session, record) {
  if (!record) return false;
  if (session.kind !== 'article') return true;
  return !!record.contentHash && record.contentHash === session.contentHash;
}

// ---------------------------------------------------------------------------
// Session snapshot (crash / SW-restart recovery)
// ---------------------------------------------------------------------------

/**
 * @param {import('./session.js').Session} session
 * @returns {Promise<void>}
 */
export async function saveSessionSnapshot(session) {
  if (!session?.sessionId) return;
  try {
    await putSessionSnapshot({
      sessionId: session.sessionId,
      tabId: session.tabId,
      contentKey: session.contentKey,
      index: session.cursor,
      status: session.status,
      rate: session.rate,
      updatedAt: Date.now(),
    });
  } catch (err) {
    log.error('saveSessionSnapshot failed', err);
  }
}

/**
 * @returns {Promise<void>}
 */
export async function clearSessionSnapshot() {
  try {
    await chrome.storage.local.remove(SESSION_KEY);
  } catch (err) {
    log.error('clearSessionSnapshot failed', err);
  }
}

/**
 * @returns {Promise<import('../shared/types.js').SessionSnapshot|null>}
 */
export async function readSessionSnapshot() {
  try {
    return await getSessionSnapshot();
  } catch (err) {
    log.error('readSessionSnapshot failed', err);
    return null;
  }
}
