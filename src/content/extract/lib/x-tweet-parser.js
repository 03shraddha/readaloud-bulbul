/**
 * src/content/extract/lib/x-tweet-parser.js
 *
 * Turns ONE `article[data-testid="tweet"]` DOM node into a plain, JSON-safe
 * "TweetData" object. Pure structural extraction only — no settings-based
 * policy here (skip-promoted / announce-retweets decisions live in
 * x-thread-grouper.js, which is the module that actually builds ReadUnits).
 *
 * Strictly read-only DOM access: this module never calls X's API/GraphQL,
 * only reads what's already rendered (with one narrow exception — clicking
 * a "Show more" expander, which is a real user-facing DOM interaction, not
 * a network call).
 *
 * @typedef {Object} TweetData
 * @property {string} statusId
 * @property {string} permalink
 * @property {string} authorName          - display NAME only, never @handle
 * @property {boolean} isPromoted
 * @property {boolean} isRetweet
 * @property {string|null} repostedByName
 * @property {boolean} isQuote
 * @property {string} mainText            - inline URLs already replaced via describeUrl
 * @property {string[]} images             - alt text of attached (non-emoji) images
 * @property {{options:string[]}|null} poll
 * @property {{urlText:string, title:string}|null} linkCard
 * @property {{name:string, text:string}|null} quote
 */

import { describeUrl } from '../../../shared/text/normalize.js';
import { SELECTORS, querySelector, queryAll } from './x-selectors.js';

const STATUS_ID_RE = /\/status\/(\d+)/;
const SHOW_MORE_SETTLE_MS = 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Parses just enough of an article to get its status id + permalink. Cheap
 * enough to call on every candidate article for dedupe checks before
 * committing to a full parseTweet() (which may click "Show more").
 * @param {Element} articleEl
 * @returns {{statusId:string, permalink:string}|null}
 */
export function extractStatusId(articleEl) {
  if (!articleEl) return null;

  // Primary: the timestamp's own permalink anchor.
  try {
    const timeEl = querySelector(articleEl, SELECTORS.time);
    const link = timeEl?.closest?.('a[href]');
    const href = link?.getAttribute?.('href');
    if (href) {
      const m = href.match(STATUS_ID_RE);
      if (m) return { statusId: m[1], permalink: href };
    }
  } catch {
    /* fall through to fallback strategies below */
  }

  // Fallback 1: any anchor within the article whose href carries /status/<id>
  // (covers layout variants where <time> isn't the direct permalink child).
  try {
    const anchors = articleEl.querySelectorAll('a[href*="/status/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(STATUS_ID_RE);
      if (m) return { statusId: m[1], permalink: href };
    }
  } catch {
    /* fall through */
  }

  // Fallback 2: regex scan of the article's own markup for a /status/<id>
  // pattern anywhere (e.g. a hydration data attribute), as a last resort.
  try {
    const m = articleEl.innerHTML.match(STATUS_ID_RE);
    if (m) return { statusId: m[1], permalink: `/i/status/${m[1]}` };
  } catch {
    /* give up below */
  }

  return null;
}

/**
 * Reads the display NAME only from a `User-Name` container — walks text
 * nodes and stops at the first token starting with '@' (the handle run),
 * so multi-span / emoji-in-name display names are still captured whole.
 * @param {Element} container
 * @returns {string}
 */
function collectDisplayNameText(container) {
  if (!container || typeof document.createTreeWalker !== 'function') {
    return (container?.textContent || '').trim();
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let out = '';
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent || '';
    if (t.trim().startsWith('@')) break;
    out += t;
  }
  return out.trim();
}

function extractAuthorName(articleEl) {
  const container = querySelector(articleEl, SELECTORS.userName);
  if (!container) return '';
  return collectDisplayNameText(container);
}

function extractSocialContext(articleEl) {
  const el = querySelector(articleEl, SELECTORS.socialContext);
  return el ? (el.textContent || '').trim() : '';
}

function detectPromoted(articleEl, socialContextText) {
  if (querySelector(articleEl, SELECTORS.promoted)) return true;
  return /^(sponsored|promoted)$/i.test(socialContextText);
}

function detectRetweet(socialContextText) {
  if (!socialContextText) return { isRetweet: false, repostedByName: null };
  const m = socialContextText.match(/^(.*?)\s+(reposted|retweeted)$/i);
  if (m && m[1].trim()) return { isRetweet: true, repostedByName: m[1].trim() };
  if (/^(reposted|retweeted)$/i.test(socialContextText)) {
    return { isRetweet: true, repostedByName: null };
  }
  return { isRetweet: false, repostedByName: null };
}

function looksTruncated(textEl) {
  const t = (textEl.textContent || '').trim();
  return t.endsWith('…') || t.endsWith('...');
}

/**
 * Extracts text from a styled element using TreeWalker, respecting link/emoji handling.
 * Fallback 3: when complex nesting defeats direct traversal.
 * @param {Element} node
 * @returns {string}
 */
function buildTextViaTreeWalker(node) {
  if (!node || typeof document.createTreeWalker !== 'function') return '';
  let out = '';
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    out += textNode.textContent;
  }
  return out;
}

/**
 * Walks a tweet-text container's child nodes, replacing link anchors with
 * describeUrl() output (unless they're a hashtag/mention, which are kept
 * verbatim) and inline emoji <img>s with their alt text.
 *
 * Includes 3 fallback strategies to handle styled text (bold, italic, underline, highlight):
 * 1. Direct recursive traversal (primary path — most precise control over links/emoji)
 * 2. Catch-all textContent for deeply nested or complex styled elements
 * 3. TreeWalker-based extraction for edge cases where recursion misses text
 *
 * @param {Element} node
 * @returns {string}
 */
function buildTextFromNode(node) {
  if (!node) return '';

  let out = '';
  const visitedElements = new Set();

  // Primary strategy: direct traversal with explicit handling for links & emoji
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName;
      if (tag === 'A') {
        const href = child.getAttribute('href') || '';
        const label = (child.textContent || '').trim();
        const isHashtagOrMention = label.startsWith('#') || label.startsWith('@') || href.startsWith('/');
        out += isHashtagOrMention ? label : ` ${describeUrl(href)} `;
        visitedElements.add(child);
      } else if (tag === 'IMG') {
        const alt = child.getAttribute('alt');
        // Only append genuine inline emoji glyphs, not a real image
        // description that happens to sit on an inline <img> -- confirmed
        // live that X's own emoji renders as a short, space-free alt (a
        // single glyph or a multi-codepoint ZWJ sequence, e.g. "🪄", "✅").
        // A real description is a sentence: it has whitespace and runs
        // much longer, and reads oddly stitched into the middle of the
        // tweet's own text. Skipping it here just omits it from `out` --
        // the rest of the tweet's text keeps building normally.
        if (alt && !/\s/.test(alt) && alt.length <= 16) out += alt;
        visitedElements.add(child);
      } else {
        // Styled element (span, strong, em, u, mark, etc.) — recurse to preserve link/emoji handling
        out += buildTextFromNode(child);
        visitedElements.add(child);
      }
    }
  }

  const primaryText = out.trim();

  // Fallback 1: If primary traversal yielded little/no text, use textContent as a safety net
  // for complex DOM structures where styled text might live in deeply nested containers.
  if (primaryText.length < 3 && node.textContent) {
    const fallback1 = node.textContent.trim();
    if (fallback1.length > primaryText.length) {
      return fallback1;
    }
  }

  // Fallback 2: If primary strategy missed styled elements, use TreeWalker to catch them.
  // This handles edge cases like <span style="...">text</span> that may have no text-node children.
  const treeWalkerText = buildTextViaTreeWalker(node).trim();
  if (treeWalkerText.length > primaryText.length && treeWalkerText.length > 5) {
    return treeWalkerText;
  }

  return primaryText;
}

/**
 * Reads the tweet body, preferring the untruncated node and clicking
 * "Show more" only when the text looks truncated (at most once per tweet).
 * @param {Element} articleEl
 * @returns {Promise<string>}
 */
async function extractMainText(articleEl) {
  let textEl = querySelector(articleEl, SELECTORS.tweetText);
  if (!textEl) return '';

  if (looksTruncated(textEl)) {
    const showMore = querySelector(articleEl, SELECTORS.showMoreLink);
    if (showMore) {
      try {
        showMore.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(SHOW_MORE_SETTLE_MS);
        textEl = querySelector(articleEl, SELECTORS.tweetText) || textEl;
      } catch {
        /* best-effort only; keep reading whatever we already had */
      }
    }
  }

  return buildTextFromNode(textEl);
}

/**
 * ONE level of quote-tweet nesting: detected via a SECOND occurrence of
 * tweetText/User-Name inside the same article (the quoted tweet reuses the
 * same testids as the outer one). Deliberately does not recurse into a
 * quote-of-a-quote.
 * @param {Element} articleEl
 * @param {Element[]} tweetTextNodes - already-queried tweetText nodes (index 0 = main)
 * @returns {{name:string, text:string}|null}
 */
function extractQuote(articleEl, tweetTextNodes) {
  if (!tweetTextNodes || tweetTextNodes.length < 2) return null;
  const quoteTextEl = tweetTextNodes[1];

  let name = '';
  try {
    const userNameNodes = articleEl.querySelectorAll('[data-testid="User-Name"]');
    const quoteNameEl = userNameNodes.length > 1 ? userNameNodes[1] : null;
    name = quoteNameEl ? collectDisplayNameText(quoteNameEl) : '';
  } catch {
    /* ignore */
  }

  const text = buildTextFromNode(quoteTextEl);
  if (!name && !text) return null;
  return { name: name || 'someone', text };
}

/**
 * Attached (non-emoji) image alt text — read once per image, excluding
 * anything inside the already-captured text containers (inline emoji live
 * there and are handled by buildTextFromNode instead).
 * @param {Element} articleEl
 * @param {Array<Element|null>} excludeEls
 * @returns {string[]}
 */
function extractAttachedImageAlts(articleEl, excludeEls) {
  const excludes = (excludeEls || []).filter(Boolean);
  let imgs;
  try {
    imgs = articleEl.querySelectorAll('img[alt]');
  } catch {
    return [];
  }
  const alts = [];
  const seen = new Set();
  for (const img of imgs) {
    if (excludes.some((el) => el.contains(img))) continue;
    const alt = (img.getAttribute('alt') || '').trim();
    // Single-character-ish alts are almost always inline emoji that slipped
    // past the text-container exclusion; skip them defensively.
    if (!alt || alt.length <= 2) continue;
    if (seen.has(alt)) continue;
    seen.add(alt);
    alts.push(alt);
  }
  return alts;
}

/**
 * Poll option labels, with any live percentage stripped out.
 * @param {Element} articleEl
 * @returns {{options:string[]}|null}
 */
function extractPoll(articleEl) {
  const pollEl = querySelector(articleEl, SELECTORS.poll);
  if (!pollEl) return null;

  let candidateEls;
  try {
    candidateEls = pollEl.querySelectorAll('[role="radio"], [data-testid="pollOption"], div[dir]');
  } catch {
    candidateEls = [];
  }

  const options = [];
  const seen = new Set();
  for (const el of candidateEls) {
    let text = (el.textContent || '').trim();
    if (!text) continue;
    text = text.replace(/\d+(\.\d+)?\s*%/g, '').replace(/\s{2,}/g, ' ').trim();
    if (!text || text.length > 80 || seen.has(text)) continue;
    seen.add(text);
    options.push(text);
  }
  return options.length ? { options } : null;
}

/**
 * Link-preview card: "link to <domain>" (via shared describeUrl) plus a
 * best-effort title line (the domain-like line itself is filtered out).
 * @param {Element} articleEl
 * @returns {{urlText:string, title:string}|null}
 */
function extractLinkCard(articleEl) {
  const cardEl = querySelector(articleEl, SELECTORS.cardWrapper);
  if (!cardEl) return null;

  const anchor = cardEl.closest('a[href]') || cardEl.querySelector('a[href]');
  const href = anchor ? anchor.getAttribute('href') : '';
  const urlText = href ? describeUrl(href) : 'link to a website';

  const domainLike = /^[\w.-]+\.[a-z]{2,}(?:[/?].*)?$/i;
  let title = '';
  try {
    const textNodes = cardEl.querySelectorAll('div[dir="auto"], span');
    for (const el of textNodes) {
      const t = (el.textContent || '').trim();
      if (t && !domainLike.test(t) && t.length > title.length) title = t;
    }
  } catch {
    /* leave title empty */
  }

  return { urlText, title };
}

/**
 * @param {Element} articleEl
 * @param {{log?: {warn:Function}}} [opts]
 * @returns {Promise<TweetData|null>} null => skip (status id undeterminable)
 */
export async function parseTweet(articleEl, opts = {}) {
  const { log } = opts;
  if (!articleEl) return null;

  const idInfo = extractStatusId(articleEl);
  if (!idInfo) {
    log?.warn?.('[x-tweet-parser] could not determine status id; skipping tweet', articleEl);
    return null;
  }

  const authorName = extractAuthorName(articleEl);
  if (!authorName) {
    log?.warn?.('[x-tweet-parser] required selector "userName" missing content', articleEl);
  }

  const socialContextText = extractSocialContext(articleEl);
  const isPromoted = detectPromoted(articleEl, socialContextText);
  const { isRetweet, repostedByName } = detectRetweet(socialContextText);

  // Expand "Show more" (if needed) BEFORE reading anything positioned after
  // the tweet body — a click here can trigger a React re-render that
  // replaces sibling/child nodes (quote/poll/card/images).
  const mainText = await extractMainText(articleEl);

  const tweetTextNodes = queryAll(articleEl, SELECTORS.tweetText);
  const mainTextEl = tweetTextNodes[0] || null;
  const quote = extractQuote(articleEl, tweetTextNodes);
  const quoteTextEl = tweetTextNodes[1] || null;

  const images = extractAttachedImageAlts(articleEl, [mainTextEl, quoteTextEl]);
  const poll = extractPoll(articleEl);
  const linkCard = extractLinkCard(articleEl);

  return {
    statusId: idInfo.statusId,
    permalink: idInfo.permalink,
    authorName: authorName || 'Someone',
    isPromoted,
    isRetweet,
    repostedByName,
    isQuote: !!quote,
    mainText,
    images,
    poll,
    linkCard,
    quote,
  };
}
