/**
 * src/content/extract/lib/block-summarizer.js
 *
 * Instead of reading code blocks and tables literally (which is unbearable
 * as speech), this module emits short spoken summaries for them, plus a
 * single spoken description for meaningfully-alt-texted images:
 *   - code block  -> "code block, 14 lines, skipped"
 *   - table       -> "table with 5 rows and 3 columns"
 *   - image       -> "image described as: <alt/aria-label text>"
 *     (suppressed entirely — returns null — when an adjacent visible
 *     <figcaption> already carries the same text, to avoid saying it twice)
 *
 * Pure functions only; nothing here mutates the DOM.
 */

import { isElementVisible } from './visibility.js';

const CODE_CLASS_RE = /\b(highlight|codehilite|hljs|prettyprint|language-\w+|syntax(?:-highlight(?:er)?)?)\b/i;

/**
 * @param {Element} el
 * @returns {boolean} true if `el` is a block-level code container (a <pre>,
 *   or something wearing one of the common syntax-highlighter classes).
 */
export function isCodeBlock(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.tagName === 'PRE') return true;

  const className = typeof el.className === 'string' ? el.className : '';
  if (className && CODE_CLASS_RE.test(className)) return true;

  return false;
}

/**
 * @param {Element} el
 * @returns {boolean}
 */
export function isTable(el) {
  return !!el && el.nodeType === Node.ELEMENT_NODE && el.tagName === 'TABLE';
}

/**
 * @param {Element} el - a code block (see `isCodeBlock`)
 * @returns {string}
 */
export function summarizeCodeBlock(el) {
  const raw = (el && el.textContent) || '';
  const withoutTrailingBlankLines = raw.replace(/\n+$/, '');
  const lineCount = withoutTrailingBlankLines.length ? withoutTrailingBlankLines.split('\n').length : 1;
  return `code block, ${lineCount} line${lineCount === 1 ? '' : 's'}, skipped`;
}

/**
 * @param {Element} tableEl
 * @returns {string}
 */
export function summarizeTable(tableEl) {
  let rows = [];
  try {
    rows = Array.from(tableEl.querySelectorAll('tr'));
  } catch {
    rows = [];
  }

  const rowCount = rows.length;
  let colCount = 0;
  for (const row of rows) {
    let cellCount = 0;
    try {
      cellCount = row.querySelectorAll('th, td').length;
    } catch {
      cellCount = 0;
    }
    if (cellCount > colCount) colCount = cellCount;
  }

  return `table with ${rowCount} row${rowCount === 1 ? '' : 's'} and ${colCount} column${colCount === 1 ? '' : 's'}`;
}

/**
 * @param {Element} el - typically the <img> itself
 * @returns {string|null} visible text of a sibling <figcaption> inside an
 *   enclosing <figure>, or null if there isn't one / it isn't visible.
 */
function findAdjacentFigcaptionText(el) {
  const figure = typeof el.closest === 'function' ? el.closest('figure') : null;
  if (!figure) return null;

  let figcaption = null;
  try {
    figcaption = figure.querySelector('figcaption');
  } catch {
    figcaption = null;
  }
  if (!figcaption || !isElementVisible(figcaption)) return null;

  const text = (figcaption.textContent || '').trim();
  return text || null;
}

/**
 * @param {Element} imgEl
 * @returns {string|null} the spoken "image described as: ..." unit text, or
 *   null when the image has no usable description, or when an adjacent
 *   visible <figcaption> already carries the same text (so a separate
 *   caption ReadUnit will speak it instead — no need to say it twice).
 */
export function summarizeImage(imgEl) {
  if (!imgEl) return null;

  const alt = (imgEl.getAttribute && imgEl.getAttribute('alt')) || '';
  const ariaLabel = (imgEl.getAttribute && imgEl.getAttribute('aria-label')) || '';
  const description = alt.trim() || ariaLabel.trim();
  if (!description) return null;

  const captionText = findAdjacentFigcaptionText(imgEl);
  if (captionText && captionText.toLowerCase() === description.toLowerCase()) {
    return null;
  }

  return `image described as: ${description}`;
}

export default { isCodeBlock, isTable, summarizeCodeBlock, summarizeTable, summarizeImage };
