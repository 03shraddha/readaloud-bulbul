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

// Extra picks surfaced in the options page's speaker suggestions, on top of
// DEFAULTS.speaker (now simran_en_sales). All bulbul:v4-flash en-IN voices
// from the Best Practices Guide's ranked roster (section 07):
// aparna_en_companion is the previous default (Customer Care & Empathetic
// Support #1 female) kept one click away; shubh_en_recovery brings back a
// Shubh voice (the bulbul:v3 default before the v4-flash migration, now in
// its v4 shape); sunny_en_social is the guide's pick for upbeat, energetic
// delivery (ranked #1 male, EN-IN Sales/Lead Conversion, "social" style).
const EXTRA_SPEAKERS = ['aparna_en_companion', 'shubh_en_recovery', 'sunny_en_social'];

const router = Router();

router.get('/health', (req, res) => {
  req.mockFlag = isMockMode();
  res.status(200).json({
    ok: true,
    mock: isMockMode(),
    model: config.sarvamTtsModel,
    version: SERVICE_VERSION,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    has_api_key: !!config.sarvamApiKey,
  });
});

router.get('/voices', (req, res) => {
  req.mockFlag = isMockMode();
  res.status(200).json({
    speakers: Array.from(new Set([DEFAULTS.speaker, ...EXTRA_SPEAKERS])),
    languages: SUPPORTED_LANGUAGES,
    defaults: { ...DEFAULTS },
    codecs: CODECS,
  });
});

export default router;
