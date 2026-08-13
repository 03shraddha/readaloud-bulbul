/**
 * src/content/extract/article.js
 *
 * The 'article' Extractor (shared_contracts §1) — the universal fallback
 * for any page that isn't X/Twitter. Wires together the lib/ modules:
 *   - readability-lite.js  -> pick the best content container
 *   - dom-walk.js / visibility.js (via readability-lite + range-mapper)
 *   - block-summarizer.js  -> code/table/image summaries
 *   - range-mapper.js       -> per-sentence text + DOM-range locators
 *
 * Never throws out of a public method: every one of the Extractor
 * interface methods below is wrapped so a failure is logged and degraded
 * (empty result / null / false) instead of propagating.
 */

import { normalizeForSpeech, isPunctuationOnly } from '../../shared/text/normalize.js';
import { contentHashFromSentences } from '../../shared/hash.js';
import { articleContentKey } from '../../shared/keys.js';
import { MAX_SENTENCE_CHARS } from '../../shared/constants.js';
import { createLogger } from '../../shared/logger.js';

import { findBestContainer, shouldStripElement } from './lib/readability-lite.js';
import { isElementVisible } from './lib/visibility.js';
import { scrollIntoViewSmart } from './lib/scroll.js';
import { isCodeBlock, isTable, summarizeCodeBlock, summarizeTable } from './lib/block-summarizer.js';
import { extractSentencesWithLocators, resolveLocatorToRange, resolveNodeFromPath } from './lib/range-mapper.js';
import { walkDOM } from './lib/dom-walk.js';

const fallbackLog = createLogger('content:article:fallback');

const HEADING_RE = /^H[1-6]$/;

/** Bounded scroll-reveal pass -- see revealLazyContent()'s doc comment. */
const REVEAL_STEP_WAIT_MS = 120;
const REVEAL_MAX_STEPS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Some sites lazy-reveal body content based on scroll position -- an
 * IntersectionObserver-driven fade-in library, typically -- leaving the
 * whole content subtree at `display:none` (or equivalent) until scrolled
 * near, then it stays revealed permanently (confirmed live on a Deepgram
 * blog post this way: scrolling back to the top afterward does NOT
 * re-hide it). buildUnits() runs immediately on activation, before any
 * scrolling happens, so on such a page it sees nothing and every
 * paragraph is silently dropped.
 *
 * This scrolls top-to-bottom once (bounded, so a pathological/infinite-
 * scroll page can't hang activation), then restores the original scroll
 * position -- the reveal itself is what matters, not where the user ends
 * up looking. Only called as a fallback when the normal extraction pass
 * already came back empty despite the container clearly having real
 * text, so pages that don't need this pay nothing for it.
 * @returns {Promise<void>}
 */
async function revealLazyContent() {
  const originalY = window.scrollY;
  const step = Math.max(window.innerHeight || 800, 400);

  try {
    for (let i = 0; i < REVEAL_MAX_STEPS; i++) {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const target = Math.min((i + 1) * step, Math.max(0, maxScroll));
      window.scrollTo(0, target);
      await sleep(REVEAL_STEP_WAIT_MS);
      if (target >= maxScroll) break;
    }
  } finally {
    window.scrollTo(0, originalY);
    await sleep(REVEAL_STEP_WAIT_MS);
  }
}

/**
 * @param {Element} el
 * @returns {import('../../shared/types.js').ReadUnit['kind']|null}
 */
function classifyElement(el) {
  const tag = el.tagName;

  if (HEADING_RE.test(tag)) return 'heading';
  if (tag === 'P') return 'paragraph';
  if (tag === 'LI') return 'list-item';
  if (tag === 'BLOCKQUOTE') return 'quote';
  if (tag === 'FIGCAPTION' || tag === 'CAPTION') return 'caption';
  if (isTable(el)) return 'table-summary';
  if (isCodeBlock(el)) return 'code-summary';
  // Images are deliberately never classified/read -- announcing "image
  // described as: ..." for every <img> got in the way of actually reading
  // the page, across every site tested. A real <figcaption>/<caption>
  // (handled above) still gets read on its own -- it's content the author
  // actually wrote, unlike alt text, which is frequently absent, generic,
  // or auto-generated.

  return null;
}

/**
 * @param {string} unitId
 * @param {string} kind
 * @param {string} rawSummaryText
 * @param {Element} el
 * @param {string} languageCode
 * @returns {import('../../shared/types.js').ReadUnit|null}
 */
function buildSummaryUnit(unitId, kind, rawSummaryText, el, languageCode) {
  const normalized = normalizeForSpeech(rawSummaryText);
  if (!normalized || isPunctuationOnly(normalized)) return null;

  const text = normalized.length > MAX_SENTENCE_CHARS ? normalized.slice(0, MAX_SENTENCE_CHARS) : normalized;

  const sentence = {
    id: `${unitId}::0`,
    unitId,
    index: -1, // assigned by content/main.js before this ever leaves article.js
    text,
    languageCode,
    anchorKind: 'element',
    locator: { kind: 'element', element: el, containerRef: el, path: [] },
  };

  return { id: unitId, kind, label: null, sentences: [sentence], meta: {} };
}

/**
 * @param {string} unitId
 * @param {string} kind
 * @param {Element} el
 * @param {string} languageCode
 * @param {{ shouldDescend?: (el: Element) => boolean }} [rangeOptions]
 * @returns {import('../../shared/types.js').ReadUnit|null}
 */
function buildTextUnit(unitId, kind, el, languageCode, rangeOptions) {
  let mapped = [];
  try {
    mapped = extractSentencesWithLocators(el, rangeOptions);
  } catch (err) {
    fallbackLog.warn('extractSentencesWithLocators threw', err);
    mapped = [];
  }

  const sentences = [];
  let localIndex = 0;
  for (const item of mapped) {
    if (!item || !item.text || isPunctuationOnly(item.text)) continue;
    sentences.push({
      id: `${unitId}::${localIndex}`,
      unitId,
      index: -1,
      text: item.text,
      languageCode,
      anchorKind: item.locator ? 'dom-range' : 'virtual',
      locator: item.locator,
    });
    localIndex++;
  }

  if (!sentences.length) return null;

  return { id: unitId, kind, label: null, sentences, meta: { tag: el.tagName ? el.tagName.toLowerCase() : '' } };
}

/**
 * @param {Element} el
 * @param {string} kind
 * @param {number} ordinal
 * @param {string} languageCode
 * @returns {import('../../shared/types.js').ReadUnit|null}
 */
function buildUnitForElement(el, kind, ordinal, languageCode) {
  const unitId = `u${ordinal}`;

  if (kind === 'code-summary') {
    return buildSummaryUnit(unitId, kind, summarizeCodeBlock(el), el, languageCode);
  }
  if (kind === 'table-summary') {
    return buildSummaryUnit(unitId, kind, summarizeTable(el), el, languageCode);
  }

  return buildTextUnit(unitId, kind, el, languageCode);
}

/**
 * Walk `container`'s classified descendants (heading/paragraph/list-item/
 * quote/caption/code-summary/table-summary) in DOM order, never
 * descending further once an element has been claimed as a unit (so a <p>
 * inside a <blockquote> doesn't also become its own separate paragraph).
 * @param {Element} container
 * @param {string} languageCode
 * @returns {{ units: import('../../shared/types.js').ReadUnit[], sentenceTexts: Array<{text:string}> }}
 */
function buildUnits(container, languageCode) {
  /** @type {import('../../shared/types.js').ReadUnit[]} */
  const units = [];
  const sentenceTexts = [];
  let ordinal = 1;

  const shouldDescend = (el) => {
    if (el === container) return true;
    if (shouldStripElement(el)) return false;
    return classifyElement(el) === null;
  };

  for (const node of walkDOM(container, { shouldDescend })) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node === container) continue;

    const el = /** @type {Element} */ (node);
    if (shouldStripElement(el)) continue;

    const kind = classifyElement(el);
    if (!kind) continue;

    let visible = true;
    try {
      visible = isElementVisible(el);
    } catch {
      visible = true;
    }
    if (!visible) continue;

    let unit = null;
    try {
      unit = buildUnitForElement(el, kind, ordinal, languageCode);
    } catch (err) {
      fallbackLog.warn('failed to build unit', kind, err);
      unit = null;
    }

    if (unit && unit.sentences.length) {
      units.push(unit);
      ordinal++;
      for (const s of unit.sentences) sentenceTexts.push({ text: s.text });
    }
  }

  if (units.length === 0) {
    // Degrade gracefully for markup that doesn't use any recognized
    // block tags at all (plain-text-ish pages): read the whole container
    // as a single paragraph-kind unit, still respecting strip rules.
    const fallbackShouldDescend = (el) => !shouldStripElement(el);
    const fallbackUnit = buildTextUnit('u1', 'paragraph', container, languageCode, {
      shouldDescend: fallbackShouldDescend,
    });
    if (fallbackUnit && fallbackUnit.sentences.length) {
      units.push(fallbackUnit);
      for (const s of fallbackUnit.sentences) sentenceTexts.push({ text: s.text });
    }
  }

  return { units, sentenceTexts };
}

/**
 * @returns {Element|null} the page's title heading, if one is visible.
 */
/**
 * @param {string} s
 * @returns {string}
 */
function normalizeForTitleMatch(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function findTitleElement() {
  let candidates = [];
  try {
    candidates = Array.from(document.querySelectorAll('h1')).filter((el) => {
      try {
        return isElementVisible(el);
      } catch {
        return true;
      }
    });
  } catch {
    candidates = [];
  }

  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  // More than one visible <h1> usually means the SITE's own masthead/brand
  // heading and every body subsection heading are ALSO literally <h1> --
  // confirmed live on a Substack post, where the publication's name, the
  // real post title, and every section heading in the body were all <h1>,
  // distinguished only by class. `document.querySelector('h1')` (the old
  // behavior) grabbed the FIRST one in DOM order, which was the site's
  // masthead name, not the post title, since a global header always comes
  // before the article in the DOM. `document.title` conventionally starts
  // with the actual page/article title on virtually every site, so prefer
  // whichever <h1>'s text the document title actually starts with over
  // just taking the first one.
  const docTitle = normalizeForTitleMatch(document.title || '');
  if (docTitle) {
    for (const el of candidates) {
      const text = normalizeForTitleMatch((el.textContent || '').trim());
      if (text && docTitle.startsWith(text)) return el;
    }
  }
  return candidates[0];
}

/**
 * @returns {string}
 */
function pickTitle() {
  const h1 = findTitleElement();
  if (h1) {
    const text = (h1.textContent || '').trim();
    if (text) return text;
  }
  return (document.title && document.title.trim()) || location.hostname || 'Untitled';
}

/**
 * @param {import('../../shared/types.js').Sentence} sentence
 * @returns {Node|null}
 */
function getScrollTarget(sentence) {
  const locator = sentence && sentence.locator;
  if (!locator) return null;

  if (locator.kind === 'element') {
    return locator.element || null;
  }

  const node = locator.startNode || locator.containerRef;
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

/**
 * @param {object} locator
 * @returns {Element|null}
 */
function resolveElementLocator(locator) {
  if (!locator || locator.kind !== 'element') return null;

  if (locator.element && locator.element.isConnected) {
    return locator.element;
  }

  // Best-effort re-resolution: element-kind locators are single nodes, so
  // containerRef === the element itself and path is empty; there's no
  // richer index-path to re-walk for these (unlike dom-range locators),
  // so if it's detached there's nothing more to try.
  if (locator.containerRef && locator.containerRef.isConnected && Array.isArray(locator.path)) {
    const resolved = resolveNodeFromPath(locator.containerRef, locator.path);
    if (resolved && resolved.nodeType === Node.ELEMENT_NODE) return /** @type {Element} */ (resolved);
  }

  return null;
}

const articleExtractor = {
  id: 'article',

  /**
   * The article extractor is the universal fallback — cheap and always
   * eligible; the registry only reaches it when no more specific extractor
   * matched.
   * @returns {boolean}
   */
  matches() {
    return true;
  },

  /**
   * @param {import('../../shared/types.js').ExtractorInitContext} ctx
   */
  async init(ctx) {
    try {
      this._log = (ctx && ctx.log) || fallbackLog;
      this._settings = (ctx && ctx.settings) || {};
    } catch (err) {
      this._log = fallbackLog;
      this._settings = {};
      fallbackLog.error('init failed', err);
    }
  },

  /**
   * @returns {Promise<import('../../shared/types.js').ExtractResult>}
   */
  async extract() {
    const log = this._log || fallbackLog;
    try {
      const languageCode = (this._settings && this._settings.languageCode) || 'en-IN';
      const container = findBestContainer(document);
      let { units, sentenceTexts } = buildUnits(container, languageCode);

      // Signature of scroll-gated lazy content (see revealLazyContent()):
      // the container has substantial real text but produced zero units,
      // meaning everything in it was invisible at extraction time.
      if (units.length === 0 && (container.textContent || '').trim().length > 200) {
        await revealLazyContent();
        ({ units, sentenceTexts } = buildUnits(container, languageCode));
      }

      // Many component-based site templates render the page's <h1> in a
      // "hero"/header section that's a SIBLING of the main content
      // container, not a descendant of it (confirmed live on a Deepgram
      // blog post: the <h1> sits in <section id="blog-detail-hero">, next
      // to -- not inside -- the <article> tag findBestContainer() picks).
      // buildUnits() only ever walks inside `container`, so when this
      // happens the title is silently never spoken at all, even though
      // pickTitle() below (used only for the metadata `title` field) finds
      // it fine. Prepend it as its own heading unit whenever it's genuinely
      // not already going to be picked up by the normal walk -- the
      // `container.contains()` check is what keeps this a no-op (not a
      // duplicate read) on the many pages where the title already sits
      // inside the detected container.
      const titleEl = findTitleElement();
      if (titleEl && !container.contains(titleEl)) {
        const titleUnit = buildUnitForElement(titleEl, 'heading', 0, languageCode);
        if (titleUnit && titleUnit.sentences.length) {
          units.unshift(titleUnit);
          sentenceTexts.unshift(...titleUnit.sentences.map((s) => ({ text: s.text })));
        }
      }

      const contentHash = contentHashFromSentences(sentenceTexts);
      const contentKey = articleContentKey(location.href, contentHash);
      const title = pickTitle();

      return { units, contentKey, contentHash, title, exhausted: true };
    } catch (err) {
      log.error('extract failed', err);
      const contentHash = 'error';
      let contentKey = 'article:error:error';
      try {
        contentKey = articleContentKey(location.href, contentHash);
      } catch {
        // keep the static fallback above
      }
      return {
        units: [],
        contentKey,
        contentHash,
        title: (document.title && document.title.trim()) || '',
        exhausted: true,
      };
    }
  },

  /**
   * Articles never have more content to load after the first pass.
   * @returns {Promise<import('../../shared/types.js').ExtractResult>}
   */
  async extractMore() {
    return { units: [], exhausted: true };
  },

  /**
   * @param {import('../../shared/types.js').Sentence} sentence
   * @returns {Promise<{kind:'range', range: Range}|{kind:'element', element: Element}|null>}
   */
  async resolveAnchor(sentence) {
    const log = this._log || fallbackLog;
    try {
      const locator = sentence && sentence.locator;
      if (!locator) return null;

      if (locator.kind === 'element') {
        const element = resolveElementLocator(locator);
        return element ? { kind: 'element', element } : null;
      }

      const range = resolveLocatorToRange(locator, sentence.text);
      return range ? { kind: 'range', range } : null;
    } catch (err) {
      log.error('resolveAnchor failed', err);
      return null;
    }
  },

  /**
   * @param {import('../../shared/types.js').Sentence} sentence
   * @returns {Promise<boolean>}
   */
  async ensureVisible(sentence) {
    const log = this._log || fallbackLog;
    try {
      const autoScroll = this._settings ? this._settings.autoScroll !== false : true;
      if (!autoScroll) return true; // scrolling disabled by settings; nothing to do, not a failure

      const target = getScrollTarget(sentence);
      if (!target) return false;

      // No-ops when the target is already comfortably on screen, instead of
      // re-centering on every single sentence -- see lib/scroll.js.
      scrollIntoViewSmart(target, { behavior: 'smooth', block: 'center' });
      return true;
    } catch (err) {
      log.error('ensureVisible failed', err);
      return false;
    }
  },

  dispose() {
    this._log = null;
    this._settings = null;
  },
};

// Exposed for tests/debugging only; the Extractor interface is the default export.
export { classifyElement, buildUnits, pickTitle };

export default articleExtractor;
