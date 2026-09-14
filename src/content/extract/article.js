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

// Minimum fraction of the container's raw text that must have made it into
// spoken sentences before extract() accepts the result as-is, instead of
// running revealLazyContent() and re-extracting once. This is deliberately
// well below 1.0: normalizeForSpeech legitimately shortens text (URLs
// stripped, whitespace collapsed) and buildUnits() legitimately strips real
// in-container chrome (a stray NAV/FOOTER widget, a <header> that turned out
// to be page-level -- see shouldStripElement()), so SOME shrinkage on every
// normal page is expected and must not falsely trigger a reveal pass. 0.5
// was chosen because those combined, ordinary losses rarely account for
// anywhere near half of a real article's raw text; falling below that is a
// much stronger signal that a large fraction of the container was actually
// invisible at extraction time (e.g. behind a scroll-gated fade-in), the
// partial version of the all-or-nothing bug this constant generalizes.
const REVEAL_MIN_EXTRACTION_RATIO = 0.5;

// Below this many raw characters, ratio-based comparisons are too noisy to
// trust (a couple of stripped words can swing the ratio wildly) and there's
// too little content for a missed chunk to matter much anyway -- matches
// the threshold the original all-or-nothing check already used.
const REVEAL_MIN_CONTAINER_CHARS = 200;

// Text-length gate for classifying a <div> as a paragraph (see the DIV
// branch of classifyElement() below). The old value (30) dropped short
// div-based headings, one-line paragraphs, and pull-quotes on div-based
// platforms -- Substack and Medium build paragraphs out of <div>, not <p>
// (see docs/SUBSTACK_FIX.md). Lowered to 10: everything actually observed
// under that length is pure UI chrome text -- icon-only divs, single-word
// badges/labels ("New", "Menu", "3"), close-button glyphs -- while anything
// genuinely authored (a short pull-quote, a one-line dek) tends to run at
// least a few words, comfortably over 10 characters.
const DIV_PARAGRAPH_MIN_CHARS = 10;

// Tags/classes that make an element classify as a unit in classifyElement()
// below, used ONLY by hasClassifyingDescendant() to answer "does this DIV's
// subtree contain something that must stay its own unit". Deliberately NOT
// a 1:1 mirror of classifyElement(): it leaves out the DIV-as-paragraph case
// itself (checking that recursively is exactly the O(n^2) blow-up this
// selector-based approach exists to avoid -- see hasClassifyingDescendant()),
// and it can only exact-token-match the code-highlighter classes
// isCodeBlock() also accepts via a prefix (`language-*`, `highlighter-*`,
// `syntax-highlight*`) -- a CSS class selector matches a whole token, not a
// prefix within one. That's an accepted, narrow miss (the same failure this
// file already had for those specific prefix-class cases, not a new one),
// not a regression for the PRE/TABLE/list/heading shapes this constant is
// here to fix.
const CLASSIFIABLE_DESCENDANT_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'blockquote',
  'figcaption',
  'caption',
  'table',
  'pre',
  'dt',
  'dd',
  'summary',
  'address',
  '.highlight',
  '.codehilite',
  '.hljs',
  '.prettyprint',
].join(', ');

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
 * came back short of `REVEAL_MIN_EXTRACTION_RATIO` despite the container
 * clearly having real text (see extract()'s ratio check, which covers both
 * the all-or-nothing case -- zero units -- AND the partial case: a page
 * whose first couple of paragraphs render immediately while the rest sit
 * behind the same scroll-gated fade never hits zero units, so it needs
 * this too), so pages that don't need this pay nothing for it.
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
 * Answers "does this DIV's subtree contain something that must stay its own
 * unit", for the DIV branch of classifyElement() below. Checks the WHOLE
 * subtree, not just direct children: a one-level-only check let
 * `<div><div><pre>...50 lines...</pre></div></div>` through, because the
 * INNER div's own check (its only child, PRE, classifies) correctly
 * declined to self-classify, but the OUTER div only ever looked at that
 * inner div -- itself a non-classifying DIV as far as a shallow check is
 * concerned -- and claimed the whole subtree as one paragraph, reading the
 * code block character-by-character instead of summarizing it. The same
 * shape drops a `<div><figure><table>...</table></figure></div>` (every
 * cell read as prose) and merges every `<li>` in a `<div><ul>...</ul></div>`
 * into one unit.
 *
 * Uses a single native `querySelector` call rather than a recursive
 * `classifyElement` walk over every descendant: the latter is O(n^2) on
 * deep div soup (each level would re-walk everything below it), while one
 * `querySelector` call per DIV is native, well-optimized, and does far less
 * work per node than reimplementing classifyElement's own checks (text
 * length, table/code-block detection) at every level.
 * @param {Element} el
 * @returns {boolean}
 */
function hasClassifyingDescendant(el) {
  try {
    if (typeof el.querySelector === 'function') {
      return !!el.querySelector(CLASSIFIABLE_DESCENDANT_SELECTOR);
    }
  } catch {
    // fall through to the defensive fallback below
  }
  // Only reached if querySelector is missing/throws -- shouldn't happen on
  // a real DOM element. Degrades to the old one-level check rather than a
  // full recursive walk, so this rare fallback can't reintroduce the O(n^2)
  // cost the querySelector path above exists to avoid.
  for (const child of el.children || []) {
    if (child.nodeType === Node.ELEMENT_NODE && classifyElement(child)) return true;
  }
  return false;
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
  // DT/DD/SUMMARY/ADDRESS were in no branch at all, so a <dl> (a definition
  // list) or a <details>/<summary> disclosure widget or postal/contact
  // <address> block sitting directly under the content root was dropped
  // entirely -- buildUnits() never had a kind for them to classify as, so
  // it fell straight through to "not a unit" and skipped them. DT/SUMMARY
  // read like a short heading-style label; DD/ADDRESS read like prose.
  if (tag === 'DT' || tag === 'SUMMARY') return 'heading';
  if (tag === 'DD' || tag === 'ADDRESS') return 'paragraph';
  if (isTable(el)) return 'table-summary';
  if (isCodeBlock(el)) return 'code-summary';
  // Images are deliberately never classified/read -- announcing "image
  // described as: ..." for every <img> got in the way of actually reading
  // the page, across every site tested. A real <figcaption>/<caption>
  // (handled above) still gets read on its own -- it's content the author
  // actually wrote, unlike alt text, which is frequently absent, generic,
  // or auto-generated.

  // Substack, Medium, and other platforms use <div> elements for
  // paragraphs. Classify as a paragraph if it's a div with meaningful text
  // and nothing classifiable anywhere in its subtree -- see
  // hasClassifyingDescendant()'s comment for why this must be a subtree-wide
  // check, not a one-level one.
  if (tag === 'DIV') {
    const text = (el.textContent || '').trim();
    if (text.length > DIV_PARAGRAPH_MIN_CHARS && !hasClassifyingDescendant(el)) {
      return 'paragraph';
    }
  }

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
    if (shouldStripElement(el, container)) return false;
    return classifyElement(el) === null;
  };

  for (const node of walkDOM(container, { shouldDescend })) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node === container) continue;

    const el = /** @type {Element} */ (node);
    if (shouldStripElement(el, container)) continue;

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
    const fallbackShouldDescend = (el) => !shouldStripElement(el, container);
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
 * @returns {Node|Range|null}
 */
function getScrollTarget(sentence) {
  const locator = sentence && sentence.locator;
  if (!locator) return null;

  if (locator.kind === 'element') {
    return locator.element || null;
  }

  // Scroll to the sentence's own range, not its whole containing paragraph:
  // a paragraph (or, via buildUnits()'s whole-container fallback, the
  // entire article) is routinely taller than the viewport, and handing that
  // to scrollIntoViewSmart as a "normal" target used to force it to fully
  // contain something it structurally never could (see scroll.js's file
  // header). Fall back to the parent element only when the range itself
  // doesn't resolve (detached nodes, stale locator).
  const range = resolveLocatorToRange(locator, sentence.text);
  if (range) return range;

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
      // the container has substantial real text but only a small fraction
      // of it made it into spoken sentences, meaning much of it was
      // invisible at extraction time. units.length === 0 (the old,
      // all-or-nothing check) is just the ratio === 0 special case of this
      // same signature -- a page where the first two paragraphs render
      // immediately and the rest sit behind a scroll-gated fade produces a
      // handful of units, never zero, and used to silently drop everything
      // after them with no error and no toast. Computed and compared ONCE,
      // so revealLazyContent() (and the re-extraction after it) can only
      // ever run a single time per extract() call -- never twice, and
      // `units`/`sentenceTexts` are REPLACED, not appended to, so nothing
      // is double-counted if the second pass finds the same visible units
      // the first pass already found.
      const containerTextLength = (container.textContent || '').trim().length;
      const extractedTextLength = sentenceTexts.reduce((sum, s) => sum + ((s && s.text) || '').length, 0);
      const extractionRatio = containerTextLength > 0 ? extractedTextLength / containerTextLength : 1;
      if (containerTextLength > REVEAL_MIN_CONTAINER_CHARS && extractionRatio < REVEAL_MIN_EXTRACTION_RATIO) {
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
          // Mirrors x-article-parser.js's buildTitleUnit(): this title is
          // prepended precisely because it sits OUTSIDE `container` (see
          // the comment above), typically right at the top of the page.
          // ensureVisible()'s default 'center' block would scroll DOWN away
          // from an <h1> already at the top of the viewport the moment
          // reading starts -- a jarring, unnecessary move. 'start'/'auto'
          // anchor it to the top instead, as an instant jump rather than an
          // animated scroll, so no late-loading content above it (a hero
          // image, an ad) gets a window to shift layout mid-flight. Set
          // directly on each sentence's own locator -- ensureVisible()
          // already reads `locator.scrollBlock`/`scrollBehavior` off
          // whatever locator getScrollTarget() resolved, unchanged here.
          for (const s of titleUnit.sentences) {
            if (s.locator) {
              s.locator.scrollBlock = 'start';
              s.locator.scrollBehavior = 'auto';
            }
          }
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
      // `locator.scrollBlock`/`scrollBehavior` let a specific locator (e.g.
      // a title unit sitting right at the top of the page) override the
      // defaults, exactly as x-article-parser.js's ensureArticleVisible()
      // does -- centering an element already at the top would actively
      // scroll DOWN away from it.
      const locator = sentence && sentence.locator;
      scrollIntoViewSmart(target, {
        behavior: (locator && locator.scrollBehavior) || 'smooth',
        block: (locator && locator.scrollBlock) || 'center',
      });
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
