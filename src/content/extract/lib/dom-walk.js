/**
 * src/content/extract/lib/dom-walk.js
 *
 * DOM-order traversal helper shared by the article extractor's lib modules.
 *
 * Deliberately NOT `document.createTreeWalker` used verbatim, because the
 * native TreeWalker cannot cross shadow-root or same-origin-iframe document
 * boundaries. Instead this implements an equivalent manual, depth-first,
 * DOM-order walk (never CSS visual/`order` order — flex/grid `order` is a
 * paint-time concept and is ignored here, matching accessibility-tree best
 * practice) that:
 *   - descends into OPEN shadow roots (`element.shadowRoot`, which the
 *     platform only ever populates for open-mode roots) instead of the
 *     host's light-DOM children,
 *   - descends into same-origin iframes via `iframe.contentDocument.body`,
 *   - skips cross-origin iframes entirely (accessing contentDocument either
 *     throws or yields null for those; both are treated the same way).
 *
 * Every export is a pure function/generator with no page-global side
 * effects, so it is safe to call repeatedly and cheaply from a hot path.
 */

/**
 * @param {Element} iframe
 * @returns {Document|null} the same-origin content document, or null if the
 *   iframe is cross-origin, not yet loaded, or otherwise inaccessible.
 */
export function getSameOriginIframeDocument(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return null;
    // Touching a property on `defaultView` is a second belt-and-braces check:
    // some engines allow `contentDocument` to resolve to an (empty) document
    // for a still-loading cross-origin frame before locking it down.
    void doc.location;
    return doc;
  } catch {
    return null;
  }
}

/**
 * @param {Node} node
 * @param {((el: Element) => boolean)|undefined} shouldDescend
 * @returns {Generator<Node>}
 */
function* walkNode(node, shouldDescend) {
  if (!node) return;
  yield node;

  if (node.nodeType !== Node.ELEMENT_NODE) {
    // Text/comment/etc nodes never have meaningful children to recurse into.
    return;
  }

  const el = /** @type {Element} */ (node);

  if (typeof shouldDescend === 'function' && !shouldDescend(el)) {
    return; // caller opted to prune this subtree, but the node itself was yielded above
  }

  const tag = el.tagName;

  if (tag === 'IFRAME') {
    const doc = getSameOriginIframeDocument(/** @type {HTMLIFrameElement} */ (el));
    if (doc && doc.body) {
      yield* walkNode(doc.body, shouldDescend);
    }
    // Cross-origin (or inaccessible) iframes: nothing further to walk.
    return;
  }

  const shadowRoot = el.shadowRoot;
  if (shadowRoot) {
    // The shadow tree is what's actually rendered/exposed to accessibility
    // for this host; walk it instead of (not in addition to) the light DOM
    // children. This is a simplification that does not follow <slot>
    // projection — acceptable for read-aloud purposes at this scope.
    for (const child of Array.from(shadowRoot.childNodes)) {
      yield* walkNode(child, shouldDescend);
    }
    return;
  }

  for (const child of Array.from(el.childNodes)) {
    yield* walkNode(child, shouldDescend);
  }
}

/**
 * Walk `root` and all its descendants in DOM order, descending into open
 * shadow roots and same-origin iframes, never into cross-origin iframes.
 *
 * @param {Node} root
 * @param {{ shouldDescend?: (el: Element) => boolean }} [options]
 *   `shouldDescend(el)` — when it returns false for an element, that element
 *   is still yielded but its children (light DOM, shadow DOM, or iframe
 *   document) are pruned. Useful for skipping stripped/ad/nav subtrees or
 *   subtrees already claimed by a higher-level unit classifier.
 * @returns {Generator<Node>}
 */
export function* walkDOM(root, options = {}) {
  if (!root) return;
  yield* walkNode(root, options.shouldDescend);
}

export default { walkDOM, getSameOriginIframeDocument };
