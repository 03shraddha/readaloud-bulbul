/**
 * src/shared/logger.js
 *
 * createLogger(scope) -> {debug, info, warn, error}, prefixed
 * '[cadence:scope]'. Silenced unless localStorage 'cadence:debug' is set (in
 * contexts where localStorage exists, e.g. content scripts / options page)
 * or the DEBUG constant below is flipped to true (useful in the background
 * service worker / offscreen document, which have no localStorage tied to a
 * page origin).
 *
 * Gives every task uniform, greppable logging and satisfies the PRD's
 * "fail gracefully, skip/log, not crash" requirement.
 */

/** Flip to true for a build-time-forced debug mode (e.g. during dev). */
const DEBUG = false;

/**
 * @returns {boolean}
 */
function isDebugEnabled() {
  if (DEBUG) return true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('cadence:debug') === '1';
  } catch {
    return false;
  }
}

/**
 * @param {string} scope
 * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
 */
export function createLogger(scope) {
  const prefix = `[cadence:${scope}]`;

  const wrap = (consoleMethod) => (...args) => {
    if (!isDebugEnabled()) return;
    consoleMethod(prefix, ...args);
  };

  return {
    debug: wrap(console.debug ? console.debug.bind(console) : console.log.bind(console)),
    info: wrap(console.info.bind(console)),
    warn: (...args) => console.warn(prefix, ...args), // warnings/errors always surface
    error: (...args) => console.error(prefix, ...args),
  };
}
