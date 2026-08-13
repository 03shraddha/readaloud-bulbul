/**
 * src/content/extract/lib/block-summarizer.js
 *
 * Instead of reading code blocks and tables literally (which is unbearable
 * as speech), this module emits short spoken summaries for them:
 *   - code block  -> "code block, 14 lines, skipped"
 *   - table       -> "table with 5 rows and 3 columns"
 *
 * Images are handled separately: they're never summarized/read at all
 * (across every extractor -- article.js, x-article-parser.js, and
 * x-thread-grouper.js all skip them outright; see article.js's
 * classifyElement doc comment for why), so there's no summarizeImage() here
 * anymore.
 *
 * Pure functions only; nothing here mutates the DOM.
 */

// Class names that mean "this is a code block" ONLY as an exact, standalone
// class token -- Jekyll/Rouge (`highlight`), Python-Markdown (`codehilite`),
// highlight.js (`hljs`), and Google Code Prettify (`prettyprint`) all apply
// these bare, with no suffix. A previous version of this matched `highlight`
// as a substring anywhere in the class attribute, which also matched CSS-
// module-hashed classes unrelated apps generate for entirely different UI
// (e.g. Substack's own like-button chrome ships a class like
// `highlight-U002IP` for a hover effect, nothing to do with code) -- that
// false-positive made the whole page's real content get replaced with a
// single "code block, 1 line, skipped" summary, i.e. reading Substack posts
// didn't work at all.
const EXACT_CODE_CLASSES = new Set(['highlight', 'codehilite', 'hljs', 'prettyprint']);
// Conventions that ARE legitimately prefix-based: Jekyll's newer output pairs
// `highlighter-rouge` with a `language-xxx` class; Prism.js/highlight.js use
// `language-xxx` on the code element itself; some themes use
// `syntax-highlight(er)` as a compound prefix. Anchored at the start of the
// token (not `\b` mid-string) so an unrelated hash suffix can't satisfy it.
const CODE_CLASS_PREFIX_RE = /^(highlighter-|language-\w|syntax-highlight)/i;

/**
 * @param {Element} el
 * @returns {boolean} true if `el` is a block-level code container (a <pre>,
 *   or something wearing one of the common syntax-highlighter classes).
 */
export function isCodeBlock(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (el.tagName === 'PRE') return true;

  const className = typeof el.className === 'string' ? el.className : '';
  if (!className) return false;

  return className
    .trim()
    .split(/\s+/)
    .some((token) => {
      const t = token.toLowerCase();
      return EXACT_CODE_CLASSES.has(t) || CODE_CLASS_PREFIX_RE.test(t);
    });
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

export default { isCodeBlock, isTable, summarizeCodeBlock, summarizeTable };
