/**
 * backend/routes/meta.js
 *
 * GET /v1/health and GET /v1/voices — shared_contracts §8.
 */

import { Router } from 'express';
import { config, isMockMode } from '../config.js';
import { SUPPORTED_LANGUAGES, CODECS, DEFAULTS } from '../lib/validate.js';

const SERVICE_VERSION = '0.1.0';
const startedAt = Date.now();

const router = Router();

router.get('/health', (req, res) => {
  req.mockFlag = isMockMode();
  res.status(200).json({
    ok: true,
    mock: isMockMode(),
    model: 'bulbul:v3',
    version: SERVICE_VERSION,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    has_api_key: !!config.sarvamApiKey,
  });
});

router.get('/voices', (req, res) => {
  req.mockFlag = isMockMode();
  res.status(200).json({
    speakers: [DEFAULTS.speaker],
    languages: SUPPORTED_LANGUAGES,
    defaults: { ...DEFAULTS },
    codecs: CODECS,
  });
});

export default router;
