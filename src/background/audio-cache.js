/**
 * src/background/audio-cache.js
 *
 * In-memory cache of synthesized sentence audio, shared by every
 * PrefetchQueue in this service worker.
 *
 * Why it exists: a skip or seek resets the prefetch queue and flushes the
 * offscreen player. Without a cache, every sentence around the new position
 * went back to the backend, even the ones played a moment ago. Moving back
 * two sentences cost a full network round trip per sentence. With the cache,
 * a sentence that was synthesized once is handed back at once.
 *
 * Two maps:
 *  - `done`    finished results, least-recently-used first (Map keeps
 *              insertion order; a hit re-inserts the entry at the end).
 *  - `pending` requests still on the wire. A second caller for the same key
 *              joins the first request and does not start another one. This
 *              is also what lets a request outlive the queue reset that
 *              started it: the result still lands in `done`.
 *
 * The cache holds base64 strings, so it is bounded by entry count and by
 * total characters. It lives only as long as the service worker does; a
 * worker restart starts empty, which is safe (the queue just fetches again).
 */

const MAX_ENTRIES = 80;
/** ~18 MB of base64. One MP3 sentence is usually 30 to 150 KB. */
const MAX_TOTAL_CHARS = 18 * 1024 * 1024;

/** @type {Map<string, object>} */
const done = new Map();
/** @type {Map<string, {promise: Promise<object>, controller: AbortController, index: number, owner: string|null}>} */
const pending = new Map();
let totalChars = 0;

/**
 * Everything that changes how a sentence sounds goes into the key, so a
 * voice or pace change can never replay audio made with the old settings.
 * @param {{text:string, languageCode?:string}} sentence
 * @param {object} settings
 * @returns {string}
 */
export function audioCacheKey(sentence, settings) {
  const s = settings || {};
  return [
    s.backendBaseUrl || '',
    s.speaker || '',
    s.pace ?? '',
    s.temperature ?? '',
    sentence?.languageCode || s.languageCode || '',
    sentence?.text || '',
  ].join('\u0001');
}

function sizeOf(result) {
  return typeof result?.audioBase64 === 'string' ? result.audioBase64.length : 0;
}

function store(key, result) {
  if (done.has(key)) {
    totalChars -= sizeOf(done.get(key));
    done.delete(key);
  }
  done.set(key, result);
  totalChars += sizeOf(result);

  while (done.size > MAX_ENTRIES || (totalChars > MAX_TOTAL_CHARS && done.size > 1)) {
    const oldestKey = done.keys().next().value;
    totalChars -= sizeOf(done.get(oldestKey));
    done.delete(oldestKey);
  }
}

/**
 * @param {string} key
 * @returns {object|null} the cached result, refreshed as most recently used.
 */
export function peekAudio(key) {
  if (!done.has(key)) return null;
  const result = done.get(key);
  done.delete(key);
  done.set(key, result);
  return result;
}

/**
 * Return cached audio, join a request already on the wire, or start one.
 *
 * `synth(signal)` must return the synthesis result or throw. A failed
 * request is never cached, so a later call tries again.
 * @param {object} params
 * @param {string} params.key
 * @param {number} params.index - Sentence.index, used only by pruneInFlight()
 * @param {string|null} params.owner - sessionId, used only by pruneInFlight()
 * @param {(signal: AbortSignal) => Promise<object>} params.synth
 * @returns {Promise<object>}
 */
export function getOrSynthesize({ key, index, owner, synth }) {
  const cached = peekAudio(key);
  if (cached) return Promise.resolve(cached);

  const existing = pending.get(key);
  if (existing) {
    // The window moved but this sentence is wanted again: keep it alive
    // under its newest index/owner so the next prune does not abort it.
    existing.index = index;
    existing.owner = owner;
    return existing.promise;
  }

  const controller = new AbortController();
  const entry = { promise: null, controller, index, owner };
  entry.promise = (async () => {
    try {
      const result = await synth(controller.signal);
      store(key, result);
      return result;
    } finally {
      if (pending.get(key) === entry) pending.delete(key);
    }
  })();
  // Callers attach their own handlers; this one only stops an abandoned
  // request (every waiter went stale) from raising an unhandled rejection.
  entry.promise.catch(() => {});
  pending.set(key, entry);
  return entry.promise;
}

/**
 * Abort this owner's requests that fall outside [fromIndex, toIndex]. Called
 * on every queue reset: requests near the new position keep running and fill
 * the cache; requests far away would only waste backend calls.
 * @param {string|null} owner
 * @param {number} fromIndex
 * @param {number} toIndex
 */
export function pruneInFlight(owner, fromIndex, toIndex) {
  for (const [key, entry] of Array.from(pending.entries())) {
    if (entry.owner !== owner) continue;
    if (entry.index >= fromIndex && entry.index <= toIndex) continue;
    pending.delete(key);
    try {
      entry.controller.abort();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Abort every request this owner still has on the wire (session end).
 * @param {string|null} owner
 */
export function abortInFlight(owner) {
  pruneInFlight(owner, 1, 0); // empty window: nothing is kept
}

/** Drop everything. Used by tests and when settings make the cache moot. */
export function clearAudioCache() {
  for (const entry of pending.values()) {
    try {
      entry.controller.abort();
    } catch {
      /* ignore */
    }
  }
  pending.clear();
  done.clear();
  totalChars = 0;
}

/** @returns {{entries:number, pending:number, totalChars:number}} */
export function audioCacheStats() {
  return { entries: done.size, pending: pending.size, totalChars };
}
