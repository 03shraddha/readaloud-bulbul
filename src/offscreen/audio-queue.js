/**
 * src/offscreen/audio-queue.js
 *
 * The gapless A/B playback engine used by src/offscreen/offscreen.js.
 * Implements shared_contracts §9 (audio pipeline rules) and the offscreen
 * half of §3 (message catalog) — this module itself is transport-agnostic:
 * it knows nothing about chrome.runtime, only about two <audio> elements and
 * an `onEvent(type, payload)` callback the caller wires up to the message
 * bus. `type` values are always members of MSG.* so offscreen.js can pass
 * them straight through to `makeEnvelope`.
 *
 * Core invariants (see shared_contracts §9 and the task brief):
 *  - audioBase64 -> Uint8Array -> Blob(mimeType) -> URL.createObjectURL,
 *    capped at MAX_LIVE_URLS live object URLs; every URL is revoked on
 *    ended/flush/stop. Leaking blob URLs here is the top memory risk.
 *  - Playback proceeds strictly in ascending Sentence.index. Out-of-order
 *    arrivals are held (in `pending`, keyed by index) until their
 *    predecessor has ended; arrivals whose index is below the current
 *    cursor are discarded outright.
 *  - Two <audio> elements alternate as "current" (playing) and "preload"
 *    (next clip loaded and ready) so sentence-to-sentence transitions are
 *    gapless.
 *  - playbackRate/preservesPitch are (re)applied to BOTH elements whenever
 *    the rate changes or a new clip is loaded into either element.
 */

import { MSG } from '../shared/messages.js';
import { TICK_INTERVAL_MS } from '../shared/constants.js';

/** Hard cap on simultaneously-live object URLs (shared_contracts §9). */
const MAX_LIVE_URLS = 6;

/** MediaError.code -> our PLAYBACK_ERROR code vocabulary. */
const ERROR_CODE_BY_MEDIA_ERROR = {
  1: 'ABORTED', // MEDIA_ERR_ABORTED
  2: 'NETWORK', // MEDIA_ERR_NETWORK
  3: 'DECODE', // MEDIA_ERR_DECODE
  4: 'DECODE', // MEDIA_ERR_SRC_NOT_SUPPORTED — closest fit, usually a bad/corrupt blob
};

const NOOP_LOG = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class AudioQueue {
  /**
   * @param {{elA: HTMLAudioElement, elB: HTMLAudioElement,
   *          onEvent: (type: string, payload: object) => void,
   *          log?: {debug:Function,info:Function,warn:Function,error:Function}}} opts
   */
  constructor({ elA, elB, onEvent, log }) {
    this.elements = [elA, elB];
    this.onEvent = onEvent;
    this.log = log || NOOP_LOG;

    /** Current shared rate, applied to both elements. */
    this.rate = 1.0;

    /** True between AUDIO_PLAY and the next AUDIO_PAUSE/AUDIO_STOP. */
    this.wantsPlay = false;

    /** @type {Map<number, {sentenceId:string,index:number,url:string,mimeType:string,durationHintMs:number|null}>} */
    this.pending = new Map();

    /** Item currently loaded into an element and (if wantsPlay) playing. */
    this.current = null;
    /** Item preloaded into the *other* element, paused, ready to become current. */
    this.preload = null;

    /** Next index allowed to become `current`; null until established. */
    this.cursor = null;

    /** @type {Set<string>} */
    this.liveUrls = new Set();

    this._lastBufferLowCount = null;
    this._lastTickAt = 0;

    for (const el of this.elements) this._bindElement(el);
    this._applyRateToBoth();
  }

  // ---------------------------------------------------------------------
  // Public API — invoked by offscreen.js message handlers
  // ---------------------------------------------------------------------

  /**
   * OFFSCREEN_INIT: full reset for a brand-new session.
   *
   * `startIndex` is the session's starting Sentence.index. It MUST be honored:
   * background dispatches prefetched sentences in COMPLETION order, not index
   * order, so if the cursor were left null and sentence N+1 happened to
   * synthesize before sentence N, _pump() would take the lowest pending index
   * (N+1), pin the cursor there, and sentence N would then be discarded by the
   * `index < cursor` stale check when it finally arrived.
   * @param {number} [rate]
   * @param {number} [startIndex]
   */
  reset(rate, startIndex) {
    this._stopInternal();
    this.cursor = typeof startIndex === 'number' && Number.isFinite(startIndex) ? startIndex : null;
    this.wantsPlay = false;
    this._lastBufferLowCount = null;
    this.setRate(typeof rate === 'number' ? rate : 1.0);
  }

  /** AUDIO_SET_RATE: applied to both elements immediately. */
  setRate(rate) {
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      this.rate = rate;
    }
    this._applyRateToBoth();
  }

  /**
   * SENTENCE_AUDIO_READY: enqueue-only, never plays synchronously here.
   * @param {import('../shared/types.js').SentenceAudioReadyPayload} payload
   */
  enqueue(payload) {
    if (!payload || typeof payload.index !== 'number') return;
    const { index } = payload;

    if (this.cursor !== null && index < this.cursor) {
      this.log.debug('discarding stale sentence audio', { index, cursor: this.cursor });
      return;
    }
    if (
      this.pending.has(index) ||
      (this.current && this.current.index === index) ||
      (this.preload && this.preload.index === index)
    ) {
      this.log.debug('duplicate sentence audio ignored', { index });
      return;
    }

    let url;
    try {
      const bytes = base64ToUint8Array(payload.audioBase64);
      const blob = new Blob([bytes], { type: payload.mimeType || 'audio/mpeg' });
      url = URL.createObjectURL(blob);
    } catch (err) {
      this.log.error('failed to decode sentence audio', err);
      this.onEvent(MSG.PLAYBACK_ERROR, {
        sentenceId: payload.sentenceId,
        index,
        code: 'DECODE',
        message: String((err && err.message) || err),
      });
      return;
    }

    this._enforceUrlCap();
    this.liveUrls.add(url);

    this.pending.set(index, {
      sentenceId: payload.sentenceId,
      index,
      url,
      mimeType: payload.mimeType,
      durationHintMs: typeof payload.durationHintMs === 'number' ? payload.durationHintMs : null,
    });

    this._pump();
  }

  /** AUDIO_PLAY */
  play() {
    this.wantsPlay = true;
    if (this.current) {
      this._attemptPlay(this.current);
    } else {
      this._pump();
    }
  }

  /** AUDIO_PAUSE */
  pause() {
    this.wantsPlay = false;
    if (this.current && this.current.el) {
      try {
        this.current.el.pause();
      } catch {
        /* noop */
      }
    }
  }

  /** AUDIO_STOP: stop + drop queue + revoke blobs. */
  stop() {
    this._stopInternal();
  }

  /**
   * AUDIO_FLUSH{fromIndex}: playback is being repositioned to `fromIndex`.
   *
   * Everything currently held is dropped — queued items, the preloaded clip,
   * AND the clip playing right now, whatever its index. Stopping the current
   * clip unconditionally is what makes skip-forward audible immediately
   * (shared_contracts §9: "drops all in-flight work on skip/seek/stop"); if
   * the playing clip were allowed to run to its end, its audio would keep
   * going while the background cursor — and therefore the highlight — had
   * already moved on.
   * @param {number} fromIndex
   */
  flush(fromIndex) {
    if (typeof fromIndex !== 'number') return;

    // Nothing below the new cursor can ever play again, so keeping any of it
    // would just leak object URLs.
    for (const [idx, item] of Array.from(this.pending.entries())) {
      this._revoke(item.url);
      this.pending.delete(idx);
    }

    if (this.preload) {
      this._resetElement(this.preload.el);
      this._revoke(this.preload.url);
      this.preload = null;
    }

    if (this.current) {
      const el = this.current.el;
      try {
        el.pause();
      } catch {
        /* noop */
      }
      this._resetElement(el);
      this._revoke(this.current.url);
      this.current = null;
    }

    // Whatever arrives next legitimately starts at fromIndex.
    this.cursor = fromIndex;

    this._pump();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  _stopInternal() {
    this.wantsPlay = false;
    for (const el of this.elements) {
      try {
        el.pause();
      } catch {
        /* noop */
      }
      this._resetElement(el);
    }
    for (const url of this.liveUrls) this._revokeRaw(url);
    this.liveUrls.clear();
    this.pending.clear();
    this.current = null;
    this.preload = null;
    this._lastBufferLowCount = null;
  }

  _resetElement(el) {
    try {
      el.removeAttribute('src');
      el.load();
    } catch {
      /* noop */
    }
  }

  _revoke(url) {
    if (!url) return;
    this._revokeRaw(url);
  }

  _revokeRaw(url) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* noop */
    }
    this.liveUrls.delete(url);
  }

  _enforceUrlCap() {
    if (this.liveUrls.size < MAX_LIVE_URLS) return;
    for (const [idx, item] of this.pending.entries()) {
      this._revoke(item.url);
      this.pending.delete(idx);
      this.log.warn('live objectURL cap reached; evicted oldest pending item', { index: idx });
      return;
    }
    this.log.warn('live objectURL cap reached with no evictable pending item');
  }

  _applyRateToBoth() {
    for (const el of this.elements) {
      el.playbackRate = this.rate;
      el.preservesPitch = true;
    }
  }

  _bindElement(el) {
    el.addEventListener('playing', () => this._onPlaying(el));
    el.addEventListener('timeupdate', () => this._onTimeUpdate(el));
    el.addEventListener('ended', () => this._onEnded(el));
    el.addEventListener('error', () => this._onError(el));
  }

  _itemForElement(el) {
    if (this.current && this.current.el === el) return this.current;
    if (this.preload && this.preload.el === el) return this.preload;
    return null;
  }

  _otherElement(el) {
    return this.elements[0] === el ? this.elements[1] : this.elements[0];
  }

  _onPlaying(el) {
    const item = this._itemForElement(el);
    if (!item || item !== this.current || item.startedEmitted) return;
    item.startedEmitted = true;
    this.onEvent(MSG.SENTENCE_STARTED, { sentenceId: item.sentenceId, index: item.index });
  }

  _onTimeUpdate(el) {
    const item = this._itemForElement(el);
    if (!item || item !== this.current) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._lastTickAt < TICK_INTERVAL_MS) return;
    this._lastTickAt = now;

    const durationMs = Number.isFinite(el.duration) && el.duration > 0
      ? el.duration * 1000
      : (item.durationHintMs ?? 0);

    this.onEvent(MSG.PLAYBACK_TICK, {
      sentenceId: item.sentenceId,
      index: item.index,
      currentTimeMs: el.currentTime * 1000,
      durationMs,
    });
  }

  _onEnded(el) {
    const item = this._itemForElement(el);
    if (!item || item !== this.current) return;

    // The real audio clock — never estimate (PRD §4).
    const durationMs = Number.isFinite(el.duration) && el.duration > 0
      ? el.duration * 1000
      : el.currentTime * 1000;

    this.onEvent(MSG.SENTENCE_ENDED, { sentenceId: item.sentenceId, index: item.index, durationMs });

    this._revoke(item.url);
    const lastIndex = item.index;
    this.current = null;
    this.cursor = lastIndex + 1;

    this._promoteAfterCurrentCleared(lastIndex);
  }

  _onError(el) {
    const item = this._itemForElement(el);
    if (!item) return;

    const mediaError = el.error;
    const code = (mediaError && ERROR_CODE_BY_MEDIA_ERROR[mediaError.code]) || 'UNKNOWN';
    const message = (mediaError && mediaError.message) || 'audio element error';

    this.onEvent(MSG.PLAYBACK_ERROR, { sentenceId: item.sentenceId, index: item.index, code, message });
    this._revoke(item.url);

    if (item === this.current) {
      const lastIndex = item.index;
      this.current = null;
      this.cursor = lastIndex + 1;
      this._promoteAfterCurrentCleared(lastIndex);
    } else if (item === this.preload) {
      this.preload = null;
      this._pump();
    }
  }

  _promoteAfterCurrentCleared(lastIndex) {
    if (this.preload && this.preload.index === this.cursor) {
      this.current = this.preload;
      this.preload = null;
      if (this.wantsPlay) this._attemptPlay(this.current);
      this._pump();
      return;
    }

    this._pump();

    if (!this.current && !this.preload && this.pending.size === 0 && this.wantsPlay) {
      this.onEvent(MSG.QUEUE_DRAINED, { lastIndex });
    }
  }

  _load(item, el) {
    item.el = el;
    item.startedEmitted = false;
    el.src = item.url;
    this._applyRateToBoth();
    try {
      el.load();
    } catch {
      /* noop */
    }
  }

  _attemptPlay(item) {
    if (!item || !item.el) return;
    this._applyRateToBoth();

    let playResult;
    try {
      playResult = item.el.play();
    } catch (err) {
      this.onEvent(MSG.PLAYBACK_ERROR, {
        sentenceId: item.sentenceId,
        index: item.index,
        code: 'ABORTED',
        message: String((err && err.message) || err),
      });
      return;
    }

    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch((err) => {
        // Autoplay-policy rejection (or any other play() failure) — report,
        // don't hang silently.
        this.onEvent(MSG.PLAYBACK_ERROR, {
          sentenceId: item.sentenceId,
          index: item.index,
          code: 'ABORTED',
          message: String((err && err.message) || err),
        });
      });
    }
  }

  _minPendingIndex() {
    let min = null;
    for (const idx of this.pending.keys()) {
      if (min === null || idx < min) min = idx;
    }
    return min;
  }

  _pump() {
    // Promote a `current` if none is loaded right now.
    if (!this.current) {
      const candidateIndex = this.cursor !== null ? this.cursor : this._minPendingIndex();
      if (candidateIndex !== null && this.pending.has(candidateIndex)) {
        const item = this.pending.get(candidateIndex);
        this.pending.delete(candidateIndex);
        this.cursor = candidateIndex;
        const el = this.preload && this.preload.el ? this._otherElement(this.preload.el) : this.elements[0];
        this._load(item, el);
        this.current = item;
        if (this.wantsPlay) this._attemptPlay(item);
      }
    }

    // Preload the next sentence into the other element for a gapless handoff.
    if (this.current && !this.preload) {
      const nextIndex = this.current.index + 1;
      if (this.pending.has(nextIndex)) {
        const item = this.pending.get(nextIndex);
        this.pending.delete(nextIndex);
        const el = this._otherElement(this.current.el);
        this._load(item, el);
        this.preload = item;
      }
    }

    const queuedAhead = this.pending.size + (this.preload ? 1 : 0);
    if (queuedAhead <= 1) {
      if (this._lastBufferLowCount !== queuedAhead) {
        this._lastBufferLowCount = queuedAhead;
        this.onEvent(MSG.BUFFER_LOW, { queuedCount: queuedAhead });
      }
    } else {
      this._lastBufferLowCount = null;
    }
  }
}

/**
 * @param {{elA: HTMLAudioElement, elB: HTMLAudioElement,
 *          onEvent: (type: string, payload: object) => void,
 *          log?: object}} opts
 * @returns {AudioQueue}
 */
export function createAudioQueue(opts) {
  return new AudioQueue(opts);
}
