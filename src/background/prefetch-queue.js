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
import { audioCacheKey, getOrSynthesize, pruneInFlight, abortInFlight } from './audio-cache.js';

const log = createLogger('background:prefetch');

/** If REQUEST_MORE_UNITS goes unanswered this long, give up and end the session. */
const STALL_TIMEOUT_MS = 15000;

/** On a reset, requests this many sentences behind the new position keep
 * running (they finish into the audio cache, ready for a skip back). */
const KEEP_BEHIND = 2;

export class PrefetchQueue {
  /**
   * @param {import('./session.js').Session} session
   */
  constructor(session) {
    this.session = session;
    /** @type {Map<number, object>} index -> token of the launchFetch() call
     * that owns it. The token (not the index) identifies the call, so a
     * stale call from before a reset can never remove a newer call's entry. */
    this.inFlight = new Map();
    /** Bumped on every reset/stop. A launchFetch() that wakes up under a
     * different epoch was superseded: its audio still lands in the cache,
     * but it must not dispatch anything. */
    this.epoch = 0;
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
    /** Throttle "sentence could not be voiced" toasts to avoid pileup.
     * Counts consecutive skip failures; toast shows total after a delay. */
    this.skippedSentenceCount = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.skipToastTimer = null;
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
    this.abortAll(fromIndex);
    this.dispatched = [];
    this.deadIndices.clear();
    this.nextToFetch = fromIndex;
    this.expectedOffscreenCursor = fromIndex;
    this.awaitingMoreUnits = false;
    this.clearStallTimer();
    this.clearSkipToastTimer();
    this.skippedSentenceCount = 0;
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
    this.epoch += 1;
    this.inFlight.clear();
    abortInFlight(this.session.sessionId);
    this.dispatched = [];
    this.clearStallTimer();
  }

  /**
   * Forget every request this queue is waiting on and rebase around
   * `aroundIndex`. The HTTP requests themselves are NOT all aborted:
   * anything close to the new position keeps running and finishes into the
   * audio cache (see audio-cache.js), so a skip of one or two sentences
   * reuses work already on the wire instead of starting it again. Only
   * requests far from the new position are aborted.
   * @param {number} [aroundIndex]
   */
  abortAll(aroundIndex = this.nextToFetch) {
    this.epoch += 1;
    this.inFlight.clear();
    pruneInFlight(this.session.sessionId, aroundIndex - KEEP_BEHIND, aroundIndex + PREFETCH_AHEAD + 1);
  }

  /**
   * True when a selection-only read (Session.stopAfterIndex) has nothing
   * left to fetch: every sentence up to the bound was fetched or is dead.
   * @returns {boolean}
   */
  boundReached() {
    const bound = this.session.stopAfterIndex;
    return bound != null && this.nextToFetch > bound;
  }

  clearStallTimer() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  clearSkipToastTimer() {
    if (this.skipToastTimer) {
      clearTimeout(this.skipToastTimer);
      this.skipToastTimer = null;
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

    this.abortAll(resumeFrom);
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

    // Same reasoning for a selection-only read whose last sentence was the
    // dead one: the flush leaves offscreen empty and silent, so the
    // QUEUE_DRAINED that normally closes the selection never comes.
    if (this.boundReached()) {
      session.finishBoundedRead();
      return;
    }

    // The session cursor can still sit on (or before) the dead index: at
    // the first Play, or right after a seek, nothing has started yet to
    // move it. handleSentenceStarted() drops any index above the cursor
    // while the status is 'buffering', so leaving the cursor behind made
    // it drop every later sentence too. Audio played, but the widget stayed
    // on 'buffering' and the highlight never moved. Offscreen is waiting on
    // `resumeFrom` now, so that is where the cursor belongs.
    if (session.cursor <= idx) {
      session.cursor = resumeFrom;
      session.emitPlaybackState();
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

      // Selection-only read: never fetch past the last selected sentence.
      // Offscreen then runs dry there and reports QUEUE_DRAINED, which
      // handleQueueDrained() turns into a clean pause.
      if (session.stopAfterIndex != null && idx > session.stopAfterIndex) break;

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
    const epoch = this.epoch;
    const token = {};
    this.inFlight.set(idx, token);
    const release = () => {
      if (this.inFlight.get(idx) === token) this.inFlight.delete(idx);
    };
    const superseded = () => this.stopped || epoch !== this.epoch;

    try {
      const settings = persistence.getCachedSettings() || {};
      await offscreenManager.ensureOffscreenReady(session.sessionId, session.rate, session.cursor);

      // Cached audio returns at once; a request already on the wire for this
      // same sentence is joined, not repeated. See audio-cache.js.
      const result = await getOrSynthesize({
        key: audioCacheKey(sentence, settings),
        index: idx,
        owner: session.sessionId,
        synth: (signal) => synthesizeSentence({ sentence, settings, signal }),
      });

      release();
      if (superseded()) return; // dropped by a reset in the meantime

      // Synthesis is a multi-second network round trip, and Chrome closes an
      // idle AUDIO_PLAYBACK offscreen document out from under us — which is
      // easiest to hit during exactly this await, since a paused or buffering
      // session has no audio playing to keep the document alive. Re-check
      // instead of dispatching into a document that no longer exists:
      // safeSendRuntimeMessage would swallow the resulting "Receiving end
      // does not exist", but `idx` would still be pushed to `dispatched`,
      // where only a SENTENCE_ENDED can ever remove it — and that sentence's
      // audio no longer exists anywhere to end. queuedAhead would stay pinned
      // and fill() would never fetch again.
      await offscreenManager.ensureOffscreenReady(session.sessionId, session.rate, session.cursor);
      if (superseded()) return;
      if (session.offscreenWasReinitialized()) {
        // The replacement document's queue is empty and everything in
        // `dispatched` is unreachable. Rebuild from the playhead rather than
        // dispatching this one sentence into an otherwise-empty queue whose
        // cursor sits several indices behind it.
        session.reseedOffscreenAudio();
        return;
      }

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
          // Non-zero only when this is the sentence the reader paused inside
          // and its audio had to be sent again (the offscreen document was
          // closed during the pause). Offscreen then starts it at this
          // offset, not at the first word. See Session.resumeOffsetFor().
          startAtMs: session.resumeOffsetFor(idx),
        })
      );

      this.fill();
    } catch (err) {
      release();
      // Superseded by a skip/seek/stop, or aborted outright; not a real
      // failure of this sentence, so it must not be marked dead.
      if (superseded() || err?.aborted) return;

      log.warn(`synth failed for sentence ${sentence.id} (index ${idx}), skipping`, err?.message);

      // Throttle "skipped sentence" toasts to prevent pileup when multiple
      // sentences fail in quick succession (e.g., backend outage, rate limit).
      // Accumulate count and show a single toast after a brief delay.
      this.skippedSentenceCount++;
      this.clearSkipToastTimer();
      this.skipToastTimer = setTimeout(() => {
        const count = this.skippedSentenceCount;
        session.sendToTab(
          makeEnvelope(MSG.TOAST, TARGET.CONTENT, session.sessionId, {
            level: 'warn',
            message: count === 1
              ? 'Skipped a sentence that could not be voiced.'
              : `Skipped ${count} sentences that could not be voiced.`,
            code: err?.code,
          })
        );
        this.skippedSentenceCount = 0;
      }, 200); // Wait 200ms to batch multiple failures

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

    // The selection has been read to its last sentence: pause there. Must
    // come before the end-of-content check, or a selection that happens to
    // stop short of the last sentence would never be told apart from it.
    if (this.boundReached() && !this.isExhaustedPastEnd()) {
      session.finishBoundedRead();
      return;
    }

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
    // A selection-only read wants nothing past its bound, so a thin buffer
    // near that bound is expected. Asking for more units here would start a
    // scroll hunt on an X timeline for content the reader did not ask for.
    if (session.stopAfterIndex != null) return;
    if (!session.exhausted) {
      this.requestMoreUnits('buffer-low');
    }
  }
}
