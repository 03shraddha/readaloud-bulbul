/**
 * src/content/extract/registry.js
 *
 * Host -> extractor routing table (shared_contracts §1). Foundation-owned
 * so neither extractor task has to edit a shared file.
 *
 * Declares the X/Twitter module as the special case and the article module
 * as the universal fallback. Dynamic-imports the winner via
 * chrome.runtime.getURL, validates it exposes the Extractor interface, and
 * degrades to the article extractor if the X module throws (or is missing —
 * safe to load before that task lands its file).
 */

import { createLogger } from '../../shared/logger.js';

const log = createLogger('content:registry');

/**
 * Ordered routing table. First `test` match wins; 'article' is the
 * catch-all fallback and MUST stay last.
 * @type {Array<{ id: string, test: RegExp|null, module: string }>}
 */
export const REGISTRY = [
  {
    id: 'twitter',
    test: /(^|\.)(x|twitter)\.com$/i,
    module: 'src/content/extract/twitter.js',
  },
  {
    id: 'article',
    test: null, // fallback: always matches
    module: 'src/content/extract/article.js',
  },
];

/**
 * @param {import('../../shared/types.js').Extractor} mod
 * @returns {boolean}
 */
function isValidExtractor(mod) {
  return (
    !!mod &&
    typeof mod.id === 'string' &&
    typeof mod.matches === 'function' &&
    typeof mod.init === 'function' &&
    typeof mod.extract === 'function' &&
    typeof mod.extractMore === 'function' &&
    typeof mod.resolveAnchor === 'function' &&
    typeof mod.ensureVisible === 'function' &&
    typeof mod.dispose === 'function'
  );
}

/**
 * @param {string} modulePath - path relative to the extension root
 * @returns {Promise<import('../../shared/types.js').Extractor|null>}
 */
async function loadExtractorModule(modulePath) {
  try {
    const url = chrome.runtime.getURL(modulePath);
    const mod = await import(url);
    const extractor = mod.default ?? mod;
    if (!isValidExtractor(extractor)) {
      log.error(`module at ${modulePath} does not implement the Extractor interface`);
      return null;
    }
    return extractor;
  } catch (err) {
    log.error(`failed to load extractor module ${modulePath}`, err);
    return null;
  }
}

/**
 * Pick and load the extractor for the given location, falling back to the
 * article extractor if the preferred module fails to load/validate.
 * @param {Location} location
 * @returns {Promise<import('../../shared/types.js').Extractor|null>}
 */
export async function getResolvedExtractor(location) {
  const host = location.host || '';

  for (const entry of REGISTRY) {
    const matchesHost = entry.test ? entry.test.test(host) : true;
    if (!matchesHost) continue;

    const extractor = await loadExtractorModule(entry.module);
    if (extractor) return extractor;

    if (entry.id !== 'article') {
      log.warn(`${entry.id} extractor unavailable, degrading to article fallback`);
      continue; // fall through to the next (article) entry
    }
  }

  return null;
}
