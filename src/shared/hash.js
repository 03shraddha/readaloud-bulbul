/**
 * src/shared/hash.js
 *
 * FNV-1a 32-bit hashing (NOT crypto.subtle — that API is undefined on
 * plain-http pages / non-secure contexts). Synchronous, dependency-free.
 * See shared_contracts §6.
 */

/**
 * FNV-1a 32-bit hash of a string, returned as an 8-char lowercase hex string.
 * @param {string} str
 * @returns {string}
 */
export function fnv1a32(str) {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // hash *= 16777619 (FNV prime), done with shifts to stay in int32 land
    hash =
      (hash +
        ((hash << 1) >>> 0) +
        ((hash << 4) >>> 0) +
        ((hash << 7) >>> 0) +
        ((hash << 8) >>> 0) +
        ((hash << 24) >>> 0)) >>>
      0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const STRIPPABLE_PARAM_RE = /^(utm_|fb|gc|mc_|ref|ref_src|s|t|si|igshid|cmpid|spm)/i;

/**
 * Normalize a URL for stable content-key hashing:
 * lowercase host, strip hash, strip trailing slash, remove tracking params,
 * sort remaining params.
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  // Strip a single trailing slash from the path (but keep a bare "/" as-is
  // so the origin doesn't end up with an empty pathname).
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  const keptParams = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!STRIPPABLE_PARAM_RE.test(key)) {
      keptParams.push([key, value]);
    }
  }
  keptParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  parsed.search = '';
  for (const [key, value] of keptParams) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}

/**
 * Content hash for the article content-key. Editing/reflowing an article
 * yields a new hash instead of a wrong resume.
 * @param {Array<{text:string}>} sentences
 * @returns {string}
 */
export function contentHashFromSentences(sentences) {
  const joined = sentences.map((s) => s.text.slice(0, 64)).join('');
  return fnv1a32(`${joined}|${sentences.length}`);
}
