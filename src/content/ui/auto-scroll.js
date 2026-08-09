/**
 * src/content/ui/auto-scroll.js
 *
 * scrollIntoViewSmart(target, opts) centers a Range or Element in the
 * viewport, no-ops when it is already comfortably visible, and suspends
 * itself for a few seconds after it detects a manual user scroll/wheel/touch
 * gesture so it never fights the user for control of the page.
 */

// How long auto-scroll stays suspended after a detected manual gesture.
const MANUAL_SUSPEND_MS = 4000;

// Fraction of the viewport height that must be clear above/below a target
// for it to be considered "comfortably" in view (used for block:'center'-ish
// checks). Smaller values are stricter about centering.
const COMFORT_MARGIN_RATIO = 0.12;

let lastManualGestureAt = 0;
let listenersAttached = false;

function markManualGesture() {
  lastManualGestureAt = Date.now();
}

const MANUAL_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

function onKeyDown(e) {
  if (MANUAL_SCROLL_KEYS.has(e.key)) markManualGesture();
}

/**
 * Attach the (idempotent, page-global) listeners that detect a manual
 * scroll/wheel/touch gesture. Safe to call multiple times.
 */
function ensureListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  const opts = { capture: true, passive: true };
  window.addEventListener('wheel', markManualGesture, opts);
  window.addEventListener('touchstart', markManualGesture, opts);
  window.addEventListener('touchmove', markManualGesture, opts);
  window.addEventListener('keydown', onKeyDown, opts);
}

/**
 * @returns {boolean} true while auto-scroll should stay quiet because of a
 *   recent manual gesture.
 */
function isSuspendedByUser() {
  return Date.now() - lastManualGestureAt < MANUAL_SUSPEND_MS;
}

/**
 * @param {Element|Range} target
 * @returns {DOMRect|null}
 */
function getTargetRect(target) {
  if (!target) return null;
  try {
    if (typeof target.getBoundingClientRect === 'function') {
      const rect = target.getBoundingClientRect();
      // Range.getBoundingClientRect() can return an all-zero rect for a
      // collapsed/empty range; fall through to getClientRects in that case.
      if (rect && (rect.width || rect.height || rect.top || rect.left)) return rect;
    }
    if (typeof target.getClientRects === 'function') {
      const rects = target.getClientRects();
      if (rects && rects.length) return rects[0];
    }
    return target.getBoundingClientRect ? target.getBoundingClientRect() : null;
  } catch {
    return null;
  }
}

/**
 * @param {DOMRect} rect
 * @param {'start'|'center'|'end'|'nearest'} block
 * @returns {boolean}
 */
function isComfortablyInView(rect, block) {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (!vh || !rect) return true;
  const margin = vh * COMFORT_MARGIN_RATIO;

  if (block === 'nearest') {
    return rect.top >= 0 && rect.bottom <= vh;
  }

  // Default / 'center' / 'start' / 'end' all use the same comfortable band:
  // fully visible with a little breathing room, which is the common case
  // that matters for "don't scroll if it's already fine".
  return rect.top >= margin && rect.bottom <= vh - margin && rect.top >= 0 && rect.bottom <= vh;
}

/**
 * Center (or otherwise position) `target` in the viewport, smartly.
 * @param {Element|Range} target
 * @param {{behavior?: 'smooth'|'auto', block?: 'start'|'center'|'end'|'nearest', respectUserScroll?: boolean}} [opts]
 * @returns {boolean} true if a scroll was actually performed
 */
export function scrollIntoViewSmart(target, opts = {}) {
  const { behavior = 'smooth', block = 'center', respectUserScroll = true } = opts;

  ensureListeners();

  if (!target) return false;

  if (respectUserScroll && isSuspendedByUser()) {
    return false;
  }

  const rect = getTargetRect(target);
  if (!rect) return false;

  if (isComfortablyInView(rect, block)) {
    return false;
  }

  try {
    if (typeof target.scrollIntoView === 'function') {
      // Element (and, in supporting browsers, Range) both implement this.
      target.scrollIntoView({ behavior, block, inline: 'nearest' });
      return true;
    }
  } catch {
    // fall through to manual scroll-by below
  }

  // Manual fallback: compute a scroll delta that centers the rect and use
  // window.scrollBy, which works for both Element and Range targets when
  // scrollIntoView isn't available/throws (older engines, some Range cases).
  try {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let targetTop;
    if (block === 'start') targetTop = 0;
    else if (block === 'end') targetTop = vh - rect.height;
    else targetTop = vh / 2 - rect.height / 2; // center / nearest fallback

    const delta = rect.top - targetTop;
    if (Math.abs(delta) < 2) return false;
    window.scrollBy({ top: delta, left: 0, behavior });
    return true;
  } catch {
    return false;
  }
}

/**
 * Exposed for tests / debugging only — not part of the public contract.
 * @returns {boolean}
 */
export function isAutoScrollSuspended() {
  return isSuspendedByUser();
}

export default scrollIntoViewSmart;
