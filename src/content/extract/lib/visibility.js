/**
 * src/content/extract/lib/visibility.js
 *
 * Visibility heuristics used to keep the article extractor from reading
 * (or highlighting) content a sighted user would never see: `display:none`,
 * `visibility:hidden`, `aria-hidden="true"`, zero-size boxes, `opacity:0`,
 * and the classic "SEO-hidden" off-screen-positioning / clip-rect tricks.
 *
 * Every function here is read-only and defensive: a thrown exception from
 * `getComputedStyle`/`getBoundingClientRect` (e.g. on a node that has been
 * detached mid-check) is swallowed and treated as "assume visible" so a
 * single flaky node never aborts a whole extraction pass.
 */

const OFFSCREEN_THRESHOLD_PX = 9000;

const VISUALLY_HIDDEN_CLASS_RE = /\b(sr-only|screen-reader-text|visually-?hidden|a11y-hidden|assistive-text)\b/i;

/**
 * @param {Element} el
 * @returns {CSSStyleDeclaration|null}
 */
function safeComputedStyle(el) {
  try {
    return getComputedStyle(el);
  } catch {
    return null;
  }
}

/**
 * @param {Element} el
 * @returns {DOMRect|null}
 */
function safeBoundingRect(el) {
  try {
    return el.getBoundingClientRect();
  } catch {
    return null;
  }
}

/**
 * Checks a single element (not its ancestors) for the disqualifying
 * conditions. Callers that need the effective visibility of a node should
 * use `isVisible`, which also walks ancestors.
 * @param {Element} el
 * @returns {boolean}
 */
export function isElementVisible(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;

  if (el.hidden) return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;

  const style = safeComputedStyle(el);
  if (style) {
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;

    const opacity = parseFloat(style.opacity);
    if (!Number.isNaN(opacity) && opacity === 0) return false;

    // Classic off-screen SEO-hidden-text techniques.
    if (style.position === 'absolute' || style.position === 'fixed') {
      const left = parseFloat(style.left);
      const top = parseFloat(style.top);
      if (
        (!Number.isNaN(left) && Math.abs(left) >= OFFSCREEN_THRESHOLD_PX && left < 0) ||
        (!Number.isNaN(top) && Math.abs(top) >= OFFSCREEN_THRESHOLD_PX && top < 0)
      ) {
        return false;
      }
    }

    if (style.clip && style.clip !== 'auto' && /rect\(/i.test(style.clip)) {
      // `clip: rect(...)` (the pre-clip-path visually-hidden idiom) — any
      // explicit clip rect on a non-positioned-for-display element is
      // treated as an intentional visual hide.
      return false;
    }

    if (style.clipPath && /inset\(\s*100%|circle\(\s*0/i.test(style.clipPath)) {
      return false;
    }
  }

  const rect = safeBoundingRect(el);
  if (rect && rect.width === 0 && rect.height === 0) return false;

  const classAndId = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`.trim();
  if (classAndId && VISUALLY_HIDDEN_CLASS_RE.test(classAndId)) return false;

  return true;
}

/**
 * Climb from `node` (or its parent element, if `node` is a text/comment
 * node) up through the ancestor chain — including out through shadow-root
 * boundaries via `.host` — checking `isElementVisible` at every step.
 * @param {Node} node
 * @returns {boolean}
 */
export function isVisible(node) {
  if (!node) return false;

  let current = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;

  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE && !isElementVisible(current)) {
      return false;
    }

    const parentElement = current.parentElement;
    if (parentElement) {
      current = parentElement;
      continue;
    }

    // No parentElement: either we've reached the top of a document/shadow
    // tree, or we're the shadow root's direct child (parentNode is the
    // ShadowRoot itself, not an Element). Climb out via `.host` in the
    // latter case so hidden custom-element hosts are still honored.
    const parentNode = current.parentNode;
    if (parentNode && /** @type {ShadowRoot} */ (parentNode).host) {
      current = /** @type {ShadowRoot} */ (parentNode).host;
    } else {
      current = null;
    }
  }

  return true;
}

/**
 * @param {Text} textNode
 * @returns {boolean} true if the node has non-whitespace content AND is
 *   visible per `isVisible`.
 */
export function isVisibleTextNode(textNode) {
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return false;
  if (!textNode.nodeValue || !textNode.nodeValue.trim()) return false;
  return isVisible(textNode);
}

export default { isElementVisible, isVisible, isVisibleTextNode };
