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
  // Themes that run the words together (kk.org's Technium uses
  // #maincontent > .entrybody). Without these the finder fell back to
  // document.body and read the sidebar's post list before the essay.
  '.entrybody',
  '.entry-body',
  '#maincontent',
  '#main-content',
].join(', ');

// HEADER is deliberately NOT in this unconditional set -- see the
// container-aware check in shouldStripElement() below for why.
const STRIP_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'FORM', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// NOTE: IFRAME is deliberately NOT in this list. dom-walk.js already
// descends into same-origin iframes and hard-skips cross-origin ones (the
// large majority of ad/tracker/comment-widget embeds are cross-origin), so
// same-origin content frames still contribute text/paragraphs to scoring
// while most boilerplate iframes are excluded for free.

const STRIP_ROLE_RE = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|toolbar|menu|menubar)$/i;

// `newsletter` has a negative lookahead excluding `-post`/`-body`/
// `-content`/`-article` suffixes: it's meant to strip "subscribe to my
// newsletter" promo widgets, but Substack's OWN platform-wide class for
// the real post body is literally `newsletter-post` -- confirmed live,
// this stripped the entire article on every Substack post, always
// falling back to scoring document.body (which then also strips the same
// real content out of the fallback walk), leaving nothing real to read.
const STRIP_CLASS_ID_RE =
  /\b(ad|ads|advert(?:isement)?s?|sponsor(?:ed)?|promo(?:tion)?s?|social[-_]?share|share[-_]?bar|comments?|related[-_]?(?:posts?|articles?)|sidebar|newsletter(?!-(?:post|body|content|article)\b)|cookie[-_]?(?:banner|notice|consent)|popup|modal|site[-_]?header|site[-_]?footer|masthead|breadcrumbs?|pagination|nav(?:bar|igation)?|menu|widget|skip[-_]?link|subscribe|paywall)\b/i;

/**
 * `shouldStripElement` is called from two different moments with two
 * different notions of "the container": during candidate SCORING (before
 * any root has been chosen -- see `scoreContainer` below) the container is
 * whichever candidate is currently being walked; during actual UNIT
 * EXTRACTION (`buildUnits` in article.js, after `findBestContainer` has
 * already picked a winner) the container is that winner. Both callers pass
 * the same value they're already walking, so a `<header>` visited during
 * either pass is, by construction, always inside the container relevant to
 * that pass -- there's no separate "not chosen yet" state to special-case.
 *
 * @param {Element} el
 * @param {Element} [container] - the container this call is scoring or
 *   extracting from. Only consulted for `<header>` (see below); every other
 *   stripped tag/role/class is page chrome regardless of nesting.
 * @returns {boolean} true if this element (and everything under it) should
 *   be excluded from scoring and unit extraction.
 */
/** container -> length of its text, so the majority check below costs one
 * textContent read per container, not one per stripped element. */
const containerTextLengthCache = new WeakMap();

/**
 * @param {Element} container
 * @returns {number}
 */
function containerTextLength(container) {
  if (containerTextLengthCache.has(container)) return containerTextLengthCache.get(container);
  const length = (container.textContent || '').length;
  containerTextLengthCache.set(container, length);
  return length;
}

/** Share of the container's text above which a class/role match is treated
 * as a naming accident, not as page chrome. */
const STRIP_MAJORITY_SHARE = 0.7;

/** Names the majority rule never rescues. A long comment thread or a wall
 * of related links can truly outweigh a short post, and must stay out. */
const ALWAYS_STRIP_NAME_RE = /comment|disqus|related|cookie|paywall/i;

/**
 * The class/id and role rules are guesses from a name. They are right for a
 * sidebar or a share bar, and badly wrong when a theme names its main
 * wrapper something like `has-sidebar`, `single-post-with-comments` or
 * `modal-page`: the whole article sat under one "stripped" element and
 * nothing was read. Real chrome is a small part of the container it sits
 * in. An element that holds most of the container's text is the content.
 * @param {Element} el
 * @param {Element} [container]
 * @param {string} [name] - the id/class/role text that matched a strip rule
 * @returns {boolean}
 */
function holdsMostOfContainer(el, container, name = '') {
  if (!container || el === container) return false;
  if (name && ALWAYS_STRIP_NAME_RE.test(name)) return false;
  try {
    if (typeof container.contains === 'function' && !container.contains(el)) return false;
    const total = containerTextLength(container);
    if (total < 200) return false; // too little text for a share to mean anything
    return (el.textContent || '').length >= total * STRIP_MAJORITY_SHARE;
  } catch {
    return false;
  }
}

export function shouldStripElement(el, container) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

  if (el.tagName === 'HEADER') {
    // WordPress/Ghost/Hugo themes put the post title, dek/standfirst, and
    // byline inside <header class="entry-header"> INSIDE the article --
    // confirmed live, stripping HEADER unconditionally (the old behavior)
    // made all of that invisible to both scoring and extraction, the
    // single broadest content-loss rule in this file. A <header> is only
    // page chrome (site masthead/nav wrapper) when it sits OUTSIDE the
    // container currently being scored/extracted; a <header> the caller
    // hasn't told us anything about (no `container` argument) is treated
    // as chrome, matching the old, safer default.
    if (container && typeof container.contains === 'function' && container.contains(el)) {
      return false;
    }
    return true;
  }

  if (STRIP_TAGS.has(el.tagName)) return true;

  const role = el.getAttribute ? el.getAttribute('role') : null;
  if (role && STRIP_ROLE_RE.test(role.trim())) return !holdsMostOfContainer(el, container, role);

  const className = typeof el.className === 'string' ? el.className : '';
  const idAndClass = `${el.id || ''} ${className}`.trim();
  if (idAndClass && STRIP_CLASS_ID_RE.test(idAndClass)) return !holdsMostOfContainer(el, container, idAndClass);

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

  // `el` IS the container for this pass -- walkDOM only ever visits `el`'s
  // own descendants, so any <header> encountered here already sits inside
  // the very candidate being scored (see shouldStripElement()'s doc
  // comment). Defined per-call (not hoisted) so it closes over the right
  // `el` when multiple candidates are scored in the same findBestContainer() pass.
  const shouldDescend = (candidate) => !shouldStripElement(candidate, el);

  for (const node of walkDOM(el, { shouldDescend })) {
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

/** A <p> shorter than this is a caption, a byline or a button label. */
const CLUSTER_MIN_PARAGRAPH_CHARS = 80;
/** Cap on <p> elements inspected, so a huge page cannot stall activation. */
const CLUSTER_MAX_PARAGRAPHS = 600;
/** A selector-based winner holding at least this share of the page's long
 * paragraphs is trusted as-is. */
const CLUSTER_TRUST_SHARE = 0.5;
/** A paragraph cluster must hold at least this share to replace it. */
const CLUSTER_TAKEOVER_SHARE = 0.6;

/**
 * Where the page's long paragraphs live, for pages the selector list above
 * does not describe: div-only layouts with no <article>/<main>, or a page
 * whose `.content` class sits on a small box while the essay is elsewhere.
 *
 * Classic Readability idea: every long <p> votes for its parent (full
 * weight) and grandparent (half weight). The elements with the most votes
 * are the tightest wrappers around the prose.
 * @param {Document} doc
 * @returns {{ candidates: Element[], longParagraphs: Element[] }}
 */
function findParagraphClusters(doc) {
  /** @type {Element[]} */
  let paragraphs = [];
  try {
    paragraphs = Array.from(doc.querySelectorAll('p')).slice(0, CLUSTER_MAX_PARAGRAPHS);
  } catch {
    paragraphs = [];
  }

  const votes = new Map();
  const longParagraphs = [];
  for (const p of paragraphs) {
    const length = (p.textContent || '').trim().length;
    if (length < CLUSTER_MIN_PARAGRAPH_CHARS) continue;
    longParagraphs.push(p);

    const parent = p.parentElement;
    if (!parent) continue;
    votes.set(parent, (votes.get(parent) || 0) + length);
    const grandparent = parent.parentElement;
    if (grandparent) votes.set(grandparent, (votes.get(grandparent) || 0) + length / 2);
  }

  const root = doc.documentElement;
  const candidates = Array.from(votes.entries())
    .filter(([el]) => el !== doc.body && el !== root)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([el]) => el);

  return { candidates, longParagraphs };
}

/**
 * @param {Element} el
 * @param {Element[]} paragraphs
 * @returns {number} share (0..1) of `paragraphs` that sit inside `el`.
 */
function paragraphShare(el, paragraphs) {
  if (!el || !paragraphs.length) return 0;
  let inside = 0;
  for (const p of paragraphs) {
    if (el.contains(p)) inside++;
  }
  return inside / paragraphs.length;
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
    // >= rather than > : querySelectorAll returns document order, so an
    // ancestor wrapper always comes before a descendant candidate it
    // contains. When one candidate merely wraps another with no
    // additional scoreable text of its own, the two tie exactly --
    // confirmed live on a Substack post, where a generic wrapper <div>
    // around the real <article> scored identically to the <article>
    // itself, and (with `>` here) the looser wrapper won by having been
    // seen first, pulling in sibling boilerplate the tighter <article>
    // would have excluded. Preferring the LAST equal-or-better score
    // means a tied descendant (the more specific match) wins instead.
    if (score >= bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // Second opinion, only when the selector-based pick looks wrong: it found
  // nothing, or it holds under half of the page's long paragraphs (the
  // essay is somewhere else). A pick that already holds most of the prose
  // is returned untouched, so pages that worked before behave the same.
  let clusters = { candidates: [], longParagraphs: [] };
  try {
    clusters = findParagraphClusters(doc);
  } catch {
    clusters = { candidates: [], longParagraphs: [] };
  }
  const { longParagraphs } = clusters;
  const haveWinner = !!best && bestScore > 0;

  if (longParagraphs.length >= 3) {
    const winnerShare = haveWinner ? paragraphShare(best, longParagraphs) : 0;
    if (!haveWinner || winnerShare < CLUSTER_TRUST_SHARE) {
      let bestCluster = null;
      let bestClusterScore = -Infinity;
      for (const candidate of clusters.candidates) {
        if (paragraphShare(candidate, longParagraphs) < CLUSTER_TAKEOVER_SHARE) continue;
        let score = -Infinity;
        try {
          score = scoreContainer(candidate);
        } catch {
          score = -Infinity;
        }
        if (score > bestClusterScore) {
          bestClusterScore = score;
          bestCluster = candidate;
        }
      }
      if (bestCluster && bestClusterScore > 0 && (!haveWinner || bestClusterScore > bestScore)) {
        return bestCluster;
      }
    }
  }

  if (!haveWinner) {
    return doc.body || doc.documentElement;
  }

  return best;
}

export default { shouldStripElement, scoreContainer, findBestContainer };
