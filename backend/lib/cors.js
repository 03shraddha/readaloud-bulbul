/**
 * backend/lib/cors.js
 *
 * shared_contracts §8: echo `Access-Control-Allow-Origin` for origins
 * matching /^chrome-extension:\/\// plus the ALLOWED_ORIGINS env (comma
 * list); allow header `content-type`; methods GET,POST,OPTIONS.
 */

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\//;

/**
 * @param {string[]} allowedOrigins extra exact-match origins (ALLOWED_ORIGINS)
 * @returns {import('express').RequestHandler}
 */
export function corsMiddleware(allowedOrigins = []) {
  const extra = new Set(allowedOrigins);

  return function cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && (EXTENSION_ORIGIN_RE.test(origin) || extra.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}
