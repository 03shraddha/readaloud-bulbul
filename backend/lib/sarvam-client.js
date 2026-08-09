/**
 * backend/lib/sarvam-client.js
 *
 * Thin wrapper around the Sarvam Bulbul v3 TTS endpoint. Exact request
 * shape per shared_contracts §8 — never send pitch/loudness/
 * enable_preprocessing, they are unsupported on v3.
 */

import { config } from '../config.js';
import { ERRORS } from './errors.js';

const UPSTREAM_URL = 'https://api.sarvam.ai/text-to-speech';

/**
 * @param {{text:string, language_code:string, speaker:string, pace:number,
 *          temperature:number, speech_sample_rate:number,
 *          output_audio_codec:string}} params
 * @returns {Promise<{audioBase64:string, requestId:string|null, latencyMs:number}>}
 */
export async function synthesizeUpstream(params) {
  const { text, language_code, speaker, pace, temperature, speech_sample_rate, output_audio_codec } =
    params;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': config.sarvamApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        language_code,
        model: 'bulbul:v3',
        speaker,
        pace,
        temperature,
        speech_sample_rate,
        output_audio_codec,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw ERRORS.upstreamTimeout(`Upstream TTS request exceeded ${config.upstreamTimeoutMs}ms`);
    }
    throw ERRORS.upstreamError(`Upstream request failed: ${err?.message || err}`, null);
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw ERRORS.upstreamAuth('Upstream authentication failed', res.status);
    }
    if (res.status === 429) {
      throw ERRORS.upstreamRateLimit('Upstream rate limit exceeded', res.status);
    }
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // ignore — body may be empty/unreadable
    }
    throw ERRORS.upstreamError(
      `Upstream returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      res.status
    );
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw ERRORS.upstreamError('Upstream response was not valid JSON', res.status);
  }

  const audioBase64 = Array.isArray(json?.audios) ? json.audios[0] : undefined;
  if (!audioBase64) {
    throw ERRORS.upstreamError('Upstream response missing audios[0]', res.status);
  }

  return {
    audioBase64,
    requestId: json.request_id ?? null,
    latencyMs,
  };
}
