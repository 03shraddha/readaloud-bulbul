/**
 * backend/config.js
 *
 * Zero-dependency .env reader + typed config object. We deliberately do not
 * pull in `dotenv` — express is the only runtime dependency for this service
 * (see shared_contracts §8). Real environment variables (e.g. injected by a
 * process manager or `docker run -e`) always win over anything in .env.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Parses KEY=VALUE lines from `filePath` into process.env (never overwrites
 *  a variable that's already set in the real environment). Silently no-ops
 *  if the file doesn't exist. */
function loadDotEnv(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // no .env file present — fine, rely on the real environment
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) value = value.slice(1, -1);
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '.env'));

function numFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function boolFromEnv(name) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export const config = Object.freeze({
  port: numFromEnv('PORT', 8787),
  sarvamApiKey: process.env.SARVAM_API_KEY || '',
  mockTts: boolFromEnv('MOCK_TTS'),
  mockLatencyMs: numFromEnv('MOCK_LATENCY_MS', 250),
  mockFailRate: numFromEnv('MOCK_FAIL_RATE', 0),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  upstreamTimeoutMs: numFromEnv('UPSTREAM_TIMEOUT_MS', 20000),
});

/** True when the server should never call the real Sarvam API: explicit
 *  MOCK_TTS=1, or no API key at all (auto-enable, with a startup warning
 *  logged by server.js). */
export function isMockMode() {
  return config.mockTts || !config.sarvamApiKey;
}
