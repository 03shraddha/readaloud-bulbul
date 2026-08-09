/**
 * backend/routes/synthesize.js
 *
 * POST /v1/synthesize and POST /v1/synthesize/batch — shared_contracts §8.
 */

import { Router } from 'express';
import { validateSynthesizeInput } from '../lib/validate.js';
import { synthesizeUpstream } from '../lib/sarvam-client.js';
import { synthesizeMock } from '../lib/mock-tts.js';
import { config, isMockMode } from '../config.js';
import { AppError, ERRORS, errorBody } from '../lib/errors.js';

const router = Router();

const MAX_BATCH_ITEMS = 5;
const BATCH_CONCURRENCY = 3;

// mime_type mapping per shared_contracts §8. `alaw` has no single agreed-upon
// IANA type; `audio/x-alaw-basic` is the common convention used by browsers
// / media libraries that recognize A-law at all (flagged as an assumption).
const MIME_TYPES = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  linear16: 'audio/L16',
  mulaw: 'audio/basic',
  alaw: 'audio/x-alaw-basic',
  opus: 'audio/ogg;codecs=opus',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

/**
 * Runs synthesis (mock or real) for already-validated params and returns the
 * full success-response shape (plus an internal-only upstreamLatencyMs used
 * for logging, stripped before the field is sent to the client).
 */
async function runSynthesis(params) {
  if (isMockMode()) {
    const startedAt = Date.now();
    let mockResult;
    try {
      mockResult = await synthesizeMock(params, {
        latencyMs: config.mockLatencyMs,
        failRate: config.mockFailRate,
      });
    } catch (err) {
      throw ERRORS.upstreamError(err?.message || 'Simulated mock TTS failure', null);
    }
    return {
      audio_base64: mockResult.audioBase64,
      format: 'wav',
      mime_type: 'audio/wav',
      sample_rate: 24000,
      duration_ms: mockResult.durationMs,
      char_count: params.text.length,
      client_request_id: params.client_request_id ?? null,
      request_id: mockResult.requestId,
      mock: true,
      upstreamLatencyMs: Date.now() - startedAt,
    };
  }

  const upstream = await synthesizeUpstream(params);
  return {
    audio_base64: upstream.audioBase64,
    format: params.output_audio_codec,
    mime_type: MIME_TYPES[params.output_audio_codec] || 'application/octet-stream',
    sample_rate: params.speech_sample_rate,
    duration_ms: null,
    char_count: params.text.length,
    client_request_id: params.client_request_id ?? null,
    request_id: upstream.requestId,
    mock: false,
    upstreamLatencyMs: upstream.latencyMs,
  };
}

router.post('/synthesize', async (req, res) => {
  try {
    const params = validateSynthesizeInput(req.body);
    req.charCount = params.text.length;

    const result = await runSynthesis(params);
    req.upstreamLatencyMs = result.upstreamLatencyMs;
    req.mockFlag = result.mock;

    const { upstreamLatencyMs, ...body } = result;
    res.status(200).json(body);
  } catch (err) {
    const appErr = err instanceof AppError ? err : ERRORS.internal(err?.message || 'Unexpected error');
    req.mockFlag = isMockMode();
    res.status(appErr.status).json(errorBody(appErr));
  }
});

router.post('/synthesize/batch', async (req, res) => {
  const body = req.body;
  req.mockFlag = isMockMode();

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const appErr = ERRORS.invalidRequest('Request body must be a JSON object');
    return res.status(appErr.status).json(errorBody(appErr));
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    const appErr = ERRORS.invalidRequest('"items" must be a non-empty array');
    return res.status(appErr.status).json(errorBody(appErr));
  }
  if (body.items.length > MAX_BATCH_ITEMS) {
    const appErr = ERRORS.invalidRequest(`"items" may contain at most ${MAX_BATCH_ITEMS} entries`);
    return res.status(appErr.status).json(errorBody(appErr));
  }

  const defaults =
    body.defaults && typeof body.defaults === 'object' && !Array.isArray(body.defaults)
      ? body.defaults
      : {};
  const items = body.items;
  const results = new Array(items.length);
  let charCountTotal = 0;

  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      const fallbackId = item && typeof item.id === 'string' && item.id ? item.id : `index:${i}`;
      try {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw ERRORS.invalidRequest('each item must be an object');
        }
        if (typeof item.id !== 'string' || item.id.length === 0) {
          throw ERRORS.invalidRequest('each item requires a non-empty string "id"');
        }
        const merged = { ...defaults, ...item };
        const params = validateSynthesizeInput(merged);
        charCountTotal += params.text.length;

        const result = await runSynthesis(params);
        results[i] = {
          id: item.id,
          audio_base64: result.audio_base64,
          format: result.format,
          mime_type: result.mime_type,
          sample_rate: result.sample_rate,
          duration_ms: result.duration_ms,
          request_id: result.request_id,
          mock: result.mock,
        };
      } catch (err) {
        const appErr = err instanceof AppError ? err : ERRORS.internal(err?.message || 'Unexpected error');
        results[i] = {
          id: fallbackId,
          error: {
            code: appErr.code,
            message: appErr.message,
            retryable: !!appErr.retryable,
          },
        };
      }
    }
  }

  const workerCount = Math.min(BATCH_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  req.charCount = charCountTotal;
  res.status(200).json({ results });
});

export default router;
