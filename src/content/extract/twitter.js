/**
 * src/content/extract/twitter.js
 *
 * The 'twitter' Extractor (shared_contracts §1) for x.com / twitter.com
 * timelines: status-ID keying, thread grouping, virtualization-safe
 * re-query, continuous loading (PRD §2, Flow B).
 *
 * Composition:
 *  - lib/x-selectors.js       every data-testid this extractor reads
 *  - lib/x-tweet-parser.js    one <article> -> TweetData (status-id keyed)
 *  - lib/x-thread-grouper.js  TweetData[] -> ReadUnit[] (threads, retweets,
 *                             quotes, promoted policy)
 *  - lib/x-timeline-feeder.js incremental scroll + MutationObserver +
 *                             dedupe + batch cap + timeout bail-out
 *
 * Virtualization handling is the crux of this file: Sentence.locator is
 * `{ statusId, sentenceOrdinal, textFingerprint, part }` — plain data,
 * NEVER a DOM node reference. resolveAnchor() re-queries
 * `article[data-testid="tweet"]` live, matches by parsed status id, and
 * returns null (=> widget preview fallback, §10) if that tweet's article
 * genuinely isn't mounted right now.
 *
 * Strictly read-only DOM access — no calls to X's API or GraphQL, ever.
 * Does not import from src/content/ui/ or src/background/.
 */

import { twitterContentKey } from '../../shared/keys.js';
import { fnv1a32 } from '../../shared/hash.js';
import { X_AUTOSCROLL_STEP_PX, X_AUTOSCROLL_MIN_INTERVAL_MS } from '../../shared/constants.js';
import { SELECTORS, querySelector, queryAll } from './lib/x-selectors.js';
import { extractStatusId } from './lib/x-tweet-parser.js';
import { groupTweetsIntoUnits } from './lib/x-thread-grouper.js';
import { createTimelineFeeder } from './lib/x-timeline-feeder.js';
import { extractArticleUnits, resolveArticleAnchor, ensureArticleVisible } from './lib/x-article-parser.js';

const HOST_RE = /(^|\.)(x|twitter)\.com$/i;

/** Bounded attempts to scroll a not-yet-mounted target into range on a status/thread page. */
const ENSURE_VISIBLE_SEARCH_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Module-local state; only one twitter session is ever active per page. */
const state = {
  log: console,
  settings: { skipPromoted: true, announceRetweets: true, autoScroll: true },
  feeder: null,
};

/**
 * @param {Location} location
 * @returns {boolean}
 */
function matches(location) {
  const host = (location?.host || location?.hostname || '').toLowerCase();
  return HOST_RE.test(host);
}

/**
 * @param {import('../../shared/types.js').ExtractorInitContext} ctx
 */
async function init(ctx) {
  state.log = ctx?.log || console;
  // Foundation's ACTIVATE handler may hand us `{}` today (see content/main.js
  // comment "background owns settings; extractor.init gets what it needs
  // later"); default to the documented ra.settings defaults (shared_contracts
  // §7) so behavior is sane even before that wiring is complete.
  state.settings = {
    skipPromoted: true,
    announceRetweets: true,
    autoScroll: true,
    ...(ctx?.settings || {}),
  };
  state.feeder = createTimelineFeeder({ log: state.log });
  state.feeder.init();
}

/**
 * Best-effort content fingerprint for the ExtractResult schema. Not the
 * authoritative resume anchor for X (that's `lastStatusId` in ra.progress.*
 * per shared_contracts §6/§7) — just fills the required contentHash field.
 * @param {import('../../shared/types.js').ReadUnit[]} units
 * @returns {string}
 */
function computeContentHash(units) {
  const joined = units.map((u) => `${u.id}:${u.sentences.length}`).join('|');
  return fnv1a32(joined || 'empty');
}

/**
 * @returns {Promise<import('../../shared/types.js').ExtractResult>}
 */
async function extract() {
  const tweetDataList = state.feeder ? await state.feeder.extractInitialBatch() : [];
  let units = groupTweetsIntoUnits(tweetDataList, state.settings);

  // X's long-form Article view (see lib/x-article-parser.js doc comment):
  // when present, it's the real content -- the underlying tweetData for
  // that same status is a near-empty stub (no tweetText at all), so drop it
  // in favor of the article's own units rather than reading both.
  const article = extractArticleUnits({ languageCode: state.settings.languageCode || 'en-IN' });
  if (article) {
    units = units.filter(
      (u) => u.meta?.statusId !== article.statusId && u.meta?.rootStatusId !== article.statusId
    );
    units = [...article.units, ...units];
  }

  return {
    units,
    contentKey: twitterContentKey(location),
    contentHash: computeContentHash(units),
    title: article?.title || document.title,
    exhausted: false,
  };
}

/**
 * @param {'buffer-low'|'end-of-list'} reason
 * @returns {Promise<import('../../shared/types.js').ExtractResult>}
 */
async function extractMore(reason) {
  if (!state.feeder) {
    return {
      units: [],
      contentKey: twitterContentKey(location),
      contentHash: computeContentHash([]),
      title: document.title,
      exhausted: false,
    };
  }
  const { tweetDataList, exhausted } = await state.feeder.extractMore(reason);
  const units = groupTweetsIntoUnits(tweetDataList, state.settings);
  return {
    units,
    contentKey: twitterContentKey(location),
    contentHash: computeContentHash(units),
    title: document.title,
    exhausted,
  };
}

/**
 * Re-queries the live DOM for the article matching a status id. NEVER
 * cached — virtualized timelines recycle/unmount article nodes constantly,
 * so any stored reference would go stale.
 * @param {string} statusId
 * @returns {Element|null}
 */
function findArticleByStatusId(statusId) {
  for (const el of queryAll(document, SELECTORS.article)) {
    const info = extractStatusId(el);
    if (info && info.statusId === statusId) return el;
  }
  return null;
}

/**
 * Finds a Range for `fingerprint` within `containerEl`'s live text, walking
 * text nodes fresh every call (never a stored node/range).
 * @param {Element|null} containerEl
 * @param {string} fingerprint
 * @returns {Range|null}
 */
function findRangeForFingerprint(containerEl, fingerprint) {
  if (!containerEl || !fingerprint || typeof document.createTreeWalker !== 'function') return null;
  const needle = fingerprint.trim();
  if (!needle) return null;

  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
  let combined = '';
  const nodeOffsets = [];
  let node;
  while ((node = walker.nextNode())) {
    const start = combined.length;
    combined += node.textContent;
    nodeOffsets.push({ node, start, end: combined.length });
  }

  const idx = combined.indexOf(needle);
  if (idx === -1) return null;
  const endIdx = idx + needle.length;

  const startInfo = nodeOffsets.find((n) => idx >= n.start && idx < n.end);
  const endInfo = nodeOffsets.find((n) => endIdx > n.start && endIdx <= n.end);
  if (!startInfo || !endInfo) return null;

  try {
    const range = document.createRange();
    range.setStart(startInfo.node, idx - startInfo.start);
    range.setEnd(endInfo.node, endIdx - endInfo.start);
    return range;
  } catch {
    return null;
  }
}

/**
 * The §10 highlight protocol, step 2: sentence -> {kind, range|element} | null.
 * @param {import('../../shared/types.js').Sentence} sentence
 * @returns {Promise<{kind:'range', range: Range}|{kind:'element', element: Element}|null>}
 */
async function resolveAnchor(sentence) {
  const locator = sentence?.locator;
  if (!locator) return null;
  if (locator.articleView) return resolveArticleAnchor(locator);
  if (locator.part === 'thread-cue') return null; // synthetic — no DOM node represents it

  const article = findArticleByStatusId(locator.statusId);
  if (!article) return null; // genuinely unmounted right now -> widget preview fallback

  // None of the cases below fall back to highlighting the whole `article`
  // when the specific piece isn't found. On a short tweet "the whole
  // article" is small enough that it barely mattered; on X's long-form
  // Article posts the entire multi-paragraph post lives inside one
  // `article`, so that fallback highlighted the whole visible post for a
  // single social-context/promoted/poll/link-card/image sentence. Returning
  // null instead defers to the widget's text-preview fallback, same as the
  // 'text'/'quote' cases below.
  switch (locator.part) {
    case 'social-context': {
      const el = querySelector(article, SELECTORS.socialContext);
      return el ? { kind: 'element', element: el } : null;
    }
    case 'promoted': {
      const el = querySelector(article, SELECTORS.promoted);
      return el ? { kind: 'element', element: el } : null;
    }
    case 'poll': {
      const el = querySelector(article, SELECTORS.poll);
      return el ? { kind: 'element', element: el } : null;
    }
    case 'link-card': {
      const el = querySelector(article, SELECTORS.cardWrapper);
      return el ? { kind: 'element', element: el } : null;
    }
    case 'image': {
      // No per-image ordinal is tracked in the locator yet, so there is no
      // reliable way to point at THIS specific image among possibly
      // several -- degrade to the text-preview fallback rather than guess.
      return null;
    }
    case 'quote': {
      const nodes = queryAll(article, SELECTORS.tweetText);
      const quoteTextEl = nodes[1] || null;
      if (quoteTextEl) {
        const range = findRangeForFingerprint(quoteTextEl, locator.textFingerprint);
        // No precise range -> fall through to the widget's text-preview
        // fallback rather than highlighting the whole quote block: on a
        // short tweet that's a mild over-highlight, but on X's long-form
        // Article posts (the whole article lives in one tweetText element)
        // it would light up the entire visible article for every sentence.
        return range ? { kind: 'range', range } : null;
      }
      return null;
    }
    case 'text':
    default: {
      const textEl = querySelector(article, SELECTORS.tweetText);
      if (!textEl) return null;
      const range = findRangeForFingerprint(textEl, locator.textFingerprint);
      return range ? { kind: 'range', range } : null;
    }
  }
}

/**
 * The §10 highlight protocol, step 1: scroll the target into view (and, on
 * a status/thread page, make a few bounded attempts to find it first).
 * Returns false only when the node is genuinely unmounted.
 * @param {import('../../shared/types.js').Sentence} sentence
 * @returns {Promise<boolean>}
 */
async function ensureVisible(sentence) {
  const locator = sentence?.locator;
  if (!locator) return false;
  if (locator.articleView) return ensureArticleVisible(locator);
  if (locator.part === 'thread-cue') return false;

  let article = findArticleByStatusId(locator.statusId);

  if (!article && state.settings.autoScroll) {
    for (let attempt = 0; attempt < ENSURE_VISIBLE_SEARCH_ATTEMPTS && !article; attempt++) {
      try {
        window.scrollBy({ top: X_AUTOSCROLL_STEP_PX, left: 0, behavior: 'auto' });
      } catch {
        /* ignore */
      }
      await sleep(X_AUTOSCROLL_MIN_INTERVAL_MS);
      article = findArticleByStatusId(locator.statusId);
    }
  }

  if (!article) return false;

  if (state.settings.autoScroll) {
    try {
      article.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      /* best-effort only */
    }
  }
  return true;
}

function dispose() {
  state.feeder?.dispose?.();
  state.feeder = null;
}

export default {
  id: 'twitter',
  matches,
  init,
  extract,
  extractMore,
  resolveAnchor,
  ensureVisible,
  dispose,
};
