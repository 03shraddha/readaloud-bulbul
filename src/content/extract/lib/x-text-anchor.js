/**
 * src/content/extract/lib/x-text-anchor.js
 *
 * Finds the live Range that a tweet sentence's `textFingerprint` refers to.
 *
 * THE BUG THIS FIXES: `x-thread-grouper.js` builds each sentence's fingerprint
 * from `normalizeForSpeech(buildTextFromNode(tweetTextEl))` -- a pipeline
 * that collapses line breaks to single spaces, replaces `<a href>` with
 * "link to <domain>", replaces inline emoji `<img alt>` with the alt glyph,
 * and rewrites "…"/dashes. A highlight-time search that instead walks the
 * live DOM with a plain `SHOW_TEXT` TreeWalker (raw `textContent`, no link/
 * emoji substitution, no normalization) is searching for normalized text
 * inside un-normalized text -- `indexOf` returns -1 for almost every
 * tweet that has a line break, a link, an emoji, an ellipsis, or a dash.
 * That miss makes resolveAnchor() return null, which in turn makes
 * ensureVisible() fall back to scrolling the whole tweet card into view --
 * on a card taller than the viewport, that re-scrolls the page on every
 * single sentence (the reported "keeps scrolling while reading one tweet"
 * bug).
 *
 * THE FIX: rebuild the live-DOM search text with the SAME two-stage pipeline
 * (link/emoji substitution, then whitespace/punctuation normalization),
 * while recording a per-character origin map back to `(Text node, offset)`,
 * so the matched span can still be turned into a real Range. This is the
 * same technique `lib/range-mapper.js` uses for the generic article
 * extractor (`buildRawTextAndMap` + `normalizeWithMap`) -- but that module
 * has no `<a>`/`<img alt>` handling (nothing on a generic page needs it), so
 * it can't be reused verbatim here. The walk below instead mirrors
 * `x-tweet-parser.js#buildTextFromNode`'s PRIMARY strategy (the direct
 * recursive traversal with explicit link/emoji rules) -- not that
 * function's two DOM-quirk fallback strategies (a textContent safety net,
 * a TreeWalker catch-all), which exist purely for extraction-time
 * robustness against unusual layouts. Skipping them here only means a
 * highlight can fail to resolve in those rare fallback-triggering cases,
 * which degrades to the SAME "no precise range -> widget text-preview
 * fallback" behavior every other miss in this module already has -- not a
 * regression from the totally-broken state before this fix.
 *
 * A link's/emoji's substituted characters have no real originating text
 * node (the text came from an `href`/`alt` attribute, not a DOM Text node),
 * so they get a `null` map entry -- there is nowhere real to point a Range
 * boundary inside a link/emoji span. `findNearestMapEntry` (mirrored from
 * range-mapper.js, reimplemented locally per this task's file-ownership
 * split) then walks outward from a null run to the nearest REAL character,
 * which is exactly right for the common case: a sentence boundary almost
 * never falls in the middle of a "link to nytimes.com" phrase or a single
 * emoji glyph, so the vast majority of the time the boundary search never
 * even touches a null entry.
 */

// Only describeUrl is actually called here; normalizeForSpeech itself is
// NOT reused (see header) -- normalizeWithMap() below mirrors its regexes
// instead, since normalizeForSpeech has no way to carry a per-character
// origin map through its replacements.
import { describeUrl } from '../../../shared/text/normalize.js';

// Mirrored, in exact lockstep, from shared/text/normalize.js's
// normalizeForSpeech() regex list -- see that file's header. If those
// regexes/order ever change, this must change with them.
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;
const BARE_URL_RE = /\bhttps?:\/\/[^\s]+/gi;
const LEADING_PUNCT_RE = /^[\s\p{P}\p{S}]+/u;
const TRAILING_PUNCT_RE = /[\s\p{P}\p{S}]+$/u;

/**
 * @typedef {{node: Text, offset: number}} MapEntry
 */

/**
 * Recursively walks `node`'s child nodes, mirroring
 * `x-tweet-parser.js#buildTextFromNode`'s primary (non-fallback) strategy:
 * a real text node's characters pass through untouched; a hashtag/mention
 * `<a>` keeps its own visible text; any other `<a href>` is replaced with
 * `describeUrl()`'s output; an `<img alt>` that reads as an inline emoji
 * (short, no whitespace) contributes its alt glyph. Every character pushed
 * onto `text` gets a matching entry in `map` -- a real `{node, offset}` for
 * a character that came from an actual Text node, or `null` for a
 * synthetic character (link description, emoji alt) that has no DOM
 * position of its own.
 * @param {Element} node
 * @returns {{text: string, map: Array<MapEntry|null>}}
 */
function buildTrackedRawText(node) {
  let text = '';
  /** @type {Array<MapEntry|null>} */
  const map = [];

  const pushSynthetic = (str) => {
    for (let i = 0; i < str.length; i++) {
      text += str[i];
      map.push(null);
    }
  };

  function walk(container) {
    for (const child of container.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.nodeValue || '';
        for (let i = 0; i < value.length; i++) {
          text += value[i];
          map.push({ node: child, offset: i });
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName;
        if (tag === 'A') {
          const href = child.getAttribute('href') || '';
          const label = (child.textContent || '').trim();
          const isHashtagOrMention = label.startsWith('#') || label.startsWith('@') || href.startsWith('/');
          if (isHashtagOrMention) {
            // Real visible text (not attribute-derived) -- recurse so its
            // own characters get tracked like any other styled inline
            // element. buildTextFromNode uses `label` (a single `.trim()`
            // of the whole anchor's textContent) instead; this only
            // differs from that when the anchor's own text has interior
            // leading/trailing whitespace around nested elements, which
            // real hashtag/mention markup never does in practice.
            walk(child);
          } else {
            pushSynthetic(` ${describeUrl(href)} `);
          }
        } else if (tag === 'IMG') {
          const alt = child.getAttribute('alt');
          // Same condition as buildTextFromNode: a genuine inline emoji
          // glyph is short and has no whitespace; a real image description
          // is a sentence and is dropped, same as at extraction time.
          if (alt && !/\s/.test(alt) && alt.length <= 16) {
            pushSynthetic(alt);
          }
        } else {
          walk(child);
        }
      }
    }
  }

  walk(node);

  // Mirror buildTextFromNode's own outer `.trim()` on the primary-strategy
  // text so the two pipelines agree on where the content starts/ends.
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;

  return { text: text.slice(start, end), map: map.slice(start, end) };
}

/**
 * @typedef {{text: string, map: Array<MapEntry|null>}} TrackedState
 */

/**
 * Apply `regex` (global) to `state.text`, replacing each match with
 * `replacement`, while keeping `state.map` in lockstep: every character of
 * a replacement inherits the origin of the first character of the span it
 * replaced (a null origin stays null). Local reimplementation of
 * range-mapper.js's helper of the same name -- see this file's header for
 * why that module isn't imported/edited directly.
 * @param {TrackedState} state
 * @param {RegExp} regex
 * @param {string} replacement
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

    outText += replacement;
    const origin = match.index < map.length ? map[match.index] : (map[map.length - 1] ?? null);
    for (let i = 0; i < replacement.length; i++) outMap.push(origin);

    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex += 1; // never infinite-loop on a zero-width match
  }
  outText += text.slice(lastIndex);
  for (let i = lastIndex; i < text.length; i++) outMap.push(map[i]);

  return { text: outText, map: outMap };
}

/**
 * @param {TrackedState} state
 * @returns {TrackedState}
 */
function trackedTrim(state) {
  const trimmed = state.text.trim();
  if (!trimmed) return { text: '', map: [] };
  let start = 0;
  while (/\s/.test(state.text[start])) start++;
  return { text: trimmed, map: state.map.slice(start, start + trimmed.length) };
}

/**
 * Mirrors shared/text/normalize.js#normalizeForSpeech step-for-step (same
 * regexes, same order) while tracking per-character origins through
 * `rawMap`. The real `normalizeForSpeech` is still what the ACTUAL sentence
 * text was built with (at extraction time, on `buildTextFromNode`'s
 * output) -- this mirror only has to reproduce the same transform on the
 * live-DOM tracked text closely enough that the fingerprint substring can
 * be found in it.
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
 * Every index where `needle` occurs in `haystack`, in order, non-overlapping.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number[]}
 */
function findAllOccurrences(haystack, needle) {
  if (!needle) return [];
  const positions = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + Math.max(needle.length, 1);
  }
  return positions;
}

/**
 * Nearest non-null map entry to `index`, preferring `direction` first (same
 * search shape as range-mapper.js's helper of the same name, reimplemented
 * locally). Also returns the entry's own index in `map`, so the caller can
 * tell whether a start probe and an end probe crossed.
 * @param {Array<MapEntry|null>} map
 * @param {number} index
 * @param {1|-1} direction
 * @returns {{entry: MapEntry, mapIndex: number}|null}
 */
function findNearestMapEntry(map, index, direction) {
  if (!map.length) return null;
  const i = Math.min(Math.max(index, 0), map.length - 1);

  let j = i;
  while (j >= 0 && j < map.length) {
    if (map[j]) return { entry: map[j], mapIndex: j };
    j += direction;
  }
  j = i;
  while (j >= 0 && j < map.length) {
    if (map[j]) return { entry: map[j], mapIndex: j };
    j -= direction;
  }
  return null;
}

/**
 * Finds the Range for one sentence's fingerprint inside `containerEl`'s
 * CURRENT live DOM. Walks fresh every call -- never a stored node/range,
 * since virtualized timelines recycle/unmount nodes constantly.
 * @param {Element|null} containerEl
 * @param {string} fingerprint - the sentence's normalized text (locator.textFingerprint)
 * @param {{ordinal?: number}} [opts]
 *   `ordinal` - the sentence's `locator.sentenceOrdinal`. When the same
 *   fingerprint text occurs more than once in `containerEl` (a repeated
 *   sentence), the ordinal-th occurrence is preferred; if fewer occurrences
 *   exist than the ordinal implies, the first occurrence is used instead of
 *   failing outright.
 * @returns {Range|null}
 */
export function findRangeForSentence(containerEl, fingerprint, opts = {}) {
  if (!containerEl || typeof fingerprint !== 'string') return null;
  const needle = fingerprint.trim();
  if (!needle) return null;
  if (typeof containerEl.childNodes === 'undefined') return null;

  let raw = '';
  /** @type {Array<MapEntry|null>} */
  let rawMap = [];
  try {
    const built = buildTrackedRawText(containerEl);
    raw = built.text;
    rawMap = built.map;
  } catch {
    return null;
  }
  if (!raw) return null;

  let normText = '';
  /** @type {Array<MapEntry|null>} */
  let normMap = [];
  try {
    const normalized = normalizeWithMap(raw, rawMap);
    normText = normalized.text;
    normMap = normalized.map;
  } catch {
    return null;
  }
  if (!normText) return null;

  const positions = findAllOccurrences(normText, needle);
  if (!positions.length) return null;

  const ordinal = Number.isInteger(opts.ordinal) && opts.ordinal >= 0 ? opts.ordinal : 0;
  const start = ordinal < positions.length ? positions[ordinal] : positions[0];
  const end = start + needle.length;

  const startFound = findNearestMapEntry(normMap, start, 1);
  const endFound = findNearestMapEntry(normMap, Math.max(start, end - 1), -1);
  if (!startFound || !endFound) return null;
  // The end probe landed BEFORE the start probe (can happen when a long
  // run of null/synthetic entries separates them) -- refuse to build a
  // range that would come out backwards or zero-width.
  if (startFound.mapIndex > endFound.mapIndex) return null;

  const startNode = startFound.entry.node;
  const endNode = endFound.entry.node;
  const startLen = (startNode.nodeValue || '').length;
  const endLen = (endNode.nodeValue || '').length;
  const startOffset = Math.max(0, Math.min(startFound.entry.offset, startLen));
  const endOffset = Math.max(0, Math.min(endFound.entry.offset + 1, endLen));

  try {
    const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createRange !== 'function') return null;
    const range = doc.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    if (range.collapsed) return null; // crossed probes -> no zero-width highlight
    return range;
  } catch {
    return null;
  }
}

export default { findRangeForSentence };
