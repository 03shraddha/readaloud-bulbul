#!/usr/bin/env node
/**
 * test/harness/contract-check.mjs
 *
 * Dependency-free Node script (only Node built-ins + the shared modules it
 * is verifying) that asserts the shared_contracts invariants hold for:
 *
 *   - src/shared/messages.js   (MSG catalog: key===value, no duplicates)
 *   - src/shared/constants.js  (MAX_SENTENCE_CHARS wiring)
 *   - src/shared/text/sentence-splitter.js
 *       (never exceeds MAX_SENTENCE_CHARS; abbreviations don't split)
 *   - src/shared/hash.js + src/shared/keys.js
 *       (contentKey / contextId derivation per shared_contracts §6, for a
 *       dozen sample URLs)
 *
 * Run with: node test/harness/contract-check.mjs
 * Exits non-zero (and prints a failure list) if any assertion fails.
 */

import { MSG } from '../../src/shared/messages.js';
import { MAX_SENTENCE_CHARS } from '../../src/shared/constants.js';
import { splitSentences } from '../../src/shared/text/sentence-splitter.js';
import { fnv1a32, normalizeUrl, contentHashFromSentences } from '../../src/shared/hash.js';
import { articleContentKey, twitterContentKey, twitterContextId } from '../../src/shared/keys.js';

// ---------------------------------------------------------------------------
// Tiny inline test harness (no test runner dependency)
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;
/** @type {Array<{name:string, error:Error}>} */
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
}

/**
 * @param {string} name
 * @param {() => void} fn
 */
function check(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name: `${currentGroup} > ${name}`, error: err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
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
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} message
 */
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Message catalog invariants (shared_contracts §3)
// ---------------------------------------------------------------------------

group('1. Message catalog (src/shared/messages.js)');

check('MSG is a non-empty object', () => {
  assert(MSG && typeof MSG === 'object', 'MSG must be an object');
  assert(Object.keys(MSG).length > 0, 'MSG must not be empty');
});

check('every MSG value equals its own key', () => {
  const mismatches = Object.entries(MSG).filter(([key, value]) => key !== value);
  assert(
    mismatches.length === 0,
    `key !== value for: ${mismatches.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`
  );
});

check('no duplicate message values', () => {
  const values = Object.values(MSG);
  const unique = new Set(values);
  assert(unique.size === values.length, `found ${values.length - unique.size} duplicate value(s) among ${values.length} entries`);
});

check('MSG object is frozen (Object.freeze)', () => {
  assert(Object.isFrozen(MSG), 'MSG should be frozen so no runtime can mutate the catalog');
});

// ---------------------------------------------------------------------------
// 2. Sentence splitter invariants (shared_contracts §5)
// ---------------------------------------------------------------------------

group('2. Sentence splitting (src/shared/text/sentence-splitter.js)');

check('MAX_SENTENCE_CHARS is 900 per contract', () => {
  assertEqual(MAX_SENTENCE_CHARS, 900, 'MAX_SENTENCE_CHARS must stay 900 (Bulbul limit 2500, contract keeps 900 headroom)');
});

check('splitSentences never produces a segment longer than MAX_SENTENCE_CHARS (long run-on paragraph)', () => {
  const words = [];
  for (let i = 0; i < 400; i++) words.push(`word${i}`);
  const runOn = words.join(' '); // ~3300 chars, zero sentence-ending punctuation
  const segments = splitSentences(runOn);
  assert(segments.length > 1, 'a run-on paragraph this long must be hard-split into more than one segment');
  for (const [i, seg] of segments.entries()) {
    assert(seg.length <= MAX_SENTENCE_CHARS, `segment[${i}] length ${seg.length} exceeds MAX_SENTENCE_CHARS`);
  }
});

check('splitSentences never exceeds a custom maxChars either', () => {
  const text =
    'Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey.';
  const segments = splitSentences(text, { maxChars: 40 });
  assert(segments.length > 1, 'expected multiple chunks at maxChars=40');
  for (const [i, seg] of segments.entries()) {
    assert(seg.length <= 40, `segment[${i}] ("${seg}") length ${seg.length} exceeds maxChars=40`);
  }
});

check('splitSentences hard-splits a single unbroken word longer than maxChars', () => {
  const oneGiantWord = 'x'.repeat(2000);
  const segments = splitSentences(oneGiantWord, { maxChars: 900 });
  assert(segments.length >= 3, `expected the 2000-char unbroken token to be chunked, got ${segments.length} segment(s)`);
  for (const seg of segments) {
    assert(seg.length <= 900, 'chunk exceeds maxChars even with no whitespace to split on');
  }
});

check('abbreviations (Dr., Mr., U.S., U.K., e.g., St., approx., No., Fig., i.e., Prof., Jr.) do not split', () => {
  const text =
    "Dr. Smith met Mr. Jones near the U.S. embassy at approx. 3 o'clock, e.g. right on Main St., " +
    'not far from the U.K. consulate. The meeting concluded early, i.e. before Prof. Baker arrived, ' +
    'and No. 12 Fig. 4 was filed away by Mrs. Lee Jr.';
  const segments = splitSentences(text);
  assertEqual(segments.length, 2, `expected exactly 2 real sentences, got ${segments.length}: ${JSON.stringify(segments)}`);
  assert(segments[0].includes('U.S.'), 'first segment should retain "U.S." intact');
  assert(segments[0].includes('Dr. Smith'), 'first segment should retain "Dr. Smith" intact (no split after "Dr.")');
  assert(segments[0].includes('U.K. consulate'), 'first segment should end at "U.K. consulate."');
  assert(segments[1].startsWith('The meeting'), 'second segment should start at "The meeting"');
  assert(segments[1].includes('Prof. Baker'), 'second segment should retain "Prof. Baker" intact');
  assert(segments[1].includes('Jr.'), 'second segment should retain trailing "Jr." intact');
});

check('decimal points do not split ("3.14", "2.5")', () => {
  const text = 'The reading was 3.14 today. It rose to 2.5 by noon.';
  const segments = splitSentences(text);
  assertEqual(segments.length, 2, `expected exactly 2 sentences, got ${segments.length}: ${JSON.stringify(segments)}`);
  assert(segments[0].includes('3.14'), 'first segment should retain "3.14" intact');
  assert(segments[1].includes('2.5'), 'second segment should retain "2.5" intact');
});

check('empty / whitespace-only input yields no sentences', () => {
  assertEqual(splitSentences('').length, 0, 'empty string should yield []');
  assertEqual(splitSentences('   \n\t  ').length, 0, 'whitespace-only string should yield []');
});

// ---------------------------------------------------------------------------
// 3. Hashing invariants (shared_contracts §6)
// ---------------------------------------------------------------------------

group('3. Hashing (src/shared/hash.js)');

check('fnv1a32("") equals the raw FNV offset basis (811c9dc5)', () => {
  assertEqual(fnv1a32(''), '811c9dc5', 'empty-string hash must equal the untouched offset basis');
});

check('fnv1a32 is deterministic and 8 lowercase hex chars', () => {
  const a = fnv1a32('cadence-reader');
  const b = fnv1a32('cadence-reader');
  assertEqual(a, b, 'same input must hash identically every time');
  assert(/^[0-9a-f]{8}$/.test(a), `expected 8 lowercase hex chars, got "${a}"`);
});

check('fnv1a32 differs for different inputs (no trivial collisions on near-identical strings)', () => {
  const hashes = new Set(['home', 'Home', 'home ', 'x:home'].map(fnv1a32));
  assertEqual(hashes.size, 4, 'expected 4 distinct hashes for 4 distinct strings');
});

check('normalizeUrl lowercases host, strips hash, strips tracking params, sorts remaining params', () => {
  const input = 'https://Example.COM/Article/?utm_source=newsletter&b=2&a=1#Section2';
  const normalized = normalizeUrl(input);
  assert(normalized.startsWith('https://example.com'), `host should be lowercased, got "${normalized}"`);
  assert(!normalized.includes('utm_source'), `utm_ params must be stripped, got "${normalized}"`);
  assert(!normalized.includes('#'), `hash fragment must be stripped, got "${normalized}"`);
  assert(normalized.indexOf('a=1') < normalized.indexOf('b=2'), `remaining params must be sorted (a before b), got "${normalized}"`);
});

check('normalizeUrl strips a single trailing slash but keeps a bare root slash', () => {
  assert(!normalizeUrl('https://example.com/some-path/').endsWith('/'), 'trailing slash on a real path must be stripped');
  assertEqual(normalizeUrl('https://example.com/'), 'https://example.com/', 'bare root "/" must be preserved as-is');
});

check('contentHashFromSentences is deterministic and changes when sentences change', () => {
  const s1 = [{ text: 'Hello world.' }, { text: 'Second sentence here.' }];
  const s2 = [{ text: 'Hello world.' }, { text: 'Second sentence, edited.' }];
  const h1a = contentHashFromSentences(s1);
  const h1b = contentHashFromSentences(s1);
  const h2 = contentHashFromSentences(s2);
  assertEqual(h1a, h1b, 'hashing the same sentence array twice must be stable');
  assert(h1a !== h2, 'editing article content must change the content hash (so resume does not silently misfire)');
});

// ---------------------------------------------------------------------------
// 4. contentKey / contextId derivation table (shared_contracts §6)
// ---------------------------------------------------------------------------

group('4. contentKey / contextId derivation (src/shared/keys.js)');

check('articleContentKey matches the documented format', () => {
  const url = 'https://Example.COM/Article/?utm_source=newsletter&b=2&a=1#Section2';
  const sentences = [{ text: 'Hello world.' }, { text: 'Second sentence here.' }];
  const contentHash = contentHashFromSentences(sentences);
  const expected = `article:${fnv1a32(normalizeUrl(url))}:${contentHash}`;
  assertEqual(articleContentKey(url, contentHash), expected, 'articleContentKey must be `article:${fnv1a(normalizeUrl(url))}:${contentHash}`');
});

/**
 * The dozen sample URLs required by the task: /home, /i/status/, a
 * /user/status/ variant, /i/lists/, /search (x2, to exercise the hash),
 * profile paths (x2, with/without trailing slash), and a couple of
 * catch-all "other:" paths that must NOT be mistaken for single-segment
 * profile paths.
 * @type {Array<{url: string, expected: (u: URL) => string, label: string}>}
 */
const SAMPLE_URLS = [
  { label: '/home', url: 'https://x.com/home', expected: () => 'home' },
  { label: '/home/ (trailing slash)', url: 'https://twitter.com/home/', expected: () => 'home' },
  { label: '/i/status/<id>', url: 'https://x.com/i/status/1234567890', expected: () => 'status:1234567890' },
  {
    label: '/<user>/status/<id>',
    url: 'https://x.com/someuser/status/9876543210',
    expected: () => 'status:9876543210',
  },
  {
    label: '/i/status/<id> with a query string (query must be ignored)',
    url: 'https://x.com/i/status/42?s=20',
    expected: () => 'status:42',
  },
  {
    label: '/i/lists/<id>',
    url: 'https://x.com/i/lists/1445078208611346434',
    expected: () => 'list:1445078208611346434',
  },
  {
    label: '/search?q=... (plain query)',
    url: 'https://x.com/search?q=chrome%20extension&src=typed_query',
    expected: () => `search:${fnv1a32('chrome extension')}`,
  },
  {
    label: '/search?q=... (query needing URL-decoding)',
    url: 'https://x.com/search?q=%23JavaScript',
    expected: () => `search:${fnv1a32('#JavaScript')}`,
  },
  { label: '/<user> (profile)', url: 'https://x.com/naval', expected: () => 'profile:naval' },
  { label: '/<user>/ (profile, trailing slash)', url: 'https://x.com/naval/', expected: () => 'profile:naval' },
  {
    label: '/i/bookmarks (two segments, must NOT match profile)',
    url: 'https://x.com/i/bookmarks',
    expected: (u) => `other:${fnv1a32(u.pathname)}`,
  },
  {
    label: '/i/some/deep/path (catch-all "other:")',
    url: 'https://x.com/i/some/deep/path',
    expected: (u) => `other:${fnv1a32(u.pathname)}`,
  },
];

assertEqual(SAMPLE_URLS.length, 12, 'the sample URL table itself must contain a dozen entries');

for (const { label, url, expected } of SAMPLE_URLS) {
  check(`twitterContextId: ${label}`, () => {
    const parsed = new URL(url);
    const location = { pathname: parsed.pathname, search: parsed.search };
    const actual = twitterContextId(location);
    assertEqual(actual, expected(parsed), `twitterContextId(${JSON.stringify(location)})`);
    assertEqual(twitterContentKey(location), `x:${actual}`, 'twitterContentKey must be `x:${contextId}`');
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`contract-check: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);

if (failCount > 0) {
  console.log('\nFailures:');
  for (const { name, error } of failures) {
    console.log(`  - ${name}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All shared-contract invariants hold.');
}
