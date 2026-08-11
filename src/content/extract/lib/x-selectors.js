/**
 * src/content/extract/lib/x-selectors.js
 *
 * Centralizes EVERY X/Twitter `data-testid` (and other structural selector)
 * this extractor depends on, in one place, so an X markup change is a
 * one-file fix instead of a hunt across x-tweet-parser.js / x-thread-
 * grouper.js / x-timeline-feeder.js / twitter.js.
 *
 * Each entry is `{ selector, optional }`:
 *  - optional:false  -> expected on every tweet article; a miss usually
 *                        means the article really is unparseable (or X
 *                        changed something load-bearing). Callers should
 *                        degrade gracefully (skip + log) rather than throw.
 *  - optional:true   -> a conditional per-tweet feature (poll, link card,
 *                        promoted marker, quote, "show more" link, social
 *                        context line, ...). Its absence is completely
 *                        normal and must NEVER be logged as a warning.
 *
 * Nothing in this module touches the DOM eagerly — it only describes where
 * to look. Actual querying happens lazily via querySelector()/queryAll()
 * below, both of which are defensive (never throw on a bad/unsupported
 * selector, in case a future X change requires a tweak here).
 */

export const SELECTORS = Object.freeze({
  /** The tweet card itself. Everything else below is scoped under one of these. */
  article: { selector: 'article[data-testid="tweet"]', optional: false },

  /** Author block; contains the display name (before the "@handle" run). */
  userName: { selector: '[data-testid="User-Name"]', optional: false },

  /** The `<time>` element whose ancestor `<a>` carries the /status/<id> permalink. */
  time: { selector: 'time', optional: false },

  /** Tweet body text. Absent for e.g. a poll-only or a media-only tweet. */
  tweetText: { selector: '[data-testid="tweetText"]', optional: true },

  /** "Jane Doe reposted" / "Promoted" / reply-context line above the tweet. */
  socialContext: { selector: '[data-testid="socialContext"]', optional: true },

  /** Present only on ads; the single most reliable "this is Promoted" signal. */
  promoted: { selector: '[data-testid="placementTracking"]', optional: true },

  /** Link-preview card (article/site preview attached to the tweet). */
  cardWrapper: { selector: '[data-testid="card.wrapper"]', optional: true },

  /** "Show more" expander for a truncated tweet body. */
  showMoreLink: { selector: '[data-testid="tweet-text-show-more-link"]', optional: true },

  /** Poll widget wrapper. */
  poll: { selector: '[data-testid="cardPoll"]', optional: true },

  /**
   * Best-effort container for a quote-tweet's bordered "card" wrapper, used
   * ONLY as a fallback highlight/scroll target (see resolveAnchor in
   * twitter.js). X has no stable public data-testid for this element, so
   * the actual quote *content* is never parsed via this selector — see
   * x-tweet-parser.js's extractQuote(), which instead relies on a second
   * occurrence of `tweetText`/`User-Name` inside the same article. Kept
   * optional and deliberately coarse.
   */
  quoteContainer: { selector: 'div[role="link"][tabindex="0"]', optional: true },

  /**
   * X's long-form "Articles" feature (opened from a status page): a
   * COMPLETELY SEPARATE `<article>` element from `SELECTORS.article` above
   * -- confirmed by direct DOM inspection, since none of this is publicly
   * documented. `[data-testid="tweetText"]` never appears inside it, which
   * is why the ordinary tweet-text path finds nothing and this needs its
   * own extraction (see lib/x-article-parser.js). Absent on every normal
   * tweet/timeline page, so always optional.
   */
  articleReadView: { selector: 'article[data-testid="twitterArticleReadView"]', optional: true },

  /** The article's own title, distinct from `document.title`. */
  articleTitle: { selector: '[data-testid="twitter-article-title"]', optional: true },

  /** Wraps the actual body content (paragraphs, images, headings). */
  articleRichText: { selector: '[data-testid="twitterArticleRichTextView"]', optional: true },

  /** The direct ancestor of the real sibling-block list inside articleRichText. */
  articleRichTextComponent: { selector: '[data-testid="longformRichTextComponent"]', optional: true },
});

/**
 * @param {ParentNode|null|undefined} root
 * @param {{selector:string, optional:boolean}} entry
 * @returns {Element|null}
 */
export function querySelector(root, entry) {
  if (!root || !entry || typeof root.querySelector !== 'function') return null;
  try {
    return root.querySelector(entry.selector);
  } catch {
    return null;
  }
}

/**
 * @param {ParentNode|null|undefined} root
 * @param {{selector:string, optional:boolean}} entry
 * @returns {Element[]}
 */
export function queryAll(root, entry) {
  if (!root || !entry || typeof root.querySelectorAll !== 'function') return [];
  try {
    return Array.from(root.querySelectorAll(entry.selector));
  } catch {
    return [];
  }
}

/**
 * Logs a warning ONLY for a miss on a non-optional selector. Never logs for
 * optional selectors — their absence is expected, per-tweet variation.
 * @param {{warn:Function}|undefined|null} log
 * @param {{selector:string, optional:boolean}} entry
 * @param {string} name
 * @param {Element} scopeEl
 */
export function warnIfMissingRequired(log, entry, name, scopeEl) {
  if (!entry || entry.optional) return;
  const found = querySelector(scopeEl, entry);
  if (!found) {
    log?.warn?.(`[x-selectors] required selector "${name}" (${entry.selector}) not found`, scopeEl);
  }
}
