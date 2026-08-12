/**
 * src/content/extract/lib/x-article-parser.js
 *
 * X's long-form "Articles" feature (opened from a status page, e.g.
 * `/<user>/status/<id>`) renders its body in a COMPLETELY SEPARATE
 * `article[data-testid="twitterArticleReadView"]` element -- distinct from
 * `article[data-testid="tweet"]` (SELECTORS.article), which is what the rest
 * of this extractor is built around. None of this is publicly documented;
 * the structure below was confirmed by direct DOM inspection of a real
 * Article post:
 *
 *   article[data-testid="twitterArticleReadView"]
 *     [data-testid="twitter-article-title"]        <- plain heading text
 *     [data-testid="twitterArticleRichTextView"]
 *       ... n wrapper divs, each with exactly one child ...
 *         [data-testid="longformRichTextComponent"]
 *           (one div) > N sibling "blocks", each either:
 *             - a <section> containing an <img>, or
 *             - a <div> whose text lives on a <span> leaf several levels
 *               down -- NOT a <p> tag, so article.js's tag-based
 *               `classifyElement()`/`buildUnits()` never recognizes these
 *               as paragraphs and silently skips them. That's why reusing
 *               those wholesale doesn't work here; this module instead
 *               treats each sibling block as one unit directly and reuses
 *               only the lower-level, tag-agnostic pieces: range-mapper.js's
 *               `extractSentencesWithLocators`/`resolveLocatorToRange` (the
 *               same DOM-range sentence anchoring the generic article
 *               extractor uses) and block-summarizer.js's `summarizeImage`.
 *
 * Sentences produced here carry `locator.articleView = true` so twitter.js's
 * resolveAnchor()/ensureVisible() can tell them apart from ordinary
 * tweet-locator sentences (which have no such field) and route them here.
 */

import { normalizeForSpeech, isPunctuationOnly } from '../../../shared/text/normalize.js';
import { summarizeImage } from './block-summarizer.js';
import { isElementVisible } from './visibility.js';
import { extractSentencesWithLocators, resolveLocatorToRange } from './range-mapper.js';
import { SELECTORS, querySelector } from './x-selectors.js';
import { scrollIntoViewSmart } from './scroll.js';

/**
 * @param {Location} location
 * @returns {string|null}
 */
function statusIdFromLocation(location) {
  const pathname = location?.pathname || '';
  const match = pathname.match(/^\/(?:i|[^/]+)\/status\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Walk down single-child chains from `el` until hitting the first element
 * with zero or more-than-one children -- i.e. the first real branching
 * point. X wraps `longformRichTextComponent`'s real sibling-block list in a
 * chain of single-purpose wrapper divs; the exact chain length isn't a
 * stable contract, so descending until branching (rather than hardcoding a
 * depth) survives X adding/removing a wrapper layer.
 * @param {Element} el
 * @returns {Element}
 */
function descendToBranchPoint(el) {
  let current = el;
  while (current.children.length === 1) {
    current = current.children[0];
  }
  return current;
}

/**
 * @param {Element} block
 * @param {string} unitId
 * @param {string} languageCode
 * @returns {import('../../../shared/types.js').ReadUnit|null}
 */
function buildImageBlockUnit(block, unitId, languageCode) {
  const img = block.querySelector('img');
  const summary = img ? summarizeImage(img) : null;
  if (!summary) return null;

  const text = normalizeForSpeech(summary);
  if (!text || isPunctuationOnly(text)) return null;

  return {
    id: unitId,
    kind: 'image-alt',
    label: null,
    sentences: [
      {
        id: `${unitId}::0`,
        unitId,
        index: -1,
        text,
        languageCode,
        anchorKind: 'element',
        locator: { kind: 'element', element: img, articleView: true },
      },
    ],
    meta: {},
  };
}

/**
 * @param {Element} block
 * @param {string} unitId
 * @param {string} languageCode
 * @returns {import('../../../shared/types.js').ReadUnit|null}
 */
function buildTextBlockUnit(block, unitId, languageCode) {
  let mapped = [];
  try {
    mapped = extractSentencesWithLocators(block);
  } catch {
    mapped = [];
  }

  const sentences = [];
  let localIndex = 0;
  for (const item of mapped) {
    if (!item?.text || isPunctuationOnly(item.text)) continue;
    sentences.push({
      id: `${unitId}::${localIndex}`,
      unitId,
      index: -1,
      text: item.text,
      languageCode,
      anchorKind: item.locator ? 'dom-range' : 'virtual',
      locator: item.locator ? { ...item.locator, articleView: true } : null,
    });
    localIndex++;
  }

  if (!sentences.length) return null;
  return { id: unitId, kind: 'paragraph', label: null, sentences, meta: {} };
}

/**
 * @param {Element} richTextEl
 * @param {string} statusId
 * @param {string} languageCode
 * @returns {import('../../../shared/types.js').ReadUnit[]}
 */
function buildBodyUnits(richTextEl, statusId, languageCode) {
  const component = querySelector(richTextEl, SELECTORS.articleRichTextComponent) || richTextEl;
  const blockContainer = descendToBranchPoint(component);
  const blocks = blockContainer.children.length ? Array.from(blockContainer.children) : [blockContainer];

  const units = [];
  let ordinal = 1;
  for (const block of blocks) {
    let visible = true;
    try {
      visible = isElementVisible(block);
    } catch {
      visible = true;
    }
    if (!visible) continue;

    const unitId = `article:${statusId}:b${ordinal}`;
    const unit = block.querySelector('img')
      ? buildImageBlockUnit(block, unitId, languageCode)
      : buildTextBlockUnit(block, unitId, languageCode);

    if (unit) {
      units.push(unit);
      ordinal++;
    }
  }
  return units;
}

/**
 * @param {Element} readView
 * @param {string} statusId
 * @param {string} languageCode
 * @returns {import('../../../shared/types.js').ReadUnit|null}
 */
function buildTitleUnit(readView, statusId, languageCode) {
  const titleEl = querySelector(readView, SELECTORS.articleTitle);
  const text = (titleEl?.textContent || '').trim();
  if (!titleEl || !text) return null;

  const unitId = `article:${statusId}:title`;
  return {
    id: unitId,
    kind: 'heading',
    label: null,
    sentences: [
      {
        id: `${unitId}::0`,
        unitId,
        index: -1,
        text,
        languageCode,
        anchorKind: 'element',
        // The title sits right at the top of the page (directly after the
        // cover image), so centering it like a body sentence would
        // actively scroll DOWN to push it to mid-viewport -- a jarring,
        // unnecessary move right as reading starts. Anchor it to the top
        // of the viewport instead.
        locator: { kind: 'element', element: titleEl, articleView: true, scrollBlock: 'start' },
      },
    ],
    meta: {},
  };
}

/**
 * @param {{ languageCode?: string }} [opts]
 * @returns {{ units: import('../../../shared/types.js').ReadUnit[], statusId: string, title: string|null }|null}
 *   null if no Article read-view is present on the page right now.
 */
export function extractArticleUnits({ languageCode = 'en-IN' } = {}) {
  const readView = querySelector(document, SELECTORS.articleReadView);
  if (!readView) return null;

  const statusId = statusIdFromLocation(location) || 'unknown';
  const richTextEl = querySelector(readView, SELECTORS.articleRichText) || readView;

  const titleUnit = buildTitleUnit(readView, statusId, languageCode);
  const bodyUnits = buildBodyUnits(richTextEl, statusId, languageCode);

  const units = [titleUnit, ...bodyUnits].filter(Boolean);
  if (!units.length) return null;

  const titleEl = querySelector(readView, SELECTORS.articleTitle);
  const title = (titleEl?.textContent || '').trim() || null;

  return { units, statusId, title };
}

/**
 * @param {object} locator - a sentence.locator with `articleView: true`
 * @param {string} [expectedText] - the sentence's own text, so a
 *   drifted index-path re-resolution can be caught (see range-mapper.js).
 * @returns {{kind:'range', range: Range}|{kind:'element', element: Element}|null}
 */
export function resolveArticleAnchor(locator, expectedText) {
  if (!locator) return null;

  if (locator.kind === 'element') {
    return locator.element && locator.element.isConnected ? { kind: 'element', element: locator.element } : null;
  }

  const range = resolveLocatorToRange(locator, expectedText);
  return range ? { kind: 'range', range } : null;
}

/**
 * @param {object} locator - a sentence.locator with `articleView: true`
 * @returns {boolean}
 */
export function ensureArticleVisible(locator) {
  if (!locator) return false;
  if (!querySelector(document, SELECTORS.articleReadView)) return false; // navigated away

  const target =
    locator.kind === 'element' ? locator.element : locator.startNode?.parentElement || locator.containerRef;
  if (!target) return false;

  // No-ops when already comfortably on screen -- an Article body reads
  // through many short sentences per paragraph block; re-centering on every
  // one would visibly race ahead of the actual reading pace. See scroll.js.
  // `scrollBlock` lets a specific locator (the title) override the default
  // centering -- see buildTitleUnit()'s comment for why.
  scrollIntoViewSmart(target, { behavior: 'smooth', block: locator.scrollBlock || 'center' });
  return true;
}
