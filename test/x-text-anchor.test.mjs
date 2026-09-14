/**
 * test/x-text-anchor.test.mjs
 *
 * Exercises the real bug fix end to end: build a tweet DOM, extract it with
 * the real `parseTweet()` + `groupTweetsIntoUnits()` (the exact pipeline
 * that builds each sentence's `textFingerprint`), then hand that same live
 * DOM to the real `findRangeForSentence()` and check it finds a Range for
 * every sentence.
 *
 * Before this fix, `twitter.js`'s old `findRangeForFingerprint()` searched
 * un-normalized `textContent` for a normalized fingerprint, so it missed on
 * nearly every real tweet (a line break, a link, an emoji, an ellipsis, a
 * dash all make the raw and normalized text disagree) and returned null --
 * which made `ensureVisible()` fall back to scrolling the whole tweet card,
 * re-triggering on every sentence of a card taller than the viewport. This
 * file's fixture deliberately contains all five of those triggers so a
 * regression shows up as a null Range, not just a slightly-off one.
 *
 * Dependency-free (this repo has no devDependencies, no jsdom): builds its
 * own minimal DOM stub, same approach as
 * test/x-tweet-parser-styled-text.test.mjs and test/harness/*.mjs (a tiny
 * inline group/check/assert harness, process.exitCode on failure). Only the
 * DOM surface x-tweet-parser.js and x-text-anchor.js actually touch is
 * implemented -- no general CSS engine, no shadow DOM, no MutationObserver.
 *
 * Run with: node test/x-text-anchor.test.mjs
 */

import { parseTweet } from '../src/content/extract/lib/x-tweet-parser.js';
import { groupTweetsIntoUnits } from '../src/content/extract/lib/x-thread-grouper.js';
import { findRangeForSentence } from '../src/content/extract/lib/x-text-anchor.js';

// ---------------------------------------------------------------------------
// Tiny inline test harness (matches test/harness/*.mjs)
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
 * @param {() => void|Promise<void>} fn
 */
async function check(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name: `${currentGroup} > ${name}`, error: err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM stub -- only what parseTweet()/findRangeForSentence() touch:
// Element (querySelector/querySelectorAll/closest/contains/textContent),
// Text nodes, document.createTreeWalker (SHOW_TEXT only), document.createRange.
// Non-ASCII fixture characters are all written as \u escapes below, never as
// literal source bytes, so there is no ambiguity about which codepoint ended
// up on disk.
// ---------------------------------------------------------------------------

const ELLIPSIS = '…'; // "…"
const EM_DASH = '—'; // "—"
const EMOJI = String.fromCodePoint(0x1fa84); // "🪄" (a magic wand, BMP-exceeding on purpose)

globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.NodeFilter = { SHOW_TEXT: 4 };

/**
 * Parses a single compound CSS selector -- an optional tag name plus at
 * most one `[attr]` or `[attr="value"]` clause. Covers every selector this
 * test's code paths actually issue (see x-selectors.js); deliberately not a
 * general selector engine (no descendant combinators, no comma lists).
 * @param {string} selector
 * @returns {{tag: string|null, attr: string|null, hasValue: boolean, value: string|undefined}|null}
 */
function parseSimpleSelector(selector) {
  const m = selector.trim().match(/^([a-zA-Z][a-zA-Z0-9]*)?(?:\[([a-zA-Z0-9_:.-]+)(?:="([^"]*)")?\])?$/);
  if (!m) return null;
  return { tag: m[1] ? m[1].toUpperCase() : null, attr: m[2] || null, hasValue: m[3] !== undefined, value: m[3] };
}

/**
 * @param {FakeElement} el
 * @param {ReturnType<typeof parseSimpleSelector>} parsed
 * @returns {boolean}
 */
function elementMatches(el, parsed) {
  if (!parsed || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (parsed.tag && el.tagName !== parsed.tag) return false;
  if (parsed.attr) {
    if (!el.hasAttribute(parsed.attr)) return false;
    if (parsed.hasValue && el.getAttribute(parsed.attr) !== parsed.value) return false;
  }
  return true;
}

class FakeTextNode {
  constructor(value) {
    this.nodeType = Node.TEXT_NODE;
    this.nodeValue = value;
    this.parentNode = null;
  }
  get textContent() {
    return this.nodeValue;
  }
  get length() {
    return this.nodeValue.length;
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = Node.ELEMENT_NODE;
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = new Map();
  }

  get textContent() {
    let out = '';
    for (const child of this.childNodes) {
      out += child.nodeType === Node.TEXT_NODE ? child.nodeValue || '' : child.textContent;
    }
    return out;
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) {
    return this._attrs.has(name);
  }

  querySelectorAll(selector) {
    const parsed = parseSimpleSelector(selector);
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (elementMatches(child, parsed)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    const parsed = parseSimpleSelector(selector);
    let node = this;
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE && elementMatches(node, parsed)) return node;
      node = node.parentNode;
    }
    return null;
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }
}

/**
 * @param {FakeElement} root
 * @returns {{nextNode: () => (FakeTextNode|null)}}
 */
function createTreeWalker(root) {
  const list = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) list.push(child);
      else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
    }
  };
  walk(root);
  let i = 0;
  return { nextNode: () => (i < list.length ? list[i++] : null) };
}

/**
 * A Range boundary comparison needs SOME notion of document order between
 * two different Text nodes. Real DOM computes this structurally; this stub
 * instead stamps every node with its DFS-visit index once a fixture tree is
 * fully built (see assignDocOrder below), so `collapsed` can compare two
 * different nodes' positions with a plain integer comparison.
 */
class FakeRange {
  constructor() {
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
  }
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }
  get collapsed() {
    if (!this.startContainer || !this.endContainer) return true;
    if (this.startContainer === this.endContainer) return this.startOffset >= this.endOffset;
    const a = this.startContainer.__docOrder;
    const b = this.endContainer.__docOrder;
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    return a >= b;
  }
}

globalThis.document = {
  createTreeWalker: (root) => createTreeWalker(root),
  createRange: () => new FakeRange(),
};

// x-tweet-parser.js dispatches a MouseEvent on a "Show more" click; neither
// fixture below produces a truncated tweet (see buildFixtureA/B), so this
// is never invoked -- stubbed only so an accidental future change doesn't
// crash instead of failing a clear assertion.
globalThis.MouseEvent = class FakeMouseEvent {
  constructor(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  }
};
FakeElement.prototype.dispatchEvent = function dispatchEvent() {
  return true;
};

/**
 * @param {string} tag
 * @param {Record<string,string>} attrs
 * @param {Array<string|FakeElement>} children
 * @returns {FakeElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = new FakeElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? new FakeTextNode(child) : child);
  }
  return node;
}

/**
 * Stamps every node under `root` with its DFS order (see FakeRange.collapsed
 * above). Must run once the fixture tree is fully assembled.
 * @param {FakeElement} root
 */
function assignDocOrder(root) {
  let counter = 0;
  const walk = (node) => {
    node.__docOrder = counter++;
    for (const child of node.childNodes || []) walk(child);
  };
  walk(root);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One tweet whose body contains, at minimum, every trigger listed in this
 * bug's root cause: a hard line break (a literal "\n\n" inside a text node,
 * matching how X renders Enter in a tweet), an `<a href>` link, an inline
 * emoji `<img alt>`, an ellipsis, and an em dash.
 * @returns {{article: FakeElement, tweetText: FakeElement}}
 */
function buildFixtureA() {
  const permalink = el('a', { href: '/i/status/1234567890123' }, [el('time', {}, ['2h'])]);
  const userName = el('div', { 'data-testid': 'User-Name' }, ['Ada Lovelace ', '@ada']);
  const tweetText = el('div', { 'data-testid': 'tweetText' }, [
    'Check this out',
    el('img', { alt: EMOJI }),
    ` it works.\n\n`,
    'Read more ',
    el('a', { href: 'https://www.nytimes.com/2024/05/01/us/article.html' }, ['nyti.ms/xyz1']),
    'for the full story',
    ELLIPSIS,
    ' Also ',
    EM_DASH,
    ' this part matters.',
  ]);
  const article = el('article', { 'data-testid': 'tweet' }, [permalink, userName, tweetText]);
  assignDocOrder(article);
  return { article, tweetText };
}

/**
 * A second, deliberately minimal tweet whose body is nothing but the same
 * sentence twice -- isolates the ordinal-disambiguation behavior from
 * fixture A's other content, since `findRangeForSentence`'s "prefer the
 * Nth match" rule uses the sentence's OWN ordinal (its position among ALL
 * of the tweet's sentence specs) as the match index, which only lines up
 * with "the Nth occurrence of this exact repeated phrase" when nothing
 * else precedes the repeat.
 * @returns {{article: FakeElement, tweetText: FakeElement}}
 */
function buildFixtureB() {
  const permalink = el('a', { href: '/i/status/999888777' }, [el('time', {}, ['1h'])]);
  const userName = el('div', { 'data-testid': 'User-Name' }, ['Grace Hopper ', '@grace']);
  const tweetText = el('div', { 'data-testid': 'tweetText' }, ['Thanks so much. Thanks so much.']);
  const article = el('article', { 'data-testid': 'tweet' }, [permalink, userName, tweetText]);
  assignDocOrder(article);
  return { article, tweetText };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  group('Fixture A: line break + link + emoji + ellipsis + dash, every sentence resolves');

  const { article: articleA, tweetText: tweetTextA } = buildFixtureA();
  const tweetDataA = await parseTweet(articleA);

  await check('parseTweet extracts the tweet (status id resolvable)', () => {
    assert(tweetDataA, 'parseTweet returned null');
  });

  await check('mainText carries the link substitution and the emoji glyph', () => {
    assert(tweetDataA.mainText.includes('link to nytimes.com'), `expected a link substitution in ${JSON.stringify(tweetDataA.mainText)}`);
    assert(tweetDataA.mainText.includes(EMOJI), `expected the emoji glyph in ${JSON.stringify(tweetDataA.mainText)}`);
  });

  const unitsA = groupTweetsIntoUnits([tweetDataA], {});

  await check('groupTweetsIntoUnits produces exactly one unit', () => {
    assertEqual(unitsA.length, 1, 'expected a single standalone-tweet unit');
  });

  const sentencesA = unitsA[0]?.sentences || [];

  await check('at least 3 sentences were split out', () => {
    assert(sentencesA.length >= 3, `expected several sentences, got ${sentencesA.length}`);
  });

  for (const sentence of sentencesA) {
    await check(`sentence ${JSON.stringify(sentence.text)} (ordinal ${sentence.locator.sentenceOrdinal}) resolves to a non-null, non-collapsed Range`, () => {
      const range = findRangeForSentence(tweetTextA, sentence.locator.textFingerprint, {
        ordinal: sentence.locator.sentenceOrdinal,
      });
      assert(range, `findRangeForSentence returned null for fingerprint ${JSON.stringify(sentence.locator.textFingerprint)}`);
      assert(!range.collapsed, 'range must not be collapsed (zero-width)');
    });
  }

  group('Fixture B: repeated identical sentence, ordinal picks the right occurrence');

  const { article: articleB, tweetText: tweetTextB } = buildFixtureB();
  const tweetDataB = await parseTweet(articleB);
  const unitsB = groupTweetsIntoUnits([tweetDataB], {});
  const sentencesB = unitsB[0]?.sentences || [];

  await check('exactly two sentences with IDENTICAL text were produced', () => {
    assertEqual(sentencesB.length, 2, `expected 2 sentences, got ${sentencesB.length}`);
    assertEqual(sentencesB[0].text, sentencesB[1].text, 'the two sentences should be textually identical (that is the point of this fixture)');
    assertEqual(sentencesB[0].locator.sentenceOrdinal, 0, 'first sentence should be ordinal 0');
    assertEqual(sentencesB[1].locator.sentenceOrdinal, 1, 'second sentence should be ordinal 1');
  });

  const range0 = findRangeForSentence(tweetTextB, sentencesB[0].locator.textFingerprint, {
    ordinal: sentencesB[0].locator.sentenceOrdinal,
  });
  const range1 = findRangeForSentence(tweetTextB, sentencesB[1].locator.textFingerprint, {
    ordinal: sentencesB[1].locator.sentenceOrdinal,
  });

  await check('both occurrences resolve to a Range', () => {
    assert(range0, 'ordinal 0 (first occurrence) should resolve');
    assert(range1, 'ordinal 1 (second occurrence) should resolve');
  });

  await check('ordinal 0 and ordinal 1 land on DIFFERENT positions in the text (not both the first occurrence)', () => {
    // Before this fix, plain indexOf() always returns the FIRST occurrence,
    // so both sentences would highlight the same span. Asserting the two
    // start offsets differ, with ordinal 0 strictly before ordinal 1, is
    // exactly the regression this feature prevents.
    assert(
      range0.startContainer !== range1.startContainer || range0.startOffset !== range1.startOffset,
      'both ordinals resolved to the exact same start position -- the repeated phrase was not disambiguated'
    );
    assert(range0.startOffset < range1.startOffset, `expected the first occurrence (offset ${range0.startOffset}) to start before the second (offset ${range1.startOffset})`);
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`x-text-anchor: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);

  if (failCount > 0) {
    console.log('\nFailures:');
    for (const { name, error } of failures) {
      console.log(`  - ${name}: ${error.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log('All x-text-anchor invariants hold.');
  }
}

main();
