/**
 * src/content/ui/highlighter.js
 *
 * {apply(anchor, {style, sentenceId}), clear(sentenceId), clearAll()}
 *
 * Per shared_contracts §10: prefers the CSS Custom Highlight API
 * (`CSS.highlights` + `new Highlight(range)`) so the host page's DOM is
 * never mutated for Range anchors. Falls back to wrapping the Range in
 * `<span class="cadence-hl ...">` elements (recorded so clear() can
 * unwrap/normalize them away) when the API is unavailable, and to a plain
 * class toggle for Element anchors.
 *
 * The one unavoidable page-level side effect is a single `<style>` tag
 * (id="cadence-hl-style") appended to <head> once, lazily, the first time a
 * highlight is applied — it defines the `::highlight(...)` rules and the
 * fallback `.cadence-hl*` classes. It is never removed (kept idempotent /
 * cheap to leave behind) but has zero effect unless one of our classes or
 * highlight ranges is active.
 */

import { GRADIENT_FROM, GRADIENT_TO } from '../../shared/constants.js';

const STYLE_TAG_ID = 'cadence-hl-style';
const VALID_STYLES = new Set(['gradient', 'solid', 'underline']);
const HIGHLIGHT_NAMES = {
  gradient: 'cadence-gradient',
  solid: 'cadence-solid',
  underline: 'cadence-underline',
};

/** sentenceId -> internal record describing how to undo the highlight. */
const records = new Map();

/** Lazily-created { gradient, solid, underline } Highlight instances. */
let highlightRegistry = null;

function normalizeStyle(style) {
  return VALID_STYLES.has(style) ? style : 'gradient';
}

function supportsHighlightApi() {
  return (
    typeof window !== 'undefined' &&
    typeof window.Highlight === 'function' &&
    typeof CSS !== 'undefined' &&
    !!CSS.highlights
  );
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function mixRgba(hexA, hexB, t, alpha) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}

/**
 * Ensure the single page-level <style> tag with our `::highlight()` rules
 * and fallback classes exists. Idempotent.
 */
function ensureGlobalStyleInjected() {
  if (document.getElementById(STYLE_TAG_ID)) return;

  // ::highlight() only supports a small property set (color, background-
  // color, text-decoration-*) — no background-image/gradients — so the
  // "gradient" style is approximated there as a blended solid tint. The
  // span/element fallback path below CAN use a real linear-gradient.
  const gradientTint = mixRgba(GRADIENT_FROM, GRADIENT_TO, 0.5, 0.35);
  const solidTint = mixRgba(GRADIENT_FROM, GRADIENT_FROM, 0, 0.32);
  const underlineColor = GRADIENT_TO;

  const style = document.createElement('style');
  style.id = STYLE_TAG_ID;
  style.textContent = `
::highlight(${HIGHLIGHT_NAMES.gradient}) {
  background-color: ${gradientTint};
}
::highlight(${HIGHLIGHT_NAMES.solid}) {
  background-color: ${solidTint};
}
::highlight(${HIGHLIGHT_NAMES.underline}) {
  text-decoration-line: underline;
  text-decoration-color: ${underlineColor};
  text-decoration-thickness: 2px;
}
.cadence-hl--gradient, .cadence-hl-el--gradient {
  background-image: linear-gradient(90deg, ${GRADIENT_FROM}59, ${GRADIENT_TO}59);
  background-repeat: no-repeat;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  border-radius: 2px;
}
.cadence-hl--solid, .cadence-hl-el--solid {
  background-color: ${GRADIENT_FROM}52;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  border-radius: 2px;
}
.cadence-hl--underline, .cadence-hl-el--underline {
  background: none;
  text-decoration-line: underline;
  text-decoration-color: ${GRADIENT_TO};
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
}
`.trim();

  (document.head || document.documentElement).appendChild(style);
}

function ensureHighlightRegistry() {
  if (highlightRegistry) return highlightRegistry;
  highlightRegistry = {
    gradient: new window.Highlight(),
    solid: new window.Highlight(),
    underline: new window.Highlight(),
  };
  CSS.highlights.set(HIGHLIGHT_NAMES.gradient, highlightRegistry.gradient);
  CSS.highlights.set(HIGHLIGHT_NAMES.solid, highlightRegistry.solid);
  CSS.highlights.set(HIGHLIGHT_NAMES.underline, highlightRegistry.underline);
  return highlightRegistry;
}

/**
 * Wrap the portion(s) of `range` in `<span class="${className}">` elements.
 * Handles the common single-text-node case directly, and falls back to a
 * per-text-node walk for ranges spanning multiple elements (surroundContents
 * throws if the range boundaries aren't cleanly nested).
 * @param {Range} range
 * @param {string} className
 * @returns {HTMLSpanElement[]}
 */
function wrapRangeFallback(range, className) {
  const spans = [];

  if (range.collapsed) return spans;

  if (range.startContainer === range.endContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
    const span = document.createElement('span');
    span.className = className;
    try {
      range.surroundContents(span);
      spans.push(span);
      return spans;
    } catch {
      // fall through to the multi-node walk below
    }
  }

  const root = range.commonAncestorContainer;
  const walkerRoot = root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
  if (!walkerRoot) return spans;

  const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node)) textNodes.push(node);
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const startOffset = textNode === range.startContainer ? range.startOffset : 0;
    const endOffset = textNode === range.endContainer ? range.endOffset : textNode.length;
    if (startOffset >= endOffset) continue;

    const subRange = document.createRange();
    try {
      subRange.setStart(textNode, startOffset);
      subRange.setEnd(textNode, endOffset);
      const span = document.createElement('span');
      span.className = className;
      subRange.surroundContents(span);
      spans.push(span);
    } catch {
      // Skip fragments we can't safely wrap rather than corrupting the DOM.
    }
  }

  return spans;
}

function unwrapSpan(span) {
  const parent = span.parentNode;
  if (!parent) return;
  try {
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  } catch {
    // Page may have already removed/replaced this node (SPA re-render) —
    // nothing left to undo.
  }
}

function clearRecord(record) {
  if (!record) return;
  switch (record.kind) {
    case 'highlight': {
      const reg = highlightRegistry?.[record.styleKey];
      try {
        reg?.delete(record.range);
      } catch {
        /* range may already be detached; ignore */
      }
      break;
    }
    case 'span': {
      for (const span of record.spans) unwrapSpan(span);
      break;
    }
    case 'element': {
      try {
        record.element.classList.remove(...record.classNames);
      } catch {
        /* element may be gone */
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Apply a highlight for `sentenceId` at `anchor`.
 * @param {{kind:'range', range:Range}|{kind:'element', element:Element}} anchor
 * @param {{style?: 'gradient'|'solid'|'underline', sentenceId: string}} options
 */
export function apply(anchor, { style, sentenceId } = {}) {
  if (!anchor || !sentenceId) return;

  // Re-applying to the same sentenceId (e.g. a duplicate HIGHLIGHT_SENTENCE)
  // clears the previous instance first so we never leak wrapper spans.
  clear(sentenceId);

  ensureGlobalStyleInjected();
  const styleKey = normalizeStyle(style);

  if (anchor.kind === 'range' && anchor.range) {
    if (supportsHighlightApi()) {
      try {
        const registry = ensureHighlightRegistry();
        registry[styleKey].add(anchor.range);
        records.set(sentenceId, { kind: 'highlight', styleKey, range: anchor.range });
        return;
      } catch {
        // Fall through to the span-wrap fallback if the Highlight API
        // rejects this particular range for some reason.
      }
    }

    const spans = wrapRangeFallback(anchor.range, `cadence-hl cadence-hl--${styleKey}`);
    if (spans.length) {
      records.set(sentenceId, { kind: 'span', spans });
    }
    return;
  }

  if (anchor.kind === 'element' && anchor.element) {
    const classNames = ['cadence-hl-el', `cadence-hl-el--${styleKey}`];
    anchor.element.classList.add(...classNames);
    records.set(sentenceId, { kind: 'element', element: anchor.element, classNames });
  }
}

/**
 * Undo the highlight for one sentence (no-op if unknown/already cleared).
 * @param {string} [sentenceId]
 */
export function clear(sentenceId) {
  if (sentenceId == null) {
    clearAll();
    return;
  }
  const record = records.get(sentenceId);
  if (!record) return;
  clearRecord(record);
  records.delete(sentenceId);
}

/** Undo every active highlight. */
export function clearAll() {
  for (const record of records.values()) clearRecord(record);
  records.clear();
}

export default { apply, clear, clearAll };
