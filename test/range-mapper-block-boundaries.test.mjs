#!/usr/bin/env node
/**
 * test/range-mapper-block-boundaries.test.mjs
 *
 * Regression test for R5 (range-mapper.js block boundaries + locator
 * resilience, sentence-splitter.js ABBR placeholder). Dependency-free Node
 * script -- no test runner, no npm devDependencies (the repo has none) --
 * printing pass/fail per check and exiting non-zero if any assertion
 * fails, matching test/harness/contract-check.mjs's pattern.
 *
 * Run with: node test/range-mapper-block-boundaries.test.mjs
 *
 * range-mapper.js needs a real DOM (Node/Text/Element with childNodes,
 * getComputedStyle, Range, etc.) and this repo intentionally has no jsdom
 * or other npm dependency to provide one. Rather than skip DOM-level
 * coverage entirely, this file implements the minimum DOM surface that
 * range-mapper.js's own dependency chain (dom-walk.js, visibility.js)
 * actually touches, plus a small regex-based HTML parser good enough to
 * load test/fixtures/article-sample.html verbatim. This is intentionally
 * NOT a general-purpose HTML/DOM implementation -- it only needs to be
 * correct for the fixture this file loads.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractSentencesWithLocators, buildRawTextAndMap, resolveLocatorToRange } from '../src/content/extract/lib/range-mapper.js';
import { normalizeForSpeech } from '../src/shared/text/normalize.js';
import { splitSentences } from '../src/shared/text/sentence-splitter.js';
import { MAX_SENTENCE_CHARS } from '../src/shared/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tiny inline test harness (same pattern as test/harness/contract-check.mjs)
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
// Minimal DOM shim
//
// Only what dom-walk.js / visibility.js / range-mapper.js actually read:
// nodeType, tagName, nodeValue, parentNode/parentElement, childNodes (a
// real Array, so Array.prototype.indexOf.call() in computeNodePath works
// unmodified), isConnected, ownerDocument, getAttribute/hasAttribute,
// className/id, hidden, getBoundingClientRect(), and a global
// getComputedStyle(). Every fixture node is considered visible by default
// (matches the fixture's actual CSS: nothing in article.main-content is
// hidden, aria-hidden, or zero-size) since correctly re-implementing a CSS
// cascade is out of scope for this test -- it exists to prove the block-
// boundary and locator fixes, not to re-verify visibility.js.
// ---------------------------------------------------------------------------

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
globalThis.Node = { ELEMENT_NODE, TEXT_NODE, COMMENT_NODE: 8 };

const DEFAULT_STYLE = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  position: 'static',
  left: 'auto',
  top: 'auto',
  clip: 'auto',
  clipPath: 'none',
};
globalThis.getComputedStyle = () => ({ ...DEFAULT_STYLE });

/**
 * Deliberately minimal Range: correct only for the same-node ranges the
 * locator-resilience tests below construct (every locator in this test
 * suite has startNode === endNode). It does implement the one piece of
 * real DOM Range behavior those tests depend on -- per spec, setEnd()
 * before a boundary that is actually earlier than the current start does
 * NOT throw, it collapses the Range to that (wrong) point -- since that
 * exact spec quirk is what R5-B's `range.collapsed` check guards against.
 */
class MiniRange {
  constructor() {
    this._start = null;
    this._end = null;
  }
  setStart(node, offset) {
    this._start = { node, offset };
    if (this._end && this._end.node === node && this._end.offset < offset) {
      this._end = { node, offset };
    }
  }
  setEnd(node, offset) {
    if (this._start && this._start.node === node && offset < this._start.offset) {
      this._start = { node, offset };
      this._end = { node, offset };
    } else {
      this._end = { node, offset };
    }
  }
  get collapsed() {
    if (!this._start || !this._end) return true;
    return this._start.node === this._end.node && this._start.offset === this._end.offset;
  }
  toString() {
    if (!this._start || !this._end || this._start.node !== this._end.node) return '';
    return (this._start.node.nodeValue || '').slice(this._start.offset, this._end.offset);
  }
}

class FakeDocument {
  createRange() {
    return new MiniRange();
  }
}
const FAKE_DOCUMENT = new FakeDocument();

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get isConnected() {
    return true; // single parsed tree, never detached -- see file header
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }
  get ownerDocument() {
    return FAKE_DOCUMENT;
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super(TEXT_NODE);
    this.nodeValue = value;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, attrs) {
    super(ELEMENT_NODE);
    this.tagName = tagName.toUpperCase();
    this.attributes = attrs || {};
    this.hidden = false;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  get className() {
    return this.attributes.class || '';
  }
  get id() {
    return this.attributes.id || '';
  }
  getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 };
  }
  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
}

// ---------------------------------------------------------------------------
// Tiny regex-based HTML parser
//
// Not a general HTML5 parser: it assumes attribute values never contain an
// unescaped ">" (true of this fixture) and is only asked to parse this
// fixture's own markup. A single tokenizing regex splits the source into
// comments, tags, and text runs; a stack of open elements does the rest.
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'img', 'meta', 'link', 'hr', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

// Only the named entities this fixture actually uses, plus the generic
// numeric-entity and universal amp/lt/gt/quot/apos/nbsp cases.
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  copy: '©',
};

/**
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : whole;
  });
}

/**
 * @param {string} attrString
 * @returns {Record<string,string>}
 */
function parseAttrs(attrString) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g;
  let m;
  while ((m = re.exec(attrString))) {
    const name = m[1].toLowerCase();
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2] !== undefined ? m[2] : '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * @param {string} html
 * @returns {FakeElement} a synthetic root element holding the parsed tree
 */
function parseHTML(html) {
  const tokenRe = /<!--[\s\S]*?-->|<[^>]+>|[^<]+/g;
  const root = new FakeElement('DOCUMENT-ROOT', {});
  const stack = [root];
  let m;

  while ((m = tokenRe.exec(html))) {
    const token = m[0];

    if (token.startsWith('<!--') || token.startsWith('<!')) continue; // comment / DOCTYPE

    if (token.startsWith('</')) {
      const nameMatch = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
      if (!nameMatch) continue;
      const name = nameMatch[1].toUpperCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (token.startsWith('<')) {
      const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
      if (!nameMatch) continue;
      const tagName = nameMatch[1];
      const selfClosed = /\/\s*>$/.test(token);
      const attrString = token.slice(nameMatch[0].length, token.length - (selfClosed ? 2 : 1));
      const el = new FakeElement(tagName, parseAttrs(attrString));
      stack[stack.length - 1].appendChild(el);
      if (!VOID_TAGS.has(tagName.toLowerCase()) && !selfClosed) stack.push(el);
      continue;
    }

    stack[stack.length - 1].appendChild(new FakeText(decodeEntities(token)));
  }

  return root;
}

/**
 * @param {FakeElement} root
 * @param {(el: FakeElement) => boolean} predicate
 * @returns {FakeElement|null}
 */
function findFirstElement(root, predicate) {
  if (root.nodeType === ELEMENT_NODE && predicate(root)) return root;
  for (const child of root.childNodes) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const found = findFirstElement(child, predicate);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load the fixture and run it through the real extraction pipeline
// ---------------------------------------------------------------------------

const fixturePath = join(__dirname, 'fixtures', 'article-sample.html');
const html = readFileSync(fixturePath, 'utf8');
const documentRoot = parseHTML(html);

const articleEl = findFirstElement(
  documentRoot,
  (el) => el.tagName === 'ARTICLE' && el.className.split(/\s+/).includes('main-content')
);

if (!articleEl) {
  console.log('FAIL  could not locate <article class="main-content"> in the fixture -- aborting');
  process.exit(1);
}

const sentences = extractSentencesWithLocators(articleEl);
const { raw } = buildRawTextAndMap(articleEl);
const normalizedText = normalizeForSpeech(raw);
const sentenceTexts = sentences.map((s) => s.text);

// ---------------------------------------------------------------------------
// 1. Block boundaries (R5-A)
// ---------------------------------------------------------------------------

group('1. Block boundaries (range-mapper.js buildRawTextAndMap)');

check('a heading with no terminal punctuation is its own sentence, not glued to the paragraph below it', () => {
  assert(
    sentenceTexts.includes('Be outcome-oriented'),
    `expected a sentence exactly "Be outcome-oriented"; got: ${JSON.stringify(sentenceTexts)}`
  );
  assert(
    sentenceTexts.includes('Ship things that work, then keep them working'),
    'expected the following paragraph as its own separate sentence'
  );
  assert(
    !sentenceTexts.some((t) => t.includes('Be outcome-oriented') && t.includes('Ship things')),
    'the heading must not be glued onto the paragraph that follows it in a single sentence'
  );
});

check('each <br>-separated line is its own sentence', () => {
  const expectedLines = ['1400 Maintenance Way', 'Suite 4', 'Springfield'];
  for (const line of expectedLines) {
    assert(sentenceTexts.includes(line), `expected a sentence exactly ${JSON.stringify(line)}; got: ${JSON.stringify(sentenceTexts)}`);
  }
  assert(
    !sentenceTexts.some((t) => expectedLines.filter((line) => t.includes(line)).length > 1),
    '<br>-separated lines must not be merged into one sentence'
  );
});

check('each <li> in the boundary list is its own sentence', () => {
  const expectedItems = [
    'Watch the leading indicators, not just the trailing ones',
    'Assume equipment will fail on the worst possible day',
    'Write down what almost went wrong, not just what did',
  ];
  for (const item of expectedItems) {
    assert(sentenceTexts.includes(item), `expected a sentence exactly ${JSON.stringify(item)}; got: ${JSON.stringify(sentenceTexts)}`);
  }
  assert(
    !sentenceTexts.some((t) => expectedItems.filter((item) => t.includes(item)).length > 1),
    '<li> items must not be merged into one sentence'
  );
});

check(`no emitted sentence exceeds MAX_SENTENCE_CHARS (${MAX_SENTENCE_CHARS})`, () => {
  for (const [i, text] of sentenceTexts.entries()) {
    assert(text.length <= MAX_SENTENCE_CHARS, `sentence[${i}] length ${text.length} exceeds MAX_SENTENCE_CHARS: ${JSON.stringify(text)}`);
  }
});

check('every emitted sentence is still a substring of the normalized text (locateSentenceOffsets invariant)', () => {
  for (const [i, text] of sentenceTexts.entries()) {
    assert(normalizedText.includes(text), `sentence[${i}] is not a substring of the normalized text: ${JSON.stringify(text)}`);
  }
});

check('extraction produced a non-trivial number of sentences (sanity check the fixture actually loaded)', () => {
  assert(sentenceTexts.length > 20, `expected the full article fixture to yield well over 20 sentences, got ${sentenceTexts.length}`);
});

// ---------------------------------------------------------------------------
// 2. ABBR placeholder fix (R5-C)
// ---------------------------------------------------------------------------

group('2. ABBR placeholder fix (sentence-splitter.js)');

check('text containing the literal " ABBR" token round-trips through splitSentences unchanged', () => {
  const text = 'The badge reads " ABBR" on every uniform. It never changes.';
  const result = splitSentences(text);
  assertEqual(result.length, 2, `expected 2 sentences, got ${result.length}: ${JSON.stringify(result)}`);
  assert(
    result[0].includes('" ABBR" on every uniform'),
    `the literal " ABBR" substring must survive intact, got: ${JSON.stringify(result[0])}`
  );
  assert(!result.join(' ').includes('" ABBR."'), 'a period must never be spliced into the literal " ABBR" token');
});

check('a decimal immediately followed by the word "ABBR" does not corrupt either', () => {
  // Adversarial case for the OLD ' ABBR' placeholder design: "3.14 ABBR unit"
  // contains both a protected decimal AND the literal placeholder text back
  // to back. The old restorePeriods() would have matched into the decimal's
  // own replacement and corrupted it; the PUA sentinel cannot collide here.
  const text = 'The reading was 3.14 ABBR unit today.';
  const result = splitSentences(text);
  assertEqual(result.length, 1, `expected 1 sentence, got ${result.length}: ${JSON.stringify(result)}`);
  assert(result[0].includes('3.14 ABBR unit'), `decimal and literal ABBR text must both survive intact, got: ${JSON.stringify(result[0])}`);
});

// ---------------------------------------------------------------------------
// 3. Locator resilience (R5-B): resolveLocatorToRange
// ---------------------------------------------------------------------------

group('3. Locator resilience (range-mapper.js resolveLocatorToRange)');

check('a crossed start/end (findNearestMapEntry probes crossing) collapses the Range, and that must resolve to null', () => {
  // Simulates every character of a sentence mapping to a `null` rawMap
  // entry: buildLocatorFromOffset's forward (start) and backward (end)
  // probes can then cross, producing startOffset > endOffset within the
  // SAME node. setEnd() before setStart() collapses the Range to a point
  // per spec instead of throwing -- pre-fix, that silent zero-width Range
  // was returned as if it were a valid highlight.
  const container = new FakeElement('DIV', {});
  const textNode = new FakeText('Hello');
  container.appendChild(textNode);

  const locator = {
    startNode: textNode,
    startOffset: 3,
    endNode: textNode,
    endOffset: 1,
    containerRef: container,
    nodePath: [[0], [0]],
  };

  const range = resolveLocatorToRange(locator, 'Hello');
  assert(range === null, `expected null for a crossed/collapsed locator, got a Range with text: ${JSON.stringify(range && range.toString())}`);
});

check('content verification runs on the fast (still-connected) path too, not only after index-path re-resolution', () => {
  // highlighter.js's surroundContents fallback (span-insertion + clear()'s
  // parent.normalize()) can rewrite which text node holds which sentence's
  // content while every node stays `isConnected` -- so this is NOT only a
  // rePathed-branch problem. Simulate that: two sibling text nodes recorded
  // as "First sentence" / "Second sentence", then their content is swapped
  // in place (as normalize()-driven text-node reuse would do) without
  // either node ever disconnecting.
  const container = new FakeElement('P', {});
  const nodeA = new FakeText('First sentence');
  const nodeB = new FakeText('Second sentence');
  container.appendChild(nodeA);
  container.appendChild(nodeB);

  const locatorForA = {
    startNode: nodeA,
    startOffset: 0,
    endNode: nodeA,
    endOffset: 'First sentence'.length,
    containerRef: container,
    nodePath: [[0], [0]],
  };

  // The DOM mutation this locator's node offsets no longer describe.
  nodeA.nodeValue = 'Second sentence';
  nodeB.nodeValue = 'First sentence';

  const range = resolveLocatorToRange(locatorForA, 'First sentence');
  assert(range !== null, 'expected recovery via findRangeByText, not a lost highlight');
  assert(
    range.toString() === 'First sentence',
    `expected the recovered range to contain the CURRENT location of "First sentence" (now nodeB), got: ${JSON.stringify(range.toString())}`
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`range-mapper-block-boundaries: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);

if (failCount > 0) {
  console.log('\nFailures:');
  for (const { name, error } of failures) {
    console.log(`  - ${name}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All block-boundary / locator-resilience invariants hold.');
}
