/**
 * src/background/prefetch-queue.js
 *
 * Keeps PREFETCH_AHEAD synthesized sentences ahead of the playhead, with at
 * most TTS_CONCURRENCY requests in flight, dispatching each finished sentence
 * to the offscreen document as it completes (shared_contracts §9).
 *
 * One instance per Session (constructed by session.js and handed the Session
 * instance itself — duck-typed access to session.sentences / .exhausted /
 * .sessionId / .tabId / .rate / .status / .durationHints / .sendToTab /
 * .emitPlaybackState / .endSession, avoiding a circular module import).
 *
 * Failure handling: tts-client already retries retryable errors internally.
 * A non-retryable (or retry-exhausted) failure means that sentence index can
 * never be handed to the offscreen document — but the offscreen audio queue
 * (src/offscreen/audio-queue.js) plays strictly contiguous indices and will
 * simply idle forever waiting for one that never arrives. So a "skip" is not
 * a no-op here: we track dead indices and, once the offscreen playhead is
 * (or is about to be) blocked on one, proactively send AUDIO_FLUSH{fromIndex:
 * deadIndex+1} and re-enqueue from there — the same primitive used for
 * user-initiated skip/seek. `expectedOffscreenCursor` is a best-effort
 * mirror of which index the offscreen queue is currently waiting to play
 * next, kept in sync via SENTENCE_ENDED/PLAYBACK_ERROR events and every
 * flush we send.
 */

import { PREFETCH_AHEAD, TTS_CONCURRENCY } from '../shared/constants.js';
import { MSG, TARGET, makeEnvelope, safeSendTabMessage } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';
import { synthesizeSentence } from './tts-client.js';
import * as offscreenManager from './offscreen-manager.js';
import * as persistence from './persistence.js';

const log = createLogger('background:prefetch');

/** If REQUEST_MORE_UNITS goes unanswered this long, give up and end the session. */
const STALL_TIMEOUT_MS = 15000;

export class PrefetchQueue {
  /**
   * @param {import('./session.js').Session} session
   */
  constructor(session) {
    this.session = session;
    /** @type {Map<number, AbortController>} */
    this.inFlight = new Map();
    /** @type {number[]} indices dispatched to offscreen, not yet SENTENCE_ENDED */
    this.dispatched = [];
    /** @type {Set<number>} indices confirmed to never be synthesizable this session */
    this.deadIndices = new Set();
    this.nextToFetch = 0;
    /** Best-effort mirror of the index src/offscreen's AudioQueue is currently
     * playing-or-waiting-for next (see file header). */
    this.expectedOffscreenCursor = 0;
    this.awaitingMoreUnits = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.stallTimer = null;
    this.stopped = true;
  }

  /** @returns {number} sentences dispatched-or-in-flight ahead of the playhead */
  get queuedAhead() {
    return this.dispatched.length + this.inFlight.size;
  }

  /**
   * Abort everything in flight and rebase the fetch pointer. Used before
   * skip/seek/stop re-enqueueing (shared_contracts §9), and at session start.
   * @param {number} fromIndex
   */
  reset(fromIndex) {
    this.abortAll();
    this.dispatched = [];
    this.deadIndices.clear();
    this.nextToFetch = fromIndex;
    this.expectedOffscreenCursor = fromIndex;
    this.awaitingMoreUnits = false;
    this.clearStallTimer();
    this.stopped = false;
  }

  /**
   * @param {number} fromIndex
   */
  start(fromIndex) {
    this.reset(fromIndex);
    this.fill();
  }

  /** Abort everything and stop refilling (session stop/end). */
  stop() {
    this.stopped = true;
    this.abortAll();
    this.dispatched = [];
    this.clearStallTimer();
  }

  abortAll() {
    for (const controller of this.inFlight.values()) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    this.inFlight.clear();
  }

  clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /** Called by session.js after APPEND_UNITS is ingested. */
  onUnitsAppended() {
    this.awaitingMoreUnits = false;
    this.clearStallTimer();
    this.fill();
  }

  /**
   * Called by session.js on SENTENCE_ENDED: frees the capacity that sentence
   * held, advances our mirror of the offscreen playhead, and — if the very
   * next index is already known dead — proactively skips past it rather
   * than waiting for a promotion that will never happen.
   * @param {number} index
   */
  onSentenceEnded(index) {
    this.dispatched = this.dispatched.filter((i) => i !== index);
    this.expectedOffscreenCursor = index + 1;

    if (this.deadIndices.has(this.expectedOffscreenCursor)) {
      this.skipDeadIndex(this.expectedOffscreenCursor);
      return;
    }
    this.fill();
  }

  /**
   * Called by session.js on PLAYBACK_ERROR. Whether this was the actively
   * playing item (offscreen already advanced past it, same as an ended
   * sentence) or a preloaded-but-not-yet-current item (offscreen's playhead
   * hasn't reached it yet), marking it dead + deferring to the same
   * expectedOffscreenCursor check handles both: if it *is* the index
   * offscreen is waiting on right now, we skip immediately; otherwise the
   * fix-up happens naturally once SENTENCE_ENDED for the prior index arrives.
   * @param {number} index
   */
  onPlaybackError(index) {
    if (typeof index !== 'number') return;
    this.deadIndices.add(index);
    this.dispatched = this.dispatched.filter((i) => i !== index);

    if (index === this.expectedOffscreenCursor) {
      this.skipDeadIndex(index);
    } else {
      this.fill();
    }
  }

  /**
   * offscreen is confirmed to be blocked waiting for `idx`, which will never
   * arrive. Flush it out of the picture (fromIndex: idx+1 — the same
   * skip/seek primitive from shared_contracts §9) and re-enqueue from there.
   * @param {number} idx
   */
  skipDeadIndex(idx) {
    const session = this.session;
    const resumeFrom = idx + 1;

    offscreenManager.sendToOffscreen(
      makeEnvelope(MSG.AUDIO_FLUSH, TARGET.OFFSCREEN, session.sessionId, { fromIndex: resumeFrom })
    );

    this.abortAll();
    // AUDIO_FLUSH drops everything offscreen was holding, including whatever
    // was playing, so no dispatched index will ever report SENTENCE_ENDED —
    // keeping any of them here would permanently inflate queuedAhead and
    // starve fill().
    this.dispatched = [];
    this.nextToFetch = resumeFrom;
    this.expectedOffscreenCursor = resumeFrom;
    this.awaitingMoreUnits = false;
    this.clearStallTimer();

    // The dead index we just skipped past may have been the LAST sentence of
    // an already-exhausted session. offscreen's AudioQueue.flush() clears its
    // queue down to empty in that case but — unlike a sentence actually
    // reaching its natural end — never emits QUEUE_DRAINED, so
    // handleQueueDrained()'s completion check below would never get a chance
    // to run and the session would sit frozen forever with cursor sitting at
    // totalSentences. Run that identical completion check here explicitly.
    if (this.isExhaustedPastEnd()) {
      session.endSession('completed', 'Last sentence could not be voiced.');
      return;
    }

    this.fill();
  }

  /**
   * Top up in-flight/dispatched work toward PREFETCH_AHEAD, at most
   * TTS_CONCURRENCY concurrent HTTP requests. Never (re-)attempts a
   * confirmed-dead index.
   */
  fill() {
    if (this.stopped) return;
    const session = this.session;

    while (this.inFlight.size < TTS_CONCURRENCY && this.queuedAhead < PREFETCH_AHEAD) {
      while (this.deadIndices.has(this.nextToFetch)) this.nextToFetch += 1;

      const idx = this.nextToFetch;
      const sentence = session.sentences[idx];

      if (!sentence) {
        if (!session.exhausted) {
          const reason = idx >= session.totalSentences ? 'end-of-list' : 'buffer-low';
          this.requestMoreUnits(reason);
        }
        break;
      }

      this.nextToFetch += 1;
      this.launchFetch(idx, sentence);
    }
  }

  /**
   * Ask content for more units and arm the 15s stall timeout.
   * @param {'buffer-low'|'end-of-list'} reason
   */
  requestMoreUnits(reason) {
    if (this.awaitingMoreUnits) return;
    this.awaitingMoreUnits = true;

    const session = this.session;
    safeSendTabMessage(
      session.tabId,
      makeEnvelope(MSG.REQUEST_MORE_UNITS, TARGET.CONTENT, session.sessionId, {
        reason,
        queuedAhead: this.queuedAhead,
      })
    );

    if (session.status !== 'paused' && session.status !== 'stopped') {
      session.status = 'buffering';
      session.emitPlaybackState();
    }

    this._armStallTimer();
  }

  /**
   * (Re-)arms the 15s stall timeout that ends the session if
   * REQUEST_MORE_UNITS goes unanswered. Shared by requestMoreUnits() and
   * rearmStallTimerIfAwaiting() (called from session.js on resume).
   */
  _armStallTimer() {
    const session = this.session;
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;

      // A paused session is not broken -- the user may just have stepped
      // away. Ending it here would silently kill a session that was doing
      // nothing wrong except sitting paused for >15s. Defer: leave
      // awaitingMoreUnits set and let rearmStallTimerIfAwaiting() (called
      // from session.js's handleControlPlay on resume) pick this back up
      // with a fresh timeout, so a genuinely-never-arriving response can
      // still eventually end the session once playback actually resumes.
      if (session.status === 'paused') {
        log.debug(`stall timeout fired while paused (session ${session.sessionId}); deferring to resume`);
        return;
      }

      log.warn(`stall timeout waiting for more units (session ${session.sessionId}); ending as completed`);
      session.endSession('completed', 'No more content arrived.');
    }, STALL_TIMEOUT_MS);
  }

  /**
   * Called by session.js's handleControlPlay when resuming from pause: if a
   * REQUEST_MORE_UNITS is still outstanding and its stall timer was deferred
   * while paused (see _armStallTimer()), re-arm a fresh one now that the
   * session is live again. No-op if nothing is outstanding, the queue is
   * stopped, or a timer is already ticking.
   */
  rearmStallTimerIfAwaiting() {
    if (!this.awaitingMoreUnits || this.stopped || this.stallTimer) return;
    this._armStallTimer();
  }

  /**
   * @param {number} idx
   * @param {import('../shared/types.js').Sentence} sentence
   */
  async launchFetch(idx, sentence) {
    const session = this.session;
    const controller = new AbortController();
    this.inFlight.set(idx, controller);

    try {
      const settings = persistence.getCachedSettings() || {};
      await offscreenManager.ensureOffscreenReady(session.sessionId, session.rate, session.cursor);

      const result = await synthesizeSentence({ sentence, settings, signal: controller.signal });

      this.inFlight.delete(idx);
      if (this.stopped || controller.signal.aborted) return; // dropped by a reset in the meantime

      this.dispatched.push(idx);
      session.durationHints.set(idx, result.durationMs ?? null);

      await offscreenManager.sendToOffscreen(
        makeEnvelope(MSG.SENTENCE_AUDIO_READY, TARGET.OFFSCREEN, session.sessionId, {
          sentenceId: sentence.id,
          index: idx,
          audioBase64: result.audioBase64,
          mimeType: result.mimeType,
          sampleRate: result.sampleRate,
          durationHintMs: result.durationMs ?? null,
        })
      );

      this.fill();
    } catch (err) {
      this.inFlight.delete(idx);
      if (err?.aborted) return; // aborted due to skip/seek/stop; not a real failure

      log.warn(`synth failed for sentence ${sentence.id} (index ${idx}), skipping`, err?.message);
      session.sendToTab(
        makeEnvelope(MSG.TOAST, TARGET.CONTENT, session.sessionId, {
          level: 'warn',
          message: 'Skipped a sentence that could not be voiced.',
          code: err?.code,
        })
      );

      if (this.stopped) return;
      this.deadIndices.add(idx);

      if (idx === this.expectedOffscreenCursor) {
        this.skipDeadIndex(idx);
      } else {
        this.fill();
      }
    }
  }

  /**
   * True once there is nothing left this queue could ever fetch: content is
   * exhausted (no more APPEND_UNITS coming, see Session.exhausted) and
   * nextToFetch has already reached the end of all known sentences. Shared
   * by handleQueueDrained() (the "last sentence finished playing normally"
   * completion path) and skipDeadIndex() (the "last sentence turned out to
   * be unplayable" completion path) — both need the identical check.
   * @returns {boolean}
   */
  isExhaustedPastEnd() {
    return this.session.exhausted && this.nextToFetch >= this.session.totalSentences;
  }

  /**
   * offscreen -> background QUEUE_DRAINED: everything queued has finished
   * playing. If we have nothing left to give it and content is exhausted,
   * the session is done; otherwise ask for more and enter 'buffering'.
   * @param {number} lastIndex
   */
  handleQueueDrained(lastIndex) {
    const session = this.session;
    if (this.dispatched.length > 0 || this.inFlight.size > 0) return; // more is already on the way

    if (this.isExhaustedPastEnd()) {
      session.endSession('completed');
      return;
    }

    if (!session.exhausted) {
      this.requestMoreUnits('end-of-list');
    }
  }

  /**
   * offscreen -> background BUFFER_LOW: queue is getting thin.
   * @param {number} queuedCount
   */
  handleBufferLow(queuedCount) {
    const session = this.session;
    if (!session.exhausted) {
      this.requestMoreUnits('buffer-low');
    }
  }
}
