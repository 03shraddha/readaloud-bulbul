/**
 * src/background/session.js
 *
 * The authoritative Session object (shared_contracts §2/§3/§4/§9). Holds the
 * flat sentence array indexed by Sentence.index, per-unit metadata, cursor,
 * status, rate and exhausted flag; implements START_READING, APPEND_UNITS,
 * every CONTROL_* transition, and the exact skip/seek sequence from §9
 * (mutate cursor -> AUDIO_FLUSH{fromIndex} -> reset prefetch -> re-enqueue).
 * Emits PLAYBACK_STATE on every state change and HIGHLIGHT_SENTENCE on
 * SENTENCE_STARTED.
 *
 * This module tracks a single active session at a time (module-level
 * `current`), matching the product model of "read this one page aloud" and
 * the fact that there is exactly one offscreen document / audio pipeline.
 * Activating a new tab implicitly ends whatever session was running.
 */

import { MSG, TARGET, makeEnvelope, safeSendTabMessage } from '../shared/messages.js';
import { RATES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { PrefetchQueue } from './prefetch-queue.js';
import * as offscreenManager from './offscreen-manager.js';
import * as persistence from './persistence.js';

const log = createLogger('background:session');

const MIN_RATE = Math.min(...RATES);
const MAX_RATE = Math.max(...RATES);
const MAX_READ_STATUS_IDS = 500;

/** @returns {string} */
function genSessionId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return `s_${Date.now()}_${rand}`;
}

/**
 * @param {*} rate
 * @returns {number}
 */
function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, n));
}

/**
 * @returns {import('../shared/types.js').PlaybackState}
 */
function idlePlaybackState() {
  return {
    sessionId: null,
    status: 'idle',
    index: -1,
    sentenceId: null,
    unitId: null,
    unitLabel: null,
    currentText: '',
    totalSentences: 0,
    exhausted: false,
    rate: persistence.getCachedSettings()?.rate ?? 1.0,
    queuedAhead: 0,
    contentKey: null,
    kind: null,
    error: null,
  };
}

class Session {
  /**
   * @param {{sessionId:string, tabId:number}} params
   */
  constructor({ sessionId, tabId }) {
    this.sessionId = sessionId;
    this.tabId = tabId;

    this.contentKey = null;
    this.contentHash = null;
    this.kind = null;
    this.title = null;
    this.url = null;

    /** @type {Array<import('../shared/types.js').Sentence & {unitId:string}>} sparse, indexed by Sentence.index */
    this.sentences = [];
    /** @type {Map<string, {kind:string, label:string|null, meta:object}>} */
    this.unitMeta = new Map();

    this.cursor = -1;
    this.status = 'extracting';
    this.rate = persistence.getCachedSettings()?.rate ?? 1.0;
    this.exhausted = false;
    this.totalSentences = 0;
    this.error = null;
    this.destroyed = false;

    /** @type {Map<number, number|null>} index -> durationHintMs, cleared once consumed */
    this.durationHints = new Map();

    // X/Twitter-only resume anchors (see shared_contracts §7).
    this.lastStatusId = null;
    /** @type {string[]} */
    this.readStatusIds = [];

    this.prefetchQueue = new PrefetchQueue(this);
  }

  /** @param {object} envelope */
  sendToTab(envelope) {
    if (this.tabId == null) return;
    safeSendTabMessage(this.tabId, envelope);
  }

  /**
   * Store freshly-arrived units' sentences into the flat, index-keyed array
   * and record per-unit metadata. Indices are assigned monotonically by
   * content/main.js and never reused, so appends are simple in-place writes.
   * @param {import('../shared/types.js').ReadUnit[]} units
   */
  ingestUnits(units) {
    for (const unit of units || []) {
      this.unitMeta.set(unit.id, { kind: unit.kind, label: unit.label, meta: unit.meta });
      for (const sentence of unit.sentences || []) {
        this.sentences[sentence.index] = { ...sentence, unitId: unit.id };
        if (sentence.index + 1 > this.totalSentences) {
          this.totalSentences = sentence.index + 1;
        }
      }
    }
  }

  /**
   * @param {import('../shared/types.js').StartReadingPayload} payload
   */
  applyStartReading(payload) {
    this.contentKey = payload.contentKey;
    this.contentHash = payload.contentHash;
    this.kind = payload.kind;
    this.title = payload.title;
    this.url = payload.url;
    this.exhausted = !!payload.exhausted;

    this.ingestUnits(payload.units);
    this.cursor = payload.startIndex ?? 0;

    this.sendToTab(
      makeEnvelope(MSG.SESSION_STARTED, TARGET.CONTENT, this.sessionId, {
        sessionId: this.sessionId,
        contentKey: this.contentKey,
        startIndex: this.cursor,
        totalSentences: this.totalSentences,
      })
    );
  }

  /**
   * Best-effort resume: apply a stored progress record on top of a
   * just-started session, if it still applies.
   * @param {import('../shared/types.js').ProgressRecord|null} record
   */
  tryApplyResume(record) {
    if (!record) return;

    if (this.kind === 'article') {
      if (!persistence.isArticleResumeValid(this, record)) {
        this.sendToTab(
          makeEnvelope(MSG.TOAST, TARGET.CONTENT, this.sessionId, {
            level: 'info',
            message: 'This article changed since you last read it — starting from the top.',
          })
        );
        return;
      }
      const clamped = Math.min(Math.max(record.index || 0, 0), Math.max(this.totalSentences - 1, 0));
      this.cursor = clamped;
      return;
    }

    if (this.kind === 'twitter') {
      this.lastStatusId = record.lastStatusId || null;
      this.readStatusIds = Array.isArray(record.readStatusIds) ? record.readStatusIds.slice(-MAX_READ_STATUS_IDS) : [];

      if (this.lastStatusId) {
        const idx = this.sentences.findIndex(
          (s) => s && this.unitMeta.get(s.unitId)?.meta?.statusId === this.lastStatusId
        );
        if (idx !== -1) {
          this.cursor = Math.min(idx + 1, Math.max(this.totalSentences - 1, 0));
        }
      }
    }
  }

  /** Kick off prefetching + audio playback for the current cursor. */
  beginPlayback() {
    this.status = 'buffering';
    this.emitPlaybackState();

    this.prefetchQueue.start(this.cursor);
    offscreenManager.ensureOffscreenReady(this.sessionId, this.rate, this.cursor).then(() => {
      offscreenManager.sendToOffscreen(makeEnvelope(MSG.AUDIO_PLAY, TARGET.OFFSCREEN, this.sessionId, {}));
    });

    persistence.scheduleProgressSave(this);
  }

  /**
   * @param {import('../shared/types.js').AppendUnitsPayload} payload
   */
  appendUnits(payload) {
    this.ingestUnits(payload.units);
    this.exhausted = !!payload.exhausted;
    this.prefetchQueue.onUnitsAppended();
  }

  // --- CONTROL_* transitions -------------------------------------------------

  handleControlPlay() {
    if (this.status === 'stopped' || this.status === 'error' || this.destroyed) return;
    offscreenManager.sendToOffscreen(makeEnvelope(MSG.AUDIO_PLAY, TARGET.OFFSCREEN, this.sessionId, {}));
    if (this.status !== 'buffering') this.status = 'playing';
    this.emitPlaybackState();
  }

  handleControlPause() {
    if (this.status === 'stopped' || this.status === 'error' || this.destroyed) return;
    this.status = 'paused';
    offscreenManager.sendToOffscreen(makeEnvelope(MSG.AUDIO_PAUSE, TARGET.OFFSCREEN, this.sessionId, {}));
    this.emitPlaybackState();
    persistence.flushProgress(this);
  }

  handleControlToggle() {
    if (this.status === 'playing' || this.status === 'buffering') {
      this.handleControlPause();
    } else {
      this.handleControlPlay();
    }
  }

  /**
   * @param {'user-stop'|'completed'|'navigation'|'error'} [reason]
   */
  handleControlStop(reason = 'user-stop') {
    this.endSession(reason);
  }

  /**
   * @param {import('../shared/types.js').ControlSkipPayload} payload
   */
  handleControlSkip(payload) {
    const direction = payload?.direction;
    const granularity = payload?.granularity;

    let newIndex;
    if (granularity === 'unit') {
      newIndex = this.findUnitBoundaryIndex(direction);
    } else {
      newIndex = direction === 'next' ? this.cursor + 1 : this.cursor - 1;
    }

    this.seekTo(Math.max(0, newIndex));
  }

  /**
   * @param {import('../shared/types.js').ControlSeekPayload} payload
   */
  handleControlSeek(payload) {
    const idx = Math.max(0, Math.floor(Number(payload?.index)) || 0);
    this.seekTo(idx);
  }

  /**
   * @param {import('../shared/types.js').ControlSetRatePayload} payload
   */
  handleControlSetRate(payload) {
    this.rate = clampRate(payload?.rate);
    offscreenManager.sendToOffscreen(
      makeEnvelope(MSG.AUDIO_SET_RATE, TARGET.OFFSCREEN, this.sessionId, { rate: this.rate })
    );
    persistence.updateSetting('rate', this.rate);
    this.emitPlaybackState();
    persistence.scheduleProgressSave(this);
  }

  /**
   * The exact skip/seek sequence from shared_contracts §9: mutate cursor ->
   * AUDIO_FLUSH{fromIndex} -> reset prefetch -> re-enqueue.
   * @param {number} newIndex
   */
  seekTo(newIndex) {
    // Seeking past the end of finished content would leave the prefetch queue
    // waiting on a sentence that can never arrive (`exhausted` means no
    // APPEND_UNITS is coming), stranding the session in 'buffering' forever.
    let target = Math.max(0, newIndex);
    if (this.exhausted && this.totalSentences > 0) {
      target = Math.min(target, this.totalSentences - 1);
    }

    this.cursor = target;

    offscreenManager.sendToOffscreen(
      makeEnvelope(MSG.AUDIO_FLUSH, TARGET.OFFSCREEN, this.sessionId, { fromIndex: target })
    );

    this.prefetchQueue.start(target);

    if (this.status !== 'paused' && this.status !== 'stopped') {
      this.status = 'buffering';
    }

    this.emitPlaybackState();
    persistence.scheduleProgressSave(this);
  }

  /**
   * Find the first sentence index belonging to the next/previous ReadUnit
   * relative to the current cursor (used for granularity:'unit' skips).
   * @param {'next'|'prev'} direction
   * @returns {number}
   */
  findUnitBoundaryIndex(direction) {
    const currentSentence = this.sentences[this.cursor];
    const currentUnitId = currentSentence?.unitId;

    if (direction === 'next') {
      for (let i = this.cursor + 1; i < this.sentences.length; i++) {
        const s = this.sentences[i];
        if (s && s.unitId !== currentUnitId) return i;
      }
      return this.cursor + 1; // nothing else loaded yet; fall back to next sentence
    }

    let i = this.cursor - 1;
    while (i >= 0 && this.sentences[i]?.unitId === currentUnitId) i -= 1;
    if (i < 0) return 0;

    const prevUnitId = this.sentences[i].unitId;
    while (i > 0 && this.sentences[i - 1]?.unitId === prevUnitId) i -= 1;
    return Math.max(0, i);
  }

  // --- offscreen -> background events ---------------------------------------

  /**
   * @param {import('../shared/types.js').SentenceStartedPayload} payload
   */
  handleSentenceStarted(payload) {
    if (payload.index < this.cursor) return; // stale/out-of-order, defensive no-op

    this.cursor = payload.index;
    const sentence = this.sentences[payload.index];
    const unit = sentence ? this.unitMeta.get(sentence.unitId) : null;

    if (this.status !== 'paused' && this.status !== 'stopped') {
      this.status = 'playing';
    }
    this.emitPlaybackState();

    this.sendToTab(
      makeEnvelope(MSG.HIGHLIGHT_SENTENCE, TARGET.CONTENT, this.sessionId, {
        sentenceId: payload.sentenceId,
        unitId: sentence?.unitId ?? null,
        index: payload.index,
        text: sentence?.text ?? '',
        unitLabel: unit?.label ?? null,
        durationMs: this.durationHints.get(payload.index) ?? null,
      })
    );

    if (this.kind === 'twitter' && unit?.meta?.statusId) {
      this.lastStatusId = unit.meta.statusId;
      if (!this.readStatusIds.includes(unit.meta.statusId)) {
        this.readStatusIds.push(unit.meta.statusId);
        if (this.readStatusIds.length > MAX_READ_STATUS_IDS) this.readStatusIds.shift();
      }
    }

    persistence.scheduleProgressSave(this);
  }

  /**
   * @param {import('../shared/types.js').SentenceEndedPayload} payload
   */
  handleSentenceEnded(payload) {
    this.durationHints.delete(payload.index);
    this.prefetchQueue.onSentenceEnded(payload.index);
  }

  /**
   * @param {import('../shared/types.js').PlaybackTickPayload} _payload
   */
  handlePlaybackTick(_payload) {
    // PlaybackState has no currentTimeMs field to surface this through, and
    // nothing else in the contract consumes ticks background-side today.
  }

  /**
   * @param {import('../shared/types.js').QueueDrainedPayload} payload
   */
  handleQueueDrained(payload) {
    this.prefetchQueue.handleQueueDrained(payload?.lastIndex);
  }

  /**
   * @param {import('../shared/types.js').BufferLowPayload} payload
   */
  handleBufferLow(payload) {
    this.prefetchQueue.handleBufferLow(payload?.queuedCount);
  }

  /**
   * @param {import('../shared/types.js').PlaybackErrorPayload} payload
   */
  handlePlaybackError(payload) {
    log.warn('PLAYBACK_ERROR', payload);
    this.sendToTab(
      makeEnvelope(MSG.TOAST, TARGET.CONTENT, this.sessionId, {
        level: 'warn',
        message: 'A playback error occurred; skipping ahead.',
        code: payload?.code,
      })
    );
    // Frees the capacity that index held and, via the dead-index tracking
    // in PrefetchQueue, makes sure offscreen doesn't end up permanently
    // stuck waiting for a sentence that just errored out.
    this.durationHints.delete(payload?.index);
    this.prefetchQueue.onPlaybackError(payload?.index);
  }

  handleHighlightResult(payload) {
    if (!payload?.ok) {
      log.debug('HIGHLIGHT_RESULT not ok', payload?.reason, 'for', payload?.sentenceId);
    }
  }

  // --- state emission ---------------------------------------------------

  /** @returns {import('../shared/types.js').PlaybackState} */
  getPlaybackState() {
    const sentence = this.cursor >= 0 ? this.sentences[this.cursor] : null;
    const unit = sentence ? this.unitMeta.get(sentence.unitId) : null;

    return {
      sessionId: this.sessionId,
      status: this.status,
      index: this.cursor,
      sentenceId: sentence?.id ?? null,
      unitId: sentence?.unitId ?? null,
      unitLabel: unit?.label ?? null,
      currentText: sentence?.text ?? '',
      totalSentences: this.totalSentences,
      exhausted: this.exhausted,
      rate: this.rate,
      queuedAhead: this.prefetchQueue.queuedAhead,
      contentKey: this.contentKey,
      kind: this.kind,
      error: this.error,
    };
  }

  emitPlaybackState() {
    this.sendToTab(makeEnvelope(MSG.PLAYBACK_STATE, TARGET.CONTENT, this.sessionId, this.getPlaybackState()));
  }

  /**
   * @param {'user-stop'|'completed'|'navigation'|'error'} reason
   * @param {string} [message]
   */
  endSession(reason, message) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.status = 'stopped';

    this.prefetchQueue.stop();
    offscreenManager.sendToOffscreen(makeEnvelope(MSG.AUDIO_STOP, TARGET.OFFSCREEN, this.sessionId, {}));
    offscreenManager.closeOffscreenDocument();

    persistence.flushProgress(this).catch((err) => log.error('flushProgress on end failed', err));
    persistence.clearSessionSnapshot().catch((err) => log.error('clearSessionSnapshot on end failed', err));
    persistence.cancelProgressSave(this.sessionId);

    // Omitting sentenceId clears every highlight (shared_contracts §3).
    this.sendToTab(makeEnvelope(MSG.CLEAR_HIGHLIGHT, TARGET.CONTENT, this.sessionId, {}));
    this.sendToTab(makeEnvelope(MSG.SESSION_ENDED, TARGET.CONTENT, this.sessionId, { reason, message }));

    if (current === this) current = null;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton session + exported handlers (service-worker calls these)
// ---------------------------------------------------------------------------

/** @type {Session|null} */
let current = null;

/**
 * Ends whatever session is active (if any) and reserves a new sessionId for
 * `tabId`, to be sent along with ACTIVATE. Call this BEFORE sending ACTIVATE.
 * @param {number} tabId
 * @returns {string} the new sessionId
 */
export function prepareNewSession(tabId) {
  if (current) {
    current.endSession('navigation');
  }
  const sessionId = genSessionId();
  current = new Session({ sessionId, tabId });
  return sessionId;
}

/**
 * Call if sending ACTIVATE for a just-prepared session fails entirely (tab
 * gone, injection failed) so we don't leave a permanently 'extracting' ghost
 * session around.
 * @param {string} sessionId
 */
export function abortPendingSession(sessionId) {
  if (current && current.sessionId === sessionId) {
    current = null;
  }
}

/**
 * @param {string|null} incomingSessionId
 * @param {number|null} [tabId]
 * @returns {Session|null}
 */
function requireCurrent(incomingSessionId, tabId) {
  if (!current) return null;
  if (incomingSessionId != null && current.sessionId !== incomingSessionId) return null;
  if (tabId != null && current.tabId !== tabId) return null;
  return current;
}

/**
 * @param {import('../shared/types.js').StartReadingPayload} payload
 * @param {number|null} tabId
 * @param {string|null} incomingSessionId
 */
export function handleStartReading(payload, tabId, incomingSessionId) {
  const session = requireCurrent(incomingSessionId, tabId);
  if (!session) {
    log.warn('START_READING for unknown/stale session, ignoring', incomingSessionId, tabId);
    return;
  }

  session.applyStartReading(payload);

  const pending = tabId != null ? persistence.getPendingResume(tabId) : null;
  if (pending) {
    session.tryApplyResume(pending.record);
    persistence.clearPendingResume(tabId);
  }

  session.beginPlayback();
}

/**
 * @param {import('../shared/types.js').AppendUnitsPayload} payload
 * @param {string|null} incomingSessionId
 */
export function handleAppendUnits(payload, incomingSessionId) {
  requireCurrent(incomingSessionId)?.appendUnits(payload);
}

export function handleControlPlay(incomingSessionId) {
  requireCurrent(incomingSessionId)?.handleControlPlay();
}

export function handleControlPause(incomingSessionId) {
  requireCurrent(incomingSessionId)?.handleControlPause();
}

export function handleControlToggle(incomingSessionId) {
  requireCurrent(incomingSessionId)?.handleControlToggle();
}

/**
 * @param {string|null} incomingSessionId
 * @param {'user-stop'|'completed'|'navigation'|'error'} [reason]
 */
export function handleControlStop(incomingSessionId, reason = 'user-stop') {
  requireCurrent(incomingSessionId)?.handleControlStop(reason);
}

export function handleControlSkip(payload, incomingSessionId) {
  requireCurrent(incomingSessionId)?.handleControlSkip(payload);
}

export function handleControlSeek(payload, incomingSessionId) {
  requireCurrent(incomingSessionId)?.handleControlSeek(payload);
}

export function handleControlSetRate(payload, incomingSessionId) {
  requireCurrent(incomingSessionId)?.handleControlSetRate(payload);
}

export function handleHighlightResult(payload, incomingSessionId) {
  requireCurrent(incomingSessionId)?.handleHighlightResult(payload);
}

export function handleSentenceStarted(payload) {
  current?.handleSentenceStarted(payload);
}

export function handleSentenceEnded(payload) {
  current?.handleSentenceEnded(payload);
}

export function handlePlaybackTick(payload) {
  current?.handlePlaybackTick(payload);
}

export function handleQueueDrained(payload) {
  current?.handleQueueDrained(payload);
}

export function handleBufferLow(payload) {
  current?.handleBufferLow(payload);
}

export function handlePlaybackError(payload) {
  current?.handlePlaybackError(payload);
}

/**
 * REQUEST_STATE handler. Ignores sessionId (a fresh widget boot legitimately
 * doesn't know one yet) but scopes to the requesting tab when known.
 * @param {number|null} tabId
 * @returns {import('../shared/types.js').PlaybackState}
 */
export function getPlaybackStateFor(tabId) {
  if (current && (tabId == null || current.tabId === tabId)) {
    return current.getPlaybackState();
  }
  return idlePlaybackState();
}

/**
 * @param {number} tabId
 * @param {'user-stop'|'completed'|'navigation'|'error'} reason
 */
export function endSessionForTab(tabId, reason) {
  if (current && current.tabId === tabId) {
    current.endSession(reason);
  }
}

/** Immediate progress flush for the active session (chrome.runtime.onSuspend). */
export function flushActiveSessionProgress() {
  if (current) {
    persistence.flushProgress(current).catch((err) => log.error('flush on suspend failed', err));
  }
}
