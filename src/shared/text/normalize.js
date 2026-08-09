/**
 * src/shared/text/normalize.js
 *
 * normalizeForSpeech(text) per shared_contracts §5:
 *   - collapse whitespace
 *   - strip zero-width chars and emoji-variation selectors
 *   - convert ellipsis "…" -> "."
 *   - normalize dashes
 *   - strip leading/trailing punctuation-only fragments
 *   - drop bare URLs (extractors are expected to replace links with
 *     "link to <domain>" via describeUrl() BEFORE calling this)
 *
 * Foundation-owned; shared by both the article and X extractors.
 */

// Zero-width space/joiner/non-joiner/BOM (U+200B-U+200F, U+202A-U+202E, U+2060, U+FEFF)
// plus variation selectors (U+FE00-U+FE0F, U+E0100-U+E01EF).
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;

const BARE_URL_RE = /\bhttps?:\/\/[^\s]+/gi;

// Leading/trailing runs of punctuation/whitespace only (no letters/digits).
const LEADING_PUNCT_RE = /^[\s\p{P}\p{S}]+/u;
const TRAILING_PUNCT_RE = /[\s\p{P}\p{S}]+$/u;

/**
 * @param {string} href
 * @returns {string} e.g. "link to nytimes.com"
 */
export function describeUrl(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./i, '');
    return `link to ${host}`;
  } catch {
    return 'link to a website';
  }
}

/**
 * Normalize raw extracted text into TTS-ready speech text.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForSpeech(text) {
  if (!text) return '';

  let out = String(text);

  // Strip zero-width / variation-selector characters.
  out = out.replace(ZERO_WIDTH_RE, '');

  // Drop any bare URLs that slipped through (extractors should have already
  // replaced these with describeUrl() output).
  out = out.replace(BARE_URL_RE, '');

  // Normalize ellipsis and dash variants.
  out = out.replace(/…/g, '.'); // … -> .
  out = out.replace(/\.{3,}/g, '.'); // ... -> .
  out = out.replace(/[‒-―−]/g, '-'); // various dashes -> hyphen

  // Collapse all whitespace (including newlines/tabs) to single spaces.
  out = out.replace(/\s+/g, ' ').trim();

  // Strip leading/trailing punctuation-only fragments.
  out = out.replace(LEADING_PUNCT_RE, '').replace(TRAILING_PUNCT_RE, '');

  return out.trim();
}

/**
 * @param {string} text
 * @returns {boolean} true if the fragment has no speakable content
 *   (empty, or punctuation/whitespace only).
 */
export function isPunctuationOnly(text) {
  if (!text) return true;
  return !/[\p{L}\p{N}]/u.test(text);
}
