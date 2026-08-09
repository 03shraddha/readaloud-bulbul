/**
 * src/shared/keys.js
 *
 * contentKey builders and chrome.storage.local key builders per
 * shared_contracts §6 and §7.
 */

import { fnv1a32, normalizeUrl } from './hash.js';

/**
 * Build the content key for an article.
 * @param {string} url
 * @param {string} contentHash
 * @returns {string}
 */
export function articleContentKey(url, contentHash) {
  return `article:${fnv1a32(normalizeUrl(url))}:${contentHash}`;
}

/**
 * Derive the X/Twitter context id from a Location-like object's pathname
 * (+ search, for the search case). See shared_contracts §6.
 * @param {{pathname: string, search?: string}} location
 * @returns {string}
 */
export function twitterContextId(location) {
  const pathname = location.pathname || '/';
  const search = location.search || '';

  if (pathname === '/home' || pathname === '/home/') {
    return 'home';
  }

  // /i/status/<id> or /<user>/status/<id>
  const statusMatch = pathname.match(/^\/(?:i|[^/]+)\/status\/(\d+)/);
  if (statusMatch) {
    return `status:${statusMatch[1]}`;
  }

  // /i/lists/<id>
  const listMatch = pathname.match(/^\/i\/lists\/(\w+)/);
  if (listMatch) {
    return `list:${listMatch[1]}`;
  }

  // /search?q=..
  if (pathname === '/search') {
    const q = new URLSearchParams(search).get('q') || '';
    return `search:${fnv1a32(q)}`;
  }

  // /<user> (profile) — single path segment, no further slashes
  const profileMatch = pathname.match(/^\/([^/]+)\/?$/);
  if (profileMatch && profileMatch[1]) {
    return `profile:${profileMatch[1].toLowerCase()}`;
  }

  return `other:${fnv1a32(pathname)}`;
}

/**
 * Build the content key for an X/Twitter location.
 * @param {{pathname: string, search?: string}} location
 * @returns {string}
 */
export function twitterContentKey(location) {
  return `x:${twitterContextId(location)}`;
}

/**
 * @param {string} contentKey
 * @returns {string}
 */
export function progressKey(contentKey) {
  return `ra.progress.${contentKey}`;
}

export const SETTINGS_KEY = 'ra.settings';
export const PROGRESS_INDEX_KEY = 'ra.progressIndex';
export const SESSION_KEY = 'ra.session';
