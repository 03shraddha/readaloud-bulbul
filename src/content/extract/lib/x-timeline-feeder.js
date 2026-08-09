/**
 * src/content/extract/lib/x-timeline-feeder.js
 *
 * Owns everything about turning "more of the timeline" into TweetData:
 *  - human-paced incremental autoscroll (jittered X_AUTOSCROLL_STEP_PX /
 *    X_AUTOSCROLL_MIN_INTERVAL_MS steps),
 *  - a MutationObserver over the timeline container so newly-mounted
 *    articles are noticed promptly,
 *  - an `emittedStatusIds` Set so re-scans never double-emit a tweet
 *    (virtualization means the SAME article node gets reused for different
 *    tweets as the user scrolls, and old nodes get unmounted/recycled —
 *    dedupe must be by status id, never by node identity),
 *  - the X_MAX_UNITS_PER_BATCH cap,
 *  - the EXTRACT_MORE_TIMEOUT_MS hard bail-out.
 *
 * Strictly read-only DOM access: only scrolls + reads what X already
 * rendered. No X API/GraphQL calls, ever.
 */

import {
  X_AUTOSCROLL_STEP_PX,
  X_AUTOSCROLL_MIN_INTERVAL_MS,
  X_MAX_UNITS_PER_BATCH,
  EXTRACT_MORE_TIMEOUT_MS,
} from '../../../shared/constants.js';
import { SELECTORS, queryAll } from './x-selectors.js';
import { parseTweet, extractStatusId } from './x-tweet-parser.js';

/** Consecutive stale scroll attempts (no new height, no new tweets) before we call it exhausted. */
const STALE_SCROLL_LIMIT = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** +/- 25% jitter so the scroll cadence doesn't look robotic. */
function jitter(baseMs, spreadRatio = 0.25) {
  const spread = baseMs * spreadRatio;
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * spread);
}

/**
 * @param {{log?: {debug:Function, warn:Function, error:Function}}} [opts]
 */
export function createTimelineFeeder({ log } = {}) {
  const emittedStatusIds = new Set();
  let observer = null;
  let disposed = false;

  function allArticles() {
    return queryAll(document, SELECTORS.article);
  }

  /** Articles currently mounted whose status id hasn't been emitted yet. */
  function unseenArticles() {
    return allArticles().filter((el) => {
      const info = extractStatusId(el);
      return !!info && !emittedStatusIds.has(info.statusId);
    });
  }

  function init() {
    if (observer || disposed) return;
    const container = document.querySelector('main[role="main"]') || document.body;
    try {
      observer = new MutationObserver(() => {
        // Intentionally a no-op: extractMore()'s loop polls the DOM directly
        // between scroll steps. The observer's only job is to exist so
        // dispose() has something concrete to disconnect on SPA navigation,
        // and so future refinement can react to mutations without touching
        // this module's public shape.
      });
      observer.observe(container, { childList: true, subtree: true });
    } catch (err) {
      log?.warn?.('[x-timeline-feeder] MutationObserver setup failed', err);
    }
  }

  async function scrollStep() {
    try {
      window.scrollBy({ top: jitter(X_AUTOSCROLL_STEP_PX), left: 0, behavior: 'auto' });
    } catch {
      /* scrolling isn't essential to correctness, just to revealing more DOM */
    }
    await sleep(jitter(X_AUTOSCROLL_MIN_INTERVAL_MS));
  }

  /**
   * Parses up to `limit` currently-unseen articles, marking each as emitted
   * BEFORE the (possibly show-more-clicking, i.e. async) parse so a
   * concurrent re-scan can never double-emit the same status id.
   * @param {number} limit
   * @returns {Promise<import('./x-tweet-parser.js').TweetData[]>}
   */
  async function parseNewOnes(limit) {
    const collected = [];
    for (const el of unseenArticles()) {
      if (collected.length >= limit) break;
      const info = extractStatusId(el);
      if (!info || emittedStatusIds.has(info.statusId)) continue;
      emittedStatusIds.add(info.statusId);
      try {
        const data = await parseTweet(el, { log });
        if (data) {
          collected.push(data);
        }
      } catch (err) {
        log?.warn?.('[x-timeline-feeder] failed to parse tweet', err);
      }
    }
    return collected;
  }

  /**
   * First batch: whatever is already mounted, no scrolling.
   * @returns {Promise<import('./x-tweet-parser.js').TweetData[]>}
   */
  async function extractInitialBatch() {
    return parseNewOnes(X_MAX_UNITS_PER_BATCH);
  }

  /**
   * @param {'buffer-low'|'end-of-list'} _reason
   * @returns {Promise<{tweetDataList: import('./x-tweet-parser.js').TweetData[], exhausted: boolean, timedOut: boolean}>}
   */
  async function extractMoreCore(_reason) {
    const deadline = Date.now() + EXTRACT_MORE_TIMEOUT_MS;
    const collected = [];
    let staleAttempts = 0;
    let lastScrollHeight = document.documentElement.scrollHeight;

    while (Date.now() < deadline && collected.length < X_MAX_UNITS_PER_BATCH) {
      const fresh = await parseNewOnes(X_MAX_UNITS_PER_BATCH - collected.length);
      collected.push(...fresh);

      if (collected.length >= X_MAX_UNITS_PER_BATCH) break;
      if (Date.now() >= deadline) break;

      await scrollStep();

      const newScrollHeight = document.documentElement.scrollHeight;
      if (newScrollHeight <= lastScrollHeight && fresh.length === 0) {
        staleAttempts++;
      } else {
        staleAttempts = 0;
      }
      lastScrollHeight = newScrollHeight;

      if (staleAttempts >= STALE_SCROLL_LIMIT) {
        // True end of a finite list (search results, a profile, a list) —
        // several scroll attempts produced neither new height nor new tweets.
        return { tweetDataList: collected, exhausted: true, timedOut: false };
      }
    }

    return { tweetDataList: collected, exhausted: false, timedOut: Date.now() >= deadline };
  }

  /**
   * Hard wall-clock bail-out: if extractMoreCore somehow doesn't resolve
   * within EXTRACT_MORE_TIMEOUT_MS, resolve empty rather than let the caller
   * (content/main.js's REQUEST_MORE_UNITS handler) hang.
   * @param {'buffer-low'|'end-of-list'} reason
   */
  async function extractMore(reason) {
    if (disposed) {
      return { tweetDataList: [], exhausted: false, timedOut: false };
    }
    const core = extractMoreCore(reason);
    const hardTimeout = new Promise((resolve) => {
      setTimeout(() => resolve({ tweetDataList: [], exhausted: false, timedOut: true }), EXTRACT_MORE_TIMEOUT_MS);
    });
    return Promise.race([core, hardTimeout]);
  }

  function dispose() {
    disposed = true;
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        /* ignore */
      }
      observer = null;
    }
  }

  return {
    init,
    extractInitialBatch,
    extractMore,
    dispose,
    /** exposed for tests / diagnostics only */
    _emittedStatusIds: emittedStatusIds,
  };
}
