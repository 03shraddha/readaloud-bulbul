/**
 * backend/lib/errors.js
 *
 * The single error shape used across every endpoint (shared_contracts §8):
 *   { error: { code, message, retryable, upstream_status } }
 */

export class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: number, retryable?: boolean, upstreamStatus?: number|null}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? 500;
    this.retryable = opts.retryable ?? false;
    this.upstreamStatus = opts.upstreamStatus ?? null;
  }
}

/** @param {AppError|Error} err */
export function errorBody(err) {
  const isApp = err instanceof AppError;
  return {
    error: {
      code: isApp ? err.code : 'INTERNAL',
      message: err && err.message ? err.message : 'Internal error',
      retryable: isApp ? !!err.retryable : true,
      upstream_status: isApp ? err.upstreamStatus ?? null : null,
    },
  };
}

export const ERRORS = {
  invalidRequest: (message) =>
    new AppError('INVALID_REQUEST', message, { status: 400, retryable: false }),
  textTooLong: (message) =>
    new AppError('TEXT_TOO_LONG', message, { status: 400, retryable: false }),
  unsupportedLanguage: (message) =>
    new AppError('UNSUPPORTED_LANGUAGE', message, { status: 400, retryable: false }),
  unsupportedCodec: (message) =>
    new AppError('UNSUPPORTED_CODEC', message, { status: 400, retryable: false }),
  upstreamAuth: (message, upstreamStatus = null) =>
    new AppError('UPSTREAM_AUTH', message, { status: 502, retryable: false, upstreamStatus }),
  upstreamRateLimit: (message, upstreamStatus = null) =>
    new AppError('UPSTREAM_RATE_LIMIT', message, { status: 429, retryable: true, upstreamStatus }),
  upstreamTimeout: (message) =>
    new AppError('UPSTREAM_TIMEOUT', message, { status: 504, retryable: true }),
  upstreamError: (message, upstreamStatus = null) =>
    new AppError('UPSTREAM_ERROR', message, { status: 502, retryable: true, upstreamStatus }),
  internal: (message) => new AppError('INTERNAL', message, { status: 500, retryable: true }),
};
