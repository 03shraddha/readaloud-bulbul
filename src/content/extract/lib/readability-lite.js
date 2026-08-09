/**
 * src/content/extract/lib/readability-lite.js
 *
 * Clone-free Readability-style scoring: unlike the classic Readability.js
 * approach of cloning the document and mutating the clone while stripping
 * boilerplate, this walks the LIVE DOM read-only and simply skips
 * disqualified subtrees during traversal/scoring. Nothing here ever
 * mutates the page.
 *
 * `findBestContainer` selects the best candidate content container using a
 * simple weighted score over paragraph count, visible text length, comma
 * count (a cheap prose-vs-boilerplate signal), and link density (a
 * nav/boilerplate penalty), falling back to `document.body` when nothing
 * scores positively.
 */

import { walkDOM } from './dom-walk.js';
import { isVisibleTextNode } from './visibility.js';

const CANDIDATE_SELECTOR = [
  'article',
  'main',
  '[role="main"]',
  '.post',
  '.entry',
  '.content',
  '#content',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.article-body',
  '.story-body',
  '.post-body',
].join(', ');

const STRIP_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// NOTE: IFRAME is deliberately NOT in this list. dom-walk.js already
// descends into same-origin iframes and hard-skips cross-origin ones (the
// large majority of ad/tracker/comment-widget embeds are cross-origin), so
// same-origin content frames still contribute text/paragraphs to scoring
// while most boilerplate iframes are excluded for free.

const STRIP_ROLE_RE = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|toolbar|menu|menubar)$/i;

const STRIP_CLASS_ID_RE =
  /\b(ad|ads|advert(?:isement)?s?|sponsor(?:ed)?|promo(?:tion)?s?|social[-_]?share|share[-_]?bar|comments?|related[-_]?(?:posts?|articles?)|sidebar|newsletter|cookie[-_]?(?:banner|notice|consent)|popup|modal|site[-_]?header|site[-_]?footer|masthead|breadcrumbs?|pagination|nav(?:bar|igation)?|menu|widget|skip[-_]?link|subscribe|paywall)\b/i;

/**
 * @param {Element} el
 * @returns {boolean} true if this element (and everything under it) should
 *   be excluded from scoring and unit extraction.
 */
export function shouldStripElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

  if (STRIP_TAGS.has(el.tagName)) return true;

  const role = el.getAttribute ? el.getAttribute('role') : null;
  if (role && STRIP_ROLE_RE.test(role.trim())) return true;

  const className = typeof el.className === 'string' ? el.className : '';
  const idAndClass = `${el.id || ''} ${className}`.trim();
  if (idAndClass && STRIP_CLASS_ID_RE.test(idAndClass)) return true;

  return false;
}

/**
 * @param {Node} node
 * @param {Element} boundary
 * @returns {boolean} true if `node` has an <a> ancestor at or below `boundary`.
 */
function isInsideLink(node, boundary) {
  let current = node.parentElement;
  while (current && current !== boundary) {
    if (current.tagName === 'A') return true;
    current = current.parentElement;
  }
  return false;
}

const scoreShouldDescend = (el) => !shouldStripElement(el);

/**
 * Weighted Readability-lite score for a single candidate container.
 * Higher is better; containers dominated by link text or with little prose
 * score low or negative.
 * @param {Element} el
 * @returns {number}
 */
export function scoreContainer(el) {
  if (!el) return -Infinity;

  let textLength = 0;
  let linkTextLength = 0;
  let paragraphCount = 0;
  let commaCount = 0;

  for (const node of walkDOM(el, { shouldDescend: scoreShouldDescend })) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'P') {
        const text = (node.textContent || '').trim();
        if (text.length > 25) paragraphCount++;
      }
      continue;
    }

    if (node.nodeType !== Node.TEXT_NODE) continue;
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) continue;
    if (!isVisibleTextNode(node)) continue;

    const trimmedLength = raw.trim().length;
    textLength += trimmedLength;
    commaCount += (raw.match(/,/g) || []).length;
    if (isInsideLink(node, el)) linkTextLength += trimmedLength;
  }

  const linkDensity = textLength > 0 ? linkTextLength / textLength : 0;
  return textLength * 0.25 + paragraphCount * 25 + commaCount * 3 - linkDensity * textLength * 0.9;
}

/**
 * Find the single best-scoring candidate container on the page, falling
 * back to `document.body` (or `document.documentElement` if even that is
 * unavailable) when nothing scores positively.
 * @param {Document} [doc]
 * @returns {Element}
 */
export function findBestContainer(doc = document) {
  /** @type {Element[]} */
  let candidates = [];
  try {
    candidates = Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR));
  } catch {
    candidates = [];
  }

  const seen = new Set();
  const unique = candidates.filter((el) => {
    if (!el || seen.has(el)) return false;
    seen.add(el);
    return true;
  });

  let best = null;
  let bestScore = -Infinity;

  for (const candidate of unique) {
    let score = -Infinity;
    try {
      score = scoreContainer(candidate);
    } catch {
      score = -Infinity;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best || bestScore <= 0) {
    return doc.body || doc.documentElement;
  }

  return best;
}

export default { shouldStripElement, scoreContainer, findBestContainer };
