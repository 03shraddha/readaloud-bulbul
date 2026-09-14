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
import { findRangeForSentence } from './lib/x-text-anchor.js';
import { createTimelineFeeder } from './lib/x-timeline-feeder.js';
import {
  extractArticleUnits,
  resolveArticleAnchor,
  ensureArticleVisible,
  waitForArticleStable,
} from './lib/x-article-parser.js';
import { scrollIntoViewSmart } from './lib/scroll.js';

const HOST_RE = /(^|\.)(x|twitter)\.com$/i;

/** Bounded attempts to scroll a not-yet-mounted target into range on a status/thread page. */
const ENSURE_VISIBLE_SEARCH_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * A status permalink page: `/<user>/status/<id>`, `/i/status/<id>`, or
 * either of those with a trailing media-viewer segment (e.g.
 * `/<user>/status/<id>/photo/1`). Same pathname shape
 * lib/x-article-parser.js's module-local `statusIdFromLocation()` matches
 * against `location.pathname` -- duplicated here rather than imported
 * because that helper isn't exported from a file this task doesn't own.
 *
 * A permalink's content is finite: the focal tweet plus whatever replies
 * are already mounted below it. Unlike an ordinary timeline (where there's
 * always more to scroll to), there is nothing more X will ever load here
 * that the reader asked for -- see extract()'s `exhausted` comment for what
 * goes wrong when a finite page is treated as if it weren't.
 * @param {string} pathname
 * @returns {boolean}
 */
export function isStatusPermalinkPathname(pathname) {
  return /^\/(?:i|[^/]+)\/status\/(\d+)/.test(pathname || '');
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
  // content/main.js hands us its own `currentSettings` object and mutates it
  // IN PLACE (via watchSettings()) whenever the widget's settings popover
  // changes something, so the toggles keep working mid-session -- but only
  // for whoever kept a reference to that same object (see article.js's
  // `this._settings`). Spreading it into a brand-new object here, like this
  // used to do, breaks that link: state.settings would be a one-time
  // snapshot, and toggling Auto-scroll/Skip promoted/Announce retweets after
  // a session already started would silently do nothing until the next
  // ACTIVATE. Filling in defaults on the SAME object (rather than building a
  // new one) keeps state.settings === ctx.settings, so live updates apply.
  const settings = ctx?.settings || {};
  if (settings.skipPromoted === undefined) settings.skipPromoted = true;
  if (settings.announceRetweets === undefined) settings.announceRetweets = true;
  if (settings.autoScroll === undefined) settings.autoScroll = true;
  state.settings = settings;
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
  //
  // On a just-reloaded page the Article body is often still hydrating (and
  // images still loading) right when this runs -- wait for it to settle
  // first, or the locators/scroll targets we capture below would point at
  // a half-finished layout that visibly shifts under the reader a moment
  // later (see waitForArticleStable() doc comment).
  if (querySelector(document, SELECTORS.articleReadView)) {
    await waitForArticleStable();
  }
  const article = extractArticleUnits({ languageCode: state.settings.languageCode || 'en-IN' });
  if (article) {
    units = units.filter(
      (u) => u.meta?.statusId !== article.statusId && u.meta?.rootStatusId !== article.statusId
    );
    units = [...article.units, ...units];
  }

  const isPermalink = isStatusPermalinkPathname(location.pathname);

  return {
    units,
    contentKey: twitterContentKey(location),
    contentHash: computeContentHash(units),
    title: article?.title || document.title,
    // `exhausted: false` was hardcoded here unconditionally -- correct for
    // an ordinary timeline (there's always more to scroll to), but wrong
    // for an Article: extractArticleUnits() above already walked the whole
    // body in one synchronous DOM pass (no scrolling involved), so there is
    // nothing left to fetch. Leaving this false meant that as soon as the
    // prefetch buffer ran low (immediately, if the article had fewer
    // sentences than PREFETCH_AHEAD, or later, near the end of any
    // article), the background would ask for "more units", which the
    // feeder below has no concept of an Article and would answer by
    // blindly scrolling the page down hunting for `article[data-testid=
    // "tweet"]` elements that were never going to be there -- exactly the
    // unwanted downward auto-scroll reported after clicking play.
    //
    // A plain status permalink (`/<user>/status/<id>`) has the identical
    // problem and was NOT covered by the check above: its tweetData comes
    // from the regular per-article path, not extractArticleUnits(), so
    // `article` is null there and this used to fall through to `false`.
    // The focal tweet plus whatever replies are already mounted is all a
    // permalink page will ever show for a single-tweet read -- there's no
    // "next batch" coming -- so the buffer running low there triggered the
    // exact same blind downward scroll-hunt while the reader was still on
    // the first sentence of that one tweet (the second, independent cause
    // of the reported "page walking downward on its own" bug).
    exhausted: !!article || isPermalink,
  };
}

/**
 * @param {'buffer-low'|'end-of-list'} reason
 * @returns {Promise<import('../../shared/types.js').ExtractResult>}
 */
async function extractMore(reason) {
  // Belt-and-suspenders: extract()'s `exhausted: !!article || isPermalink`
  // already stops the background from ever calling this for an Article
  // session or a status permalink, but if that ever changes (a future
  // resumed session, a code path we missed), never let the tweet-timeline
  // feeder's scroll-hunt run against either -- there is nothing more it
  // could find on an Article page, and nothing more X will load for the
  // reader on a permalink.
  if (querySelector(document, SELECTORS.articleReadView) || isStatusPermalinkPathname(location.pathname)) {
    return {
      units: [],
      contentKey: twitterContentKey(location),
      contentHash: computeContentHash([]),
      title: document.title,
      exhausted: true,
    };
  }

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
 * The §10 highlight protocol, step 2: sentence -> {kind, range|element} | null.
 * @param {import('../../shared/types.js').Sentence} sentence
 * @returns {Promise<{kind:'range', range: Range}|{kind:'element', element: Element}|null>}
 */
async function resolveAnchor(sentence) {
  const locator = sentence?.locator;
  if (!locator) return null;
  if (locator.articleView) return resolveArticleAnchor(locator, sentence.text);
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
    case 'quote': {
      const nodes = queryAll(article, SELECTORS.tweetText);
      const quoteTextEl = nodes[1] || null;
      if (quoteTextEl) {
        const range = findRangeForSentence(quoteTextEl, locator.textFingerprint, {
          ordinal: locator.sentenceOrdinal,
        });
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
      const range = findRangeForSentence(textEl, locator.textFingerprint, {
        ordinal: locator.sentenceOrdinal,
      });
      return range ? { kind: 'range', range } : null;
    }
  }
}

/**
 * Guesses which way to scroll to find `targetStatusId`, using the feeder's
 * emission order as a proxy for timeline position: tweets are emitted in
 * the DOM order X mounts them in, so a status id emitted before every
 * status id currently mounted was scrolled past already and sits ABOVE the
 * viewport; anything else (emitted later, or never emitted / unknown) is
 * treated as still ahead, i.e. BELOW. `feeder._emittedStatusIds` is a
 * insertion-ordered Set built for tests/diagnostics, but its ordering is
 * exactly the signal this needs, so it's read here as real logic too.
 * @param {ReturnType<typeof createTimelineFeeder>|null} feeder
 * @param {string} targetStatusId
 * @returns {1|-1} scroll direction: 1 = down, -1 = up
 */
function inferHuntDirection(feeder, targetStatusId) {
  if (!feeder) return 1;
  const order = Array.from(feeder._emittedStatusIds);
  const targetIndex = order.indexOf(targetStatusId);
  if (targetIndex === -1) return 1; // never emitted -- best guess is still ahead

  const mountedIndices = queryAll(document, SELECTORS.article)
    .map((el) => extractStatusId(el)?.statusId)
    .filter(Boolean)
    .map((id) => order.indexOf(id))
    .filter((i) => i !== -1);
  if (!mountedIndices.length) return 1; // no mounted reference point to compare against

  return targetIndex < Math.min(...mountedIndices) ? -1 : 1;
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
    // A tweet that scrolled out of a virtualized timeline can be ABOVE the
    // viewport just as easily as below it (the user may have scrolled past
    // it already), but this used to always hunt downward -- searching the
    // wrong direction for a tweet that's actually above, moving the page
    // 1800px for nothing, then giving up with the page left there. Guess
    // the right direction first (inferHuntDirection), and if the hunt still
    // comes up empty, put the scroll position back rather than stranding
    // the reader somewhere they never asked to be.
    const startScrollY = window.scrollY;
    const direction = inferHuntDirection(state.feeder, locator.statusId);
    for (let attempt = 0; attempt < ENSURE_VISIBLE_SEARCH_ATTEMPTS && !article; attempt++) {
      try {
        window.scrollBy({ top: direction * X_AUTOSCROLL_STEP_PX, left: 0, behavior: 'auto' });
      } catch {
        /* ignore */
      }
      await sleep(X_AUTOSCROLL_MIN_INTERVAL_MS);
      article = findArticleByStatusId(locator.statusId);
    }
    if (!article) {
      try {
        window.scrollTo({ top: startScrollY, left: 0, behavior: 'auto' });
      } catch {
        /* ignore */
      }
    }
  }

  if (!article) return false;

  if (state.settings.autoScroll) {
    // Scroll to the SAME specific range/element resolveAnchor() will
    // highlight, not the whole `article` card -- a tweet's card can easily
    // be taller than the viewport (a long tweet with several sentences,
    // an image, a quote; confirmed live: a 758px-tall card against a
    // 688px viewport), and centering the whole oversized card can never
    // satisfy scrollIntoViewSmart's "comfortably in view" check, no matter
    // which sentence within it is actually being read right now -- so it
    // re-triggers on every sentence and can leave the one actually being
    // read drifting toward (or past) the edge of the screen. Falling back
    // to the whole article only when a precise target isn't resolvable
    // keeps the "no-op when already comfortable" behavior working for the
    // common case (a short tweet, or a sentence whose target IS the whole
    // element already, e.g. a poll/link-card).
    const anchor = await resolveAnchor(sentence);
    const target = anchor?.kind === 'range' ? anchor.range : anchor?.kind === 'element' ? anchor.element : article;
    scrollIntoViewSmart(target, { behavior: 'smooth', block: 'center' });
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
