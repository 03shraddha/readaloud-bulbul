#!/usr/bin/env node
/**
 * test/x-permalink-detection.test.mjs
 *
 * Regression test for isStatusPermalinkPathname() (src/content/extract/twitter.js).
 *
 * A status permalink (`/<user>/status/<id>`) is finite content -- the focal
 * tweet plus whatever replies are already mounted -- unlike an ordinary
 * timeline, where there's always more to scroll to. Before this fix,
 * extract() never detected a permalink, so the buffer running low there
 * made prefetch-queue.js ask for "more units", which x-timeline-feeder.js
 * answered by scrolling the page down hunting for tweets that were never
 * going to appear: the page walking downward on its own while a single
 * tweet is being read (R3). This checks the predicate that now stops that
 * hunt from ever starting on a permalink, against both permalink and
 * non-permalink pathnames.
 *
 * Dependency-free (this repo has no devDependencies, no test runner): plain
 * assertions, matches test/scroll-comfort.test.mjs's house style.
 *
 * Run with: node test/x-permalink-detection.test.mjs
 * Exits non-zero (and prints a failure list) if any assertion fails.
 */

import twitterExtractor, { isStatusPermalinkPathname } from '../src/content/extract/twitter.js';

// ---------------------------------------------------------------------------
// Tiny inline test harness -- matches test/harness/contract-check.mjs's style.
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

console.log('📋 x-permalink-detection test cases\n');
console.log('isStatusPermalinkPathname(pathname)\n');

check('the default export is still the twitter extractor (sanity)', () => {
  assert(twitterExtractor?.id === 'twitter', 'expected twitter.js default export to be unchanged');
});

const permalinkPathnames = [
  '/DavidSacks/status/123',
  '/i/status/123',
  '/DavidSacks/status/123/photo/1',
];

const nonPermalinkPathnames = [
  '/home',
  '/search',
  '/DavidSacks',
  '/i/lists/456',
];

for (const pathname of permalinkPathnames) {
  check(`${pathname} -> permalink (true)`, () => {
    assert(
      isStatusPermalinkPathname(pathname) === true,
      `expected "${pathname}" to be treated as a status permalink`
    );
  });
}

for (const pathname of nonPermalinkPathnames) {
  check(`${pathname} -> not a permalink (false)`, () => {
    assert(
      isStatusPermalinkPathname(pathname) === false,
      `expected "${pathname}" NOT to be treated as a status permalink`
    );
  });
}

check('"/search?q=x" -- only location.pathname is checked, query string is irrelevant', () => {
  // location.pathname never includes the query string, but a caller passing
  // the full "pathname?query" by mistake should still resolve the same way
  // the pathname-only value would: no /status/ segment, not a permalink.
  assert(
    isStatusPermalinkPathname('/search?q=x') === false,
    'expected a search URL (with or without a query string) to never be a permalink'
  );
});

check('missing/empty pathname -> false, not a thrown error', () => {
  assert(isStatusPermalinkPathname('') === false, 'expected an empty string to be treated as not a permalink');
  assert(isStatusPermalinkPathname(undefined) === false, 'expected undefined to be treated as not a permalink');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`x-permalink-detection: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);

if (failCount > 0) {
  console.log('\nFailures:');
  for (const { name, error } of failures) {
    console.log(`  - ${name}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All x-permalink-detection invariants hold.');
}
