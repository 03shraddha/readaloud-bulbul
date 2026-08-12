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
import { splitSentences } from '../../../shared/text/sentence-splitter.js';
import { walkDOM } from './dom-walk.js';
import { isVisibleTextNode } from './visibility.js';

const DEFAULT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/**
 * @param {Element} el
 * @returns {boolean}
 */
function defaultShouldDescend(el) {
  return !DEFAULT_SKIP_TAGS.has(el.tagName);
}

/**
 * @param {Node} container
 * @param {((el: Element) => boolean)|undefined} customShouldDescend
 * @returns {Text[]}
 */
function collectTextNodes(container, customShouldDescend) {
  const shouldDescend = (el) => {
    if (!defaultShouldDescend(el)) return false;
    return customShouldDescend ? customShouldDescend(el) : true;
  };

  /** @type {Text[]} */
  const nodes = [];
  for (const node of walkDOM(container, { shouldDescend })) {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue && isVisibleTextNode(node)) {
      nodes.push(/** @type {Text} */ (node));
    }
  }
  return nodes;
}

/**
 * @typedef {{node: Text, offset: number}} MapEntry
 */

/**
 * Concatenate visible text nodes in DOM order into one raw string, with a
 * parallel `rawMap` array where `rawMap[i]` is the {node, offset} that
 * produced `raw[i]`. A single space is synthesized between adjacent text
 * nodes when neither side already has boundary whitespace, to avoid
 * mashing words together across inline element boundaries (e.g.
 * "<b>foo</b>bar" vs "<b>foo</b> bar").
 * @param {Node} container
 * @param {((el: Element) => boolean)|undefined} shouldDescend
 * @returns {{raw: string, rawMap: MapEntry[], textNodes: Text[]}}
 */
function buildRawTextAndMap(container, shouldDescend) {
  const textNodes = collectTextNodes(container, shouldDescend);

  let raw = '';
  /** @type {MapEntry[]} */
  const rawMap = [];

  for (let n = 0; n < textNodes.length; n++) {
    const node = textNodes[n];
    const value = node.nodeValue || '';

    if (n > 0 && raw.length && value.length) {
      const prevEndsWithSpace = /\s$/.test(raw);
      const nextStartsWithSpace = /^\s/.test(value);
      if (!prevEndsWithSpace && !nextStartsWithSpace) {
        raw += ' ';
        const prevNode = textNodes[n - 1];
        rawMap.push({ node: prevNode, offset: (prevNode.nodeValue || '').length });
      }
    }

    for (let i = 0; i < value.length; i++) {
      raw += value[i];
      rawMap.push({ node, offset: i });
    }
  }

  return { raw, rawMap, textNodes };
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
 * tracking per-character origins back into `rawMap`.
 * @param {string} raw
 * @param {MapEntry[]} rawMap
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
 * completely unrelated part of the page. When `expectedText` is supplied,
 * the re-resolved range is checked against it and, on a mismatch, a fresh
 * content-based search (`findRangeByText`) is tried before giving up.
 * Returns null if the content is genuinely gone.
 * @param {object|null} locator
 * @param {string} [expectedText] - the sentence's own text, for verifying a
 *   path-based re-resolution actually landed on the right content.
 * @returns {Range|null}
 */
export function resolveLocatorToRange(locator, expectedText) {
  if (!locator) return null;

  try {
    let { startNode, startOffset, endNode, endOffset, containerRef, nodePath } = locator;

    const startOk = startNode && startNode.isConnected;
    const endOk = endNode && endNode.isConnected;
    let rePathed = false;

    if (!startOk || !endOk) {
      if (!containerRef || !containerRef.isConnected || !Array.isArray(nodePath)) return null;
      const [startPath, endPath] = nodePath;
      const resolvedStart = resolveNodeFromPath(containerRef, startPath);
      const resolvedEnd = resolveNodeFromPath(containerRef, endPath);
      if (!resolvedStart || !resolvedEnd) return null;

      startNode = resolvedStart;
      endNode = resolvedEnd;
      startOffset = Math.min(startOffset, (startNode.nodeValue || '').length);
      endOffset = Math.min(endOffset, (endNode.nodeValue || '').length);
      rePathed = true;
    }

    if (!startNode.ownerDocument || startNode.ownerDocument !== endNode.ownerDocument) {
      // Range cannot span two documents (e.g. main doc <-> same-origin
      // iframe doc). Degrade rather than let setEnd throw.
      return null;
    }

    const range = startNode.ownerDocument.createRange();
    range.setStart(startNode, Math.max(0, startOffset));
    range.setEnd(endNode, Math.max(0, endOffset));

    if (rePathed && expectedText && !rangeRoughlyMatchesText(range, expectedText)) {
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
};
