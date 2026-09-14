#!/usr/bin/env node
/**
 * test/scroll-comfort.test.mjs
 *
 * Regression test for isComfortablyInView() (src/content/extract/lib/scroll.js).
 *
 * Before this fix, "comfortably in view" meant "fully inside the viewport
 * with a margin", which is impossible for any target taller than about 76%
 * of the viewport -- so scrollIntoViewSmart fired on every sentence inside
 * an oversized paragraph/tweet-card/whole-article fallback, and since
 * block:'center' on something taller than the screen parks its midpoint at
 * the viewport middle, the page kept jumping to a spot the reader wasn't
 * looking at. This checks that an oversized target which already spans (or
 * mostly fills) the viewport is now judged comfortable, while a small target
 * still uses the old, stricter rule.
 *
 * Run with: node test/scroll-comfort.test.mjs
 * Exits non-zero (and prints a failure list) if any assertion fails.
 */

import { isComfortablyInView } from '../src/content/extract/lib/scroll.js';

// ---------------------------------------------------------------------------
// Tiny inline test harness (no test runner dependency) -- matches
// test/harness/contract-check.mjs's style.
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;
/** @type {Array<{name:string, error:Error}>} */
const failures = [];

/**
 * @param {string} name
 * @param {() => void} fn
 */
function check(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name, error: err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

/**
 * @param {unknown} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * A fake DOMRect literal -- isComfortablyInView only reads top/bottom/height.
 * @param {number} top
 * @param {number} bottom
 * @returns {{top:number, bottom:number, height:number}}
 */
function rect(top, bottom) {
  return { top, bottom, height: bottom - top };
}

console.log('📋 scroll-comfort test cases\n');
console.log('isComfortablyInView(rect, block, viewportHeight)\n');

const VH = 800;

check('a small target fully in view -> comfortable', () => {
  // Well inside the 12%-margin band on both sides.
  const r = rect(200, 400);
  assert(isComfortablyInView(r, 'center', VH) === true, 'expected a small centered target to be comfortable');
});

check('a small target half off the bottom -> not comfortable', () => {
  const r = rect(700, 1000); // bottom (1000) is far past vh (800)
  assert(
    isComfortablyInView(r, 'center', VH) === false,
    'expected a small target hanging off the bottom edge to be uncomfortable'
  );
});

check('a target taller than the viewport that spans it -> comfortable (the regression)', () => {
  // Top above the viewport, bottom below it -- this is the 758px-tall
  // tweet-card-against-a-688px-viewport case from twitter.js's comment.
  // Under the old rule this could NEVER be comfortable at any scroll
  // position; that's the bug this whole task fixes.
  const r = rect(-100, VH + 100);
  assert(r.height > VH, 'sanity: this rect must actually be taller than the viewport');
  assert(
    isComfortablyInView(r, 'center', VH) === true,
    'expected an oversized target spanning the full viewport to be comfortable'
  );
});

check('that same oversized target scrolled fully above the viewport -> not comfortable', () => {
  const r = rect(-1200, -100); // entirely above the top edge, nothing visible
  assert(r.height > VH, 'sanity: this rect must actually be taller than the viewport');
  assert(
    isComfortablyInView(r, 'center', VH) === false,
    'expected an oversized target with nothing on screen to be uncomfortable'
  );
});

check('an oversized target with only a sliver on screen -> not comfortable', () => {
  // Height > vh, but only ~5% of the viewport shows its bottom edge -- not
  // a "useful part" of it on screen, so this must still trigger a scroll.
  const r = rect(760, 1800);
  assert(r.height > VH, 'sanity: this rect must actually be taller than the viewport');
  assert(
    isComfortablyInView(r, 'center', VH) === false,
    'expected an oversized target with only a sliver visible to be uncomfortable'
  );
});

check("block:'nearest' keeps its stricter existing semantics", () => {
  // 'nearest' only ever asks "is the whole thing within [0, vh]" -- it does
  // not get the oversized carve-out, and it ignores the center-ish margin.
  const fullyIn = rect(10, 790);
  const offBottom = rect(10, 850);
  assert(
    isComfortablyInView(fullyIn, 'nearest', VH) === true,
    "expected a target fully within [0, vh] to be comfortable under 'nearest'"
  );
  assert(
    isComfortablyInView(offBottom, 'nearest', VH) === false,
    "expected a target extending past vh to be uncomfortable under 'nearest'"
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`scroll-comfort: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);

if (failCount > 0) {
  console.log('\nFailures:');
  for (const { name, error } of failures) {
    console.log(`  - ${name}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All scroll-comfort invariants hold.');
}
