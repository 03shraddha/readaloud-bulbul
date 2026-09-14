/**
 * src/content/extract/lib/scroll.js
 *
 * scrollIntoViewSmart(target, opts) centers a Range or Element in the
 * viewport, no-ops when it is already comfortably visible, and suspends
 * itself for a few seconds after it detects a manual user scroll/wheel/touch
 * gesture so it never fights the user for control of the page.
 *
 * Lives under extract/lib/ (moved from content/ui/) because its callers are
 * the extractors' ensureVisible() implementations, not any widget UI code --
 * twitter.js's own doc comment says extractors don't import from content/ui/,
 * and this is plain DOM-scroll logic, not a rendered UI component.
 *
 * The "no-op when already comfortably visible" behavior is the fix for a
 * real bug: calling `target.scrollIntoView({block:'center', behavior:
 * 'smooth'})` unconditionally on EVERY sentence re-centers the viewport
 * every single time, even when several short sentences in a row are all
 * already on-screen. Each call restarts/retargets the smooth-scroll
 * animation, which visibly races ahead of the actual reading pace. Skipping
 * the call entirely when nothing needs to move is what keeps the page
 * settled in place until it genuinely needs to catch up.
 *
 * A second, related bug: "comfortably visible" used to mean "fully inside
 * the viewport", which is impossible for any target taller than about 76%
 * of the viewport (a long paragraph, an oversized tweet-card fallback, a
 * whole-article fallback unit). Those targets could never be judged
 * comfortable no matter where the page sat, so scrollIntoViewSmart fired on
 * every sentence inside them -- and since `block:'center'` on something
 * taller than the screen parks its midpoint at the viewport middle, the
 * page kept jumping to a position that had nothing to do with where the
 * reader was actually looking. isComfortablyInView() below has a dedicated
 * branch for oversized targets: instead of asking "is all of it visible"
 * (never true), it asks "is a useful part of it on screen" (often already
 * true). And when an oversized target genuinely does need a scroll,
 * centering it is meaningless -- its top edge is used instead so the reader
 * lands where the new content actually starts.
 */

// How long auto-scroll stays suspended after a detected manual gesture.
const MANUAL_SUSPEND_MS = 4000;

// Fraction of the viewport height that must be clear above/below a target
// for it to be considered "comfortably" in view (used for block:'center'-ish
// checks). Smaller values are stricter about centering.
const COMFORT_MARGIN_RATIO = 0.12;

// A target taller than this fraction of the viewport (i.e. taller than the
// comfortable band `vh * (1 - 2 * COMFORT_MARGIN_RATIO)` leaves room for)
// can never be fully contained no matter where the page scrolls -- so full
// containment is the wrong test for it. See isOversizedRect().
const OVERSIZED_HEIGHT_RATIO = 1 - 2 * COMFORT_MARGIN_RATIO;

// Once a target is oversized, treat it as comfortable once this fraction of
// the viewport is covered by its visible portion. Conservative on purpose:
// the goal is only to stop re-scrolling while the thing being read is
// plainly on screen, not to allow a target that's mostly scrolled past.
const OVERSIZED_VISIBLE_RATIO = 0.7;

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
 * @param {number} vh
 * @returns {boolean} true when `rect` is taller than the comfortable band,
 *   meaning it can never be fully contained in the viewport no matter where
 *   the page scrolls.
 */
function isOversizedRect(rect, vh) {
  return rect.height > vh * OVERSIZED_HEIGHT_RATIO;
}

/**
 * @param {DOMRect} rect
 * @param {'start'|'center'|'end'|'nearest'} block
 * @param {number} [viewportHeight] - injectable viewport height, for pure
 *   unit testing; defaults to the real window when omitted.
 * @returns {boolean}
 */
export function isComfortablyInView(rect, block, viewportHeight) {
  const vh = viewportHeight || window.innerHeight || document.documentElement.clientHeight;
  if (!vh || !rect) return true;
  const margin = vh * COMFORT_MARGIN_RATIO;

  if (block === 'nearest') {
    return rect.top >= 0 && rect.bottom <= vh;
  }

  if (isOversizedRect(rect, vh)) {
    // Full containment is structurally impossible here, so demanding it
    // (the old behavior) meant this target could NEVER be judged
    // comfortable, at any scroll position -- see the file header. Ask
    // instead whether a useful part of it is already on screen: either it
    // spans the whole viewport (top above, bottom below), or its visible
    // slice covers a healthy fraction of the screen.
    if (rect.top <= 0 && rect.bottom >= vh) return true;
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, vh);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    return visibleHeight >= vh * OVERSIZED_VISIBLE_RATIO;
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

  // `block:'center'` on a target taller than the viewport is meaningless --
  // it parks the target's midpoint at the viewport middle, which for an
  // oversized element puts its top edge off-screen above the fold no matter
  // how the scroll lands. Land on its top edge instead, so a scroll that IS
  // needed moves to where the new content actually starts. Doesn't touch an
  // explicit 'start'/'end'/'nearest' request.
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const effectiveBlock = block !== 'nearest' && vh && isOversizedRect(rect, vh) ? 'start' : block;

  try {
    if (typeof target.scrollIntoView === 'function') {
      // Element (and, in supporting browsers, Range) both implement this.
      target.scrollIntoView({ behavior, block: effectiveBlock, inline: 'nearest' });
      return true;
    }
  } catch {
    // fall through to manual scroll-by below
  }

  // Manual fallback: compute a scroll delta that centers the rect and use
  // window.scrollBy, which works for both Element and Range targets when
  // scrollIntoView isn't available/throws (older engines, some Range cases).
  try {
    let targetTop;
    if (effectiveBlock === 'start') targetTop = 0;
    else if (effectiveBlock === 'end') targetTop = vh - rect.height;
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
