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
  X_EXTRACT_MORE_MAX_SCROLL_PX,
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

  /** @returns {Promise<number>} the (jittered) distance actually asked to scroll, for cumulative-cap tracking. */
  async function scrollStep() {
    const distance = jitter(X_AUTOSCROLL_STEP_PX);
    try {
      window.scrollBy({ top: distance, left: 0, behavior: 'auto' });
    } catch {
      /* scrolling isn't essential to correctness, just to revealing more DOM */
    }
    await sleep(jitter(X_AUTOSCROLL_MIN_INTERVAL_MS));
    return distance;
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
   * @param {() => boolean} isAbandoned - true once the caller (extractMore())
   *   has already resolved via the hard timeout below and stopped waiting on
   *   this call. This function keeps running after that (a bare `await`
   *   can't be cancelled), so it must check this itself to stop scrolling
   *   promptly instead of continuing to walk toward the timeout it already
   *   lost the race against.
   * @returns {Promise<{tweetDataList: import('./x-tweet-parser.js').TweetData[], exhausted: boolean, timedOut: boolean}>}
   */
  async function extractMoreCore(_reason, isAbandoned) {
    const startScrollY = window.scrollY;
    const deadline = Date.now() + EXTRACT_MORE_TIMEOUT_MS;
    const collected = [];
    let staleAttempts = 0;
    let scrolledPx = 0;
    let lastScrollHeight = document.documentElement.scrollHeight;
    let exhausted = false;

    while (
      Date.now() < deadline &&
      collected.length < X_MAX_UNITS_PER_BATCH &&
      scrolledPx < X_EXTRACT_MORE_MAX_SCROLL_PX &&
      !disposed &&
      !isAbandoned()
    ) {
      const fresh = await parseNewOnes(X_MAX_UNITS_PER_BATCH - collected.length);
      collected.push(...fresh);

      if (collected.length >= X_MAX_UNITS_PER_BATCH) break;
      if (Date.now() >= deadline || disposed || isAbandoned()) break;

      scrolledPx += await scrollStep();

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
        exhausted = true;
        break;
      }
    }

    // A hunt that came back with nothing found has no content to show for
    // the distance it travelled -- restoring the pre-hunt position leaves
    // the reader exactly where they were instead of somewhere down the
    // timeline they never asked to see, whether that hunt stopped because
    // it hit the deadline, the X_EXTRACT_MORE_MAX_SCROLL_PX cap, disposal,
    // or abandonment by the hard timeout below.
    if (collected.length === 0) {
      try {
        window.scrollTo({ top: startScrollY, left: 0, behavior: 'auto' });
      } catch {
        /* ignore */
      }
    }

    return { tweetDataList: collected, exhausted, timedOut: !exhausted && Date.now() >= deadline };
  }

  /**
   * Hard wall-clock bail-out: if extractMoreCore somehow doesn't resolve
   * within EXTRACT_MORE_TIMEOUT_MS, resolve empty rather than let the caller
   * (content/main.js's REQUEST_MORE_UNITS handler) hang. `extractMoreCore`
   * itself keeps running after that (nothing can actually abort a suspended
   * `await`) -- flip the local `abandoned` flag it was handed so its own
   * loop notices next time it checks and stops scrolling, rather than
   * quietly continuing to move the page after this call has already told
   * its caller "nothing found".
   * @param {'buffer-low'|'end-of-list'} reason
   */
  async function extractMore(reason) {
    if (disposed) {
      return { tweetDataList: [], exhausted: false, timedOut: false };
    }
    let abandoned = false;
    const core = extractMoreCore(reason, () => abandoned);
    const hardTimeout = new Promise((resolve) => {
      setTimeout(() => {
        abandoned = true;
        resolve({ tweetDataList: [], exhausted: false, timedOut: true });
      }, EXTRACT_MORE_TIMEOUT_MS);
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
    // Exposed for tests/diagnostics AND for real logic: twitter.js's
    // ensureVisible() reads this insertion-ordered Set to guess which
    // direction a not-currently-mounted tweet is in (emitted earlier than
    // everything on screen now -> scrolled past already -> above; see its
    // inferHuntDirection()).
    _emittedStatusIds: emittedStatusIds,
  };
}
