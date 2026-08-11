/**
 * backend/server.js
 *
 * Minimal Express server for the TTS proxy (shared_contracts §8). Express is
 * the only runtime dependency. `createServer()` is exported so
 * test/smoke.mjs can boot the app in-process on an ephemeral port; the
 * module also self-starts on `config.port` when run directly
 * (`node backend/server.js`).
 */

import { pathToFileURL } from 'node:url';
import express from 'express';
import { config, isMockMode } from './config.js';
import { corsMiddleware } from './lib/cors.js';
import synthesizeRouter from './routes/synthesize.js';
import metaRouter from './routes/meta.js';

/** One log line per request: method, path, char_count, upstream latency,
 *  status, mock flag. Never logs the API key or the base64 audio. */
function requestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const totalMs = Date.now() - startedAt;
    const fields = [
      req.method,
      req.originalUrl,
      `chars=${req.charCount ?? '-'}`,
      `upstream_ms=${req.upstreamLatencyMs ?? '-'}`,
      `status=${res.statusCode}`,
      `mock=${req.mockFlag ?? '-'}`,
      `total_ms=${totalMs}`,
    ];
    console.log(fields.join(' '));
  });
  next();
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');

  app.use(corsMiddleware(config.allowedOrigins));
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  app.use('/v1', synthesizeRouter);
  app.use('/v1', metaRouter);

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'INVALID_REQUEST',
        message: `Not found: ${req.method} ${req.originalUrl}`,
        retryable: false,
        upstream_status: null,
      },
    });
  });

  // Express 4-arg error handler — catches malformed JSON bodies and anything
  // an individual route handler forgot to try/catch.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Malformed JSON request body',
          retryable: false,
          upstream_status: null,
        },
      });
      return;
    }
    console.error('[boyle-backend] unhandled error:', err?.message || err);
    res.status(500).json({
      error: {
        code: 'INTERNAL',
        message: 'Unexpected server error',
        retryable: true,
        upstream_status: null,
      },
    });
  });

  return app;
}

function logStartupWarnings() {
  if (!config.sarvamApiKey) {
    console.warn('!'.repeat(70));
    console.warn('[boyle-backend] WARNING: SARVAM_API_KEY is not set.');
    console.warn('[boyle-backend] Falling back to MOCK_TTS mode automatically.');
    console.warn('[boyle-backend] Copy backend/.env.example to backend/.env and set');
    console.warn('[boyle-backend] SARVAM_API_KEY to talk to the real Bulbul v3 API.');
    console.warn('!'.repeat(70));
  } else if (config.mockTts) {
    console.log('[boyle-backend] MOCK_TTS=1 — serving mock synthesis, no upstream calls.');
  }
}

// NB: must go through pathToFileURL — `file://` + argv[1] does not percent-encode,
// so any space in the repo path (e.g. ".../Sarvam Work/...") would make this
// comparison silently false and the server would exit 0 without ever listening.
const isMainModule = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  logStartupWarnings();
  const app = createServer();
  app.listen(config.port, () => {
    console.log(
      `[boyle-backend] listening on http://localhost:${config.port} (mock=${isMockMode()})`
    );
  });
}

export default createServer;
