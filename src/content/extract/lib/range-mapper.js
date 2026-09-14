/**
 * src/content/extract/lib/range-mapper.js
 *
 * The core of the article extractor: builds each ReadUnit's sentence text
 * while simultaneously recording, per sentence, an opaque DOM locator that
 * `resolveAnchor()` can later turn back into a live Range for highlighting.
 *
 * How it works:
 *  1. `buildRawTextAndMap` walks a unit container's visible text nodes in
 *     DOM order (see dom-walk.js) and concatenates their raw characters
 *     into one string, remembering, for every single output character,
 *     exactly which (node, offset) it came from.
 *  2. `normalizeWithMap` mirrors shared/text/normalize.js's
 *     `normalizeForSpeech` transform-for-transform (same regexes, same
 *     order) but threads the origin map through every step, so the
 *     resulting normalized string has a parallel array of (node, offset)
 *     origins. The *actual* text handed to the splitter/TTS is always
 *     produced by the real `normalizeForSpeech` (imported, not
 *     reimplemented) so this module can never make the spoken text diverge
 *     from what shared/text/normalize.js would produce; the mirrored
 *     version is used only to build the offset map, and is defensively
 *     reconciled (length-clamped) if it and the real output ever disagree.
 *  3. `splitSentences` (shared) cuts the normalized text into sentences;
 *     each sentence's [start, end) offset in the normalized text is located
 *     by sequential `indexOf`, then mapped through the origin map back to a
 *     concrete start/end (node, offset) pair — the locator.
 *
 * The locator also carries an index-path from the container to the start/
 * end nodes (`nodePath`) so `resolveLocatorToRange` can re-resolve a live
 * Range even after the original text node references have gone stale (e.g.
 * a framework re-rendered the subtree), as long as the container is still
 * connected and the tree shape is close enough for the indices to still
 * line up. Every public function here is defensive: it degrades to `null`
 * rather than throwing.
 */

import { normalizeForSpeech } from '../../../shared/text/normalize.js';
import { splitSentences, BLOCK_BOUNDARY_SENTINEL } from '../../../shared/text/sentence-splitter.js';
import { walkDOM } from './dom-walk.js';
import { isVisibleTextNode } from './visibility.js';

const DEFAULT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

// Elements whose boundary marks a real sentence break during the raw-text
// walk (see buildRawTextAndMap / collectTextNodes below): crossing into a
// different one of these from the previous visible text node's nearest
// ancestor means the two text runs come from different blocks and must
// never be fused into one sentence, no matter how much/little whitespace
// separates them in the source. Without this, a heading with no terminal
// punctuation ("Be outcome-oriented") glues straight onto the paragraph
// that follows it, and every <li> in a list merges into one run-on
// sentence -- see this file's header and the R5 task notes.
const BLOCK_LEVEL_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'TR',
  'DT',
  'DD',
  'FIGCAPTION',
  'PRE',
  'UL',
  'OL',
  'TABLE',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'MAIN',
  'NAV',
]);

/**
 * @param {Element} el
 * @returns {boolean}
 */
function defaultShouldDescend(el) {
  return !DEFAULT_SKIP_TAGS.has(el.tagName);
}

/**
 * Climb from `startNode` up through `parentElement` (crossing out through a
 * shadow-root `.host` the same way visibility.js's `isVisible` does) until
 * hitting an element whose tag is in BLOCK_LEVEL_TAGS, or `container`
 * itself. Two text nodes whose nearest block ancestor differs came from
 * different blocks and must get a sentence boundary between them.
 * @param {Node} startNode
 * @param {Node} container
 * @returns {Node} the nearest block-level ancestor, or `container` if none
 *   was found before reaching it
 */
function nearestBlockAncestor(startNode, container) {
  let current = startNode && startNode.nodeType === Node.ELEMENT_NODE ? startNode : startNode && startNode.parentElement;

  while (current && current !== container) {
    if (BLOCK_LEVEL_TAGS.has(/** @type {Element} */ (current).tagName)) return current;

    const parentElement = /** @type {Element} */ (current).parentElement;
    if (parentElement) {
      current = parentElement;
      continue;
    }

    const parentNode = current.parentNode;
    current = parentNode && /** @type {ShadowRoot} */ (parentNode).host ? /** @type {ShadowRoot} */ (parentNode).host : null;
  }

  return container;
}

/**
 * @typedef {{node: Text, boundaryBefore: boolean}} TextNodeEntry
 */

/**
 * Walk `container`'s visible text nodes in DOM order, in lockstep computing
 * whether each one needs a sentence boundary inserted immediately before it
 * in the raw text: true when a `<br>` or a block-level element boundary
 * (BLOCK_LEVEL_TAGS) separates it from the previous visible text node.
 *
 * This used to just return a flat `Text[]`, which threw away exactly the
 * structural information buildRawTextAndMap now needs to decide where a
 * real sentence break belongs (as opposed to the single synthesized space
 * it used to be limited to). No other module imports this function --
 * verified by grep -- so widening its return shape here is safe.
 * @param {Node} container
 * @param {((el: Element) => boolean)|undefined} customShouldDescend
 * @returns {TextNodeEntry[]}
 */
function collectTextNodes(container, customShouldDescend) {
  const shouldDescend = (el) => {
    if (!defaultShouldDescend(el)) return false;
    return customShouldDescend ? customShouldDescend(el) : true;
  };

  /** @type {TextNodeEntry[]} */
  const entries = [];
  let pendingBoundary = false;
  let prevBlockAncestor = null;
  let sawAnyText = false;

  for (const node of walkDOM(container, { shouldDescend })) {
    if (node.nodeType === Node.ELEMENT_NODE && /** @type {Element} */ (node).tagName === 'BR') {
      pendingBoundary = true;
      continue;
    }

    if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue || !isVisibleTextNode(node)) continue;

    const textNode = /** @type {Text} */ (node);
    const blockAncestor = nearestBlockAncestor(textNode.parentElement || textNode.parentNode, container);
    const crossedBlock = sawAnyText && blockAncestor !== prevBlockAncestor;

    entries.push({ node: textNode, boundaryBefore: sawAnyText && (pendingBoundary || crossedBlock) });

    pendingBoundary = false;
    prevBlockAncestor = blockAncestor;
    sawAnyText = true;
  }

  return entries;
}

/**
 * @typedef {{node: Text, offset: number}} MapEntry
 */

/**
 * Concatenate visible text nodes in DOM order into one raw string, with a
 * parallel `rawMap` array where `rawMap[i]` is the {node, offset} that
 * produced `raw[i]` (or `null` for a character with no originating DOM
 * position -- currently only the synthetic block-boundary sentinel below).
 *
 * Two kinds of synthetic characters can be inserted between adjacent text
 * nodes:
 *  - A single space, when neither side already has boundary whitespace, to
 *    avoid mashing words together across inline element boundaries (e.g.
 *    "<b>foo</b>bar" vs "<b>foo</b> bar"). Unchanged from before.
 *  - BLOCK_BOUNDARY_SENTINEL, when `collectTextNodes` flagged a real block
 *    boundary (a `<br>`, or crossing into a different BLOCK_LEVEL_TAGS
 *    ancestor) between the two nodes. splitSentences() hard-splits on this
 *    sentinel, so it -- not the plain space above -- is what stops a
 *    heading with no terminal punctuation from gluing onto the paragraph
 *    after it. The sentinel gets a `null` rawMap entry rather than
 *    attributing it to either neighboring node: findNearestMapEntry() (used
 *    by buildLocatorFromOffset) already scans forward/backward past `null`
 *    entries to find the nearest real one, which is exactly what's needed
 *    here since the sentinel itself never appears inside any sentence
 *    string splitSentences() returns (so no locator ever needs to resolve
 *    to the sentinel's own position).
 * @param {Node} container
 * @param {((el: Element) => boolean)|undefined} shouldDescend
 * @returns {{raw: string, rawMap: Array<MapEntry|null>, textNodes: Text[]}}
 */
// Exported (only extractSentencesWithLocators/findRangeByText call it inside
// this file) so tests can assert the exact raw/normalized text this module
// produces -- e.g. the block-boundary and substring-invariant tests in
// test/range-mapper-block-boundaries.test.mjs -- without duplicating this
// function's synthetic-space/sentinel logic in the test itself.
export function buildRawTextAndMap(container, shouldDescend) {
  const entries = collectTextNodes(container, shouldDescend);

  let raw = '';
  /** @type {Array<MapEntry|null>} */
  const rawMap = [];

  for (let n = 0; n < entries.length; n++) {
    const { node, boundaryBefore } = entries[n];
    const value = node.nodeValue || '';

    if (n > 0 && raw.length && value.length) {
      if (boundaryBefore) {
        raw += BLOCK_BOUNDARY_SENTINEL;
        rawMap.push(null);
      } else {
        const prevEndsWithSpace = /\s$/.test(raw);
        const nextStartsWithSpace = /^\s/.test(value);
        if (!prevEndsWithSpace && !nextStartsWithSpace) {
          raw += ' ';
          const prevNode = entries[n - 1].node;
          rawMap.push({ node: prevNode, offset: (prevNode.nodeValue || '').length });
        }
      }
    }

    for (let i = 0; i < value.length; i++) {
      raw += value[i];
      rawMap.push({ node, offset: i });
    }
  }

  return { raw, rawMap, textNodes: entries.map((entry) => entry.node) };
}

// --- Mirrored (map-tracking) normalization, kept in exact lockstep with
// shared/text/normalize.js's normalizeForSpeech(). If that file's transform
// steps ever change, this must be updated to match. ---

const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;
const BARE_URL_RE = /\bhttps?:\/\/[^\s]+/gi;
const LEADING_PUNCT_RE = /^[\s\p{P}\p{S}]+/u;
const TRAILING_PUNCT_RE = /[\s\p{P}\p{S}]+$/u;

/**
 * @typedef {{text: string, map: Array<MapEntry|null>}} TrackedState
 */

/**
 * Apply `regex` (global) to `state.text`, replacing each match with
 * `replacement` (string or `(match) => string`), while keeping `state.map`
 * (same length as `state.text`) in sync: every character of a replacement
 * inherits the origin of the first character of the span it replaced.
 * @param {TrackedState} state
 * @param {RegExp} regex
 * @param {string|((match: RegExpExecArray) => string)} replacement
 * @returns {TrackedState}
 */
function trackedReplaceAll(state, regex, replacement) {
  const { text, map } = state;
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);

  let outText = '';
  /** @type {Array<MapEntry|null>} */
  const outMap = [];
  let lastIndex = 0;
  let match;

  re.lastIndex = 0;
  while ((match = re.exec(text))) {
    outText += text.slice(lastIndex, match.index);
    for (let i = lastIndex; i < match.index; i++) outMap.push(map[i]);

    const rep = typeof replacement === 'function' ? replacement(match) : replacement;
    outText += rep;
    const origin = match.index < map.length ? map[match.index] : map[map.length - 1] ?? null;
    for (let i = 0; i < rep.length; i++) outMap.push(origin);

    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) {
      re.lastIndex += 1;
    }
  }
  outText += text.slice(lastIndex);
  for (let i = lastIndex; i < text.length; i++) outMap.push(map[i]);

  return { text: outText, map: outMap };
}

/**
 * @param {TrackedState} state
 * @returns {TrackedState} same content, trimmed, with map sliced to match
 */
function trackedTrim(state) {
  const trimmed = state.text.trim();
  if (!trimmed) return { text: '', map: [] };
  const start = state.text.indexOf(trimmed);
  const safeStart = start === -1 ? 0 : start;
  return { text: trimmed, map: state.map.slice(safeStart, safeStart + trimmed.length) };
}

/**
 * Mirrors shared/text/normalize.js#normalizeForSpeech step-for-step while
 * tracking per-character origins back into `rawMap`. `null` entries (the
 * synthetic block-boundary sentinel -- see buildRawTextAndMap) pass through
 * untouched: none of normalizeForSpeech's regexes match
 * BLOCK_BOUNDARY_SENTINEL (it is a private-use code point, never
 * whitespace/punctuation/symbol), so the real normalizeForSpeech() output
 * and this mirror always agree on where it ends up.
 * @param {string} raw
 * @param {Array<MapEntry|null>} rawMap
 * @returns {TrackedState}
 */
function normalizeWithMap(raw, rawMap) {
  let state = { text: raw, map: rawMap.slice() };

  state = trackedReplaceAll(state, ZERO_WIDTH_RE, '');
  state = trackedReplaceAll(state, BARE_URL_RE, '');
  state = trackedReplaceAll(state, /…/g, '.');
  state = trackedReplaceAll(state, /\.{3,}/g, '.');
  state = trackedReplaceAll(state, /[‒-―−]/g, '-');
  state = trackedReplaceAll(state, /\s+/g, ' ');
  state = trackedTrim(state);
  state = trackedReplaceAll(state, LEADING_PUNCT_RE, '');
  state = trackedReplaceAll(state, TRAILING_PUNCT_RE, '');
  state = trackedTrim(state);

  return state;
}

/**
 * Find each sentence's [start, end) character offset within
 * `normalizedText`, in order. Sentences are expected to appear as
 * contiguous, non-overlapping substrings (splitSentences only trims
 * whitespace at segment edges, it never rewrites interior characters), so a
 * simple forward `indexOf` scan is reliable; a couple of defensive fallbacks
 * handle the rare case where that assumption doesn't quite hold.
 * @param {string} normalizedText
 * @param {string[]} sentences
 * @returns {Array<{start:number, end:number}|null>}
 */
function locateSentenceOffsets(normalizedText, sentences) {
  const offsets = [];
  let cursor = 0;

  for (const sentence of sentences) {
    if (!sentence) {
      offsets.push(null);
      continue;
    }

    let idx = normalizedText.indexOf(sentence, cursor);
    if (idx === -1) idx = normalizedText.indexOf(sentence);

    if (idx === -1) {
      offsets.push(null);
      continue;
    }

    offsets.push({ start: idx, end: idx + sentence.length });
    cursor = idx + sentence.length;
  }

  return offsets;
}

/**
 * @param {Array<MapEntry|null>} map
 * @param {number} index
 * @param {1|-1} direction
 * @returns {MapEntry|null}
 */
function findNearestMapEntry(map, index, direction) {
  if (!map.length) return null;
  let i = Math.min(Math.max(index, 0), map.length - 1);

  let j = i;
  while (j >= 0 && j < map.length) {
    if (map[j]) return map[j];
    j += direction;
  }

  j = i;
  while (j >= 0 && j < map.length) {
    if (map[j]) return map[j];
    j -= direction;
  }

  return null;
}

/**
 * Compute an index-path from `container` down to `node` (array of child
 * indices at each level), so a stale node reference can later be
 * re-resolved by re-walking from a still-connected container.
 * @param {Node} container
 * @param {Node} node
 * @returns {number[]|null}
 */
export function computeNodePath(container, node) {
  /** @type {number[]} */
  const path = [];
  let current = node;

  while (current && current !== container) {
    const parent = current.parentNode;
    if (!parent) return null;
    const idx = Array.prototype.indexOf.call(parent.childNodes, current);
    if (idx === -1) return null;
    path.unshift(idx);
    current = parent;
  }

  return current === container ? path : null;
}

/**
 * Inverse of `computeNodePath`: walk `path` (child indices) down from
 * `container` to find the node it points at "now". Returns null the moment
 * any step is out of range (the tree shape has changed too much).
 * @param {Node} container
 * @param {number[]} path
 * @returns {Node|null}
 */
export function resolveNodeFromPath(container, path) {
  let current = container;
  for (const idx of path) {
    if (!current || !current.childNodes || idx < 0 || idx >= current.childNodes.length) return null;
    current = current.childNodes[idx];
  }
  return current || null;
}

/**
 * @param {Node} container
 * @param {Array<MapEntry|null>} normalizedMap
 * @param {number} start - inclusive start offset in the normalized text
 * @param {number} end - exclusive end offset in the normalized text
 * @returns {object|null} a locator, or null if it can't be built
 */
function buildLocatorFromOffset(container, normalizedMap, start, end) {
  const startEntry = findNearestMapEntry(normalizedMap, start, 1);
  const endEntry = findNearestMapEntry(normalizedMap, Math.max(start, end - 1), -1);
  if (!startEntry || !endEntry) return null;

  const startNode = startEntry.node;
  const endNode = endEntry.node;
  const startOffset = startEntry.offset;
  const endOffset = Math.min(endEntry.offset + 1, (endNode.nodeValue || '').length);

  const startPath = computeNodePath(container, startNode);
  const endPath = computeNodePath(container, endNode);
  if (!startPath || !endPath) return null;

  return {
    startNode,
    startOffset,
    endNode,
    endOffset,
    containerRef: container,
    nodePath: [startPath, endPath],
  };
}

/**
 * Build TTS-ready sentences (via the real, shared normalizeForSpeech +
 * splitSentences) for a single unit container, each paired with an opaque
 * DOM-range locator.
 * @param {Node} container
 * @param {{ shouldDescend?: (el: Element) => boolean }} [options]
 * @returns {Array<{text: string, locator: object|null}>}
 */
export function extractSentencesWithLocators(container, options = {}) {
  if (!container) return [];

  let raw = '';
  let rawMap = [];
  try {
    const built = buildRawTextAndMap(container, options.shouldDescend);
    raw = built.raw;
    rawMap = built.rawMap;
  } catch {
    return [];
  }

  if (!raw || !raw.trim()) return [];

  const realNormalizedText = normalizeForSpeech(raw);
  if (!realNormalizedText) return [];

  let normalizedMap;
  try {
    const mirrored = normalizeWithMap(raw, rawMap);
    if (mirrored.text === realNormalizedText) {
      normalizedMap = mirrored.map;
    } else {
      // Mirror drifted from the real implementation (e.g. normalize.js
      // changed independently). Degrade gracefully: clamp/pad so offsets
      // stay in-bounds rather than throwing or producing garbage anchors.
      normalizedMap = mirrored.map.slice(0, realNormalizedText.length);
      while (normalizedMap.length < realNormalizedText.length) {
        normalizedMap.push(normalizedMap[normalizedMap.length - 1] ?? null);
      }
    }
  } catch {
    normalizedMap = new Array(realNormalizedText.length).fill(null);
  }

  let sentenceStrings = [];
  try {
    sentenceStrings = splitSentences(realNormalizedText);
  } catch {
    sentenceStrings = [];
  }
  if (!sentenceStrings.length) return [];

  const offsets = locateSentenceOffsets(realNormalizedText, sentenceStrings);

  const results = [];
  for (let i = 0; i < sentenceStrings.length; i++) {
    const text = sentenceStrings[i];
    if (!text) continue;

    const offset = offsets[i];
    let locator = null;
    if (offset) {
      try {
        locator = buildLocatorFromOffset(container, normalizedMap, offset.start, offset.end);
      } catch {
        locator = null;
      }
    }

    results.push({ text, locator });
  }

  return results;
}

/**
 * @param {string} s
 * @returns {string}
 */
function normalizeForCompare(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Loose content check, NOT an exact-string check: `range.toString()` is raw
 * DOM text, while `expectedText` went through normalizeForSpeech (URLs
 * stripped, ellipses collapsed, whitespace collapsed, etc.) at extraction
 * time, so the two will rarely match character-for-character even when the
 * range is perfectly correct. This only needs to catch the failure mode
 * `resolveLocatorToRange` re-resolves for: an index-path re-resolution
 * landing on a COMPLETELY DIFFERENT sentence because the tree shape shifted
 * (a sibling inserted/removed) between extraction and highlight time.
 * @param {Range} range
 * @param {string} expectedText
 * @returns {boolean}
 */
function rangeRoughlyMatchesText(range, expectedText) {
  const expected = normalizeForCompare(expectedText);
  if (!expected) return true; // nothing meaningful to compare against
  const actual = normalizeForCompare(range.toString());
  if (!actual) return false;
  const prefixLen = Math.min(20, expected.length);
  const expectedPrefix = expected.slice(0, prefixLen);
  return actual.startsWith(expectedPrefix) || actual.includes(expectedPrefix);
}

/**
 * Freshly locate `text` inside `container`'s CURRENT live DOM (no stale
 * indices/offsets involved at all) -- the fallback for when index-path
 * re-resolution lands on the wrong node. Reuses the same raw-text-map +
 * normalize-with-map pipeline `extractSentencesWithLocators` uses, just for
 * one already-known sentence instead of splitting fresh ones.
 * @param {Node} container
 * @param {string} text
 * @returns {Range|null}
 */
function findRangeByText(container, text) {
  if (!container || !text) return null;

  try {
    const { raw, rawMap } = buildRawTextAndMap(container);
    if (!raw || !raw.trim()) return null;

    const realNormalizedText = normalizeForSpeech(raw);
    if (!realNormalizedText || !realNormalizedText.includes(text)) return null;

    const mirrored = normalizeWithMap(raw, rawMap);
    const normalizedMap =
      mirrored.text === realNormalizedText
        ? mirrored.map
        : (() => {
            const clamped = mirrored.map.slice(0, realNormalizedText.length);
            while (clamped.length < realNormalizedText.length) clamped.push(clamped[clamped.length - 1] ?? null);
            return clamped;
          })();

    const idx = realNormalizedText.indexOf(text);
    const locator = buildLocatorFromOffset(container, normalizedMap, idx, idx + text.length);
    if (!locator) return null;

    const range = locator.startNode.ownerDocument.createRange();
    range.setStart(locator.startNode, Math.max(0, locator.startOffset));
    range.setEnd(locator.endNode, Math.max(0, locator.endOffset));
    return range;
  } catch {
    return null;
  }
}

/**
 * Rebuild a live Range from a locator produced by
 * `extractSentencesWithLocators`. Verifies the recorded nodes are still
 * connected; if not, re-resolves them from the container by index path.
 *
 * That index-path re-resolution is itself fragile: if a framework
 * re-render inserted or removed even one sibling anywhere between the
 * container and the target node, the SAME indices now point at a
 * DIFFERENT node -- silently, with no error, potentially landing on a
 * completely unrelated part of the page.
 *
 * Both paths -- the fast "nodes are still connected" path AND the re-pathed
 * one -- clamp `startOffset`/`endOffset` against the LIVE `node.length`
 * before building the Range, and both run content verification
 * (`rangeRoughlyMatchesText`) plus, on a mismatch, a fresh content-based
 * search (`findRangeByText`) before giving up. Neither used to happen on
 * the fast path: a still-`isConnected` text node whose `nodeValue` a
 * framework (React commonly does this) reassigned in place would build a
 * Range with a now-out-of-bounds offset, which either throws
 * `IndexSizeError` (caught below, degrading to a silently lost highlight)
 * or, worse, that same in-place mutation is exactly what
 * `src/content/ui/highlighter.js`'s `surroundContents` fallback does to
 * every OTHER sentence's stored nodes in a paragraph (via `parent.
 * normalize()` in its `clear()`) while leaving them connected -- so this
 * was never a re-pathed-only failure mode. Returns null if the content is
 * genuinely gone, or if the resulting Range is collapsed (see the
 * `range.collapsed` check below).
 * @param {object|null} locator
 * @param {string} [expectedText] - the sentence's own text, for verifying
 *   the resolved range actually landed on the right content.
 * @returns {Range|null}
 */
export function resolveLocatorToRange(locator, expectedText) {
  if (!locator) return null;

  try {
    let { startNode, startOffset, endNode, endOffset, containerRef, nodePath } = locator;

    const startOk = startNode && startNode.isConnected;
    const endOk = endNode && endNode.isConnected;

    if (!startOk || !endOk) {
      if (!containerRef || !containerRef.isConnected || !Array.isArray(nodePath)) return null;
      const [startPath, endPath] = nodePath;
      const resolvedStart = resolveNodeFromPath(containerRef, startPath);
      const resolvedEnd = resolveNodeFromPath(containerRef, endPath);
      if (!resolvedStart || !resolvedEnd) return null;

      startNode = resolvedStart;
      endNode = resolvedEnd;
    }

    if (!startNode.ownerDocument || startNode.ownerDocument !== endNode.ownerDocument) {
      // Range cannot span two documents (e.g. main doc <-> same-origin
      // iframe doc). Degrade rather than let setEnd throw.
      return null;
    }

    // Clamp against the LIVE node length on every path -- see the doc
    // comment above for why "still isConnected" is not the same guarantee
    // as "offsets still in range".
    const clampedStartOffset = Math.max(0, Math.min(startOffset, (startNode.nodeValue || '').length));
    const clampedEndOffset = Math.max(0, Math.min(endOffset, (endNode.nodeValue || '').length));

    const range = startNode.ownerDocument.createRange();
    range.setStart(startNode, clampedStartOffset);
    range.setEnd(endNode, clampedEndOffset);

    // setEnd() before setStart() never throws when the new end boundary is
    // actually before the current start boundary -- per spec, the Range
    // just collapses to that (wrong) point instead. That happens here if
    // findNearestMapEntry's forward (start) and backward (end) probes
    // crossed -- e.g. every character of this sentence mapped to a `null`
    // rawMap entry (see buildLocatorFromOffset). A collapsed range would
    // highlight nothing, with no error surfacing anywhere, so it must be
    // treated as a resolution failure just like a thrown exception.
    if (range.collapsed) return null;

    // Verify content unconditionally, not only after index-path
    // re-resolution -- see the doc comment above.
    if (expectedText && !rangeRoughlyMatchesText(range, expectedText)) {
      const fallback = containerRef && containerRef.isConnected ? findRangeByText(containerRef, expectedText) : null;
      return fallback || null;
    }

    return range;
  } catch {
    return null;
  }
}

export default {
  extractSentencesWithLocators,
  resolveLocatorToRange,
  computeNodePath,
  resolveNodeFromPath,
  buildRawTextAndMap,
};
