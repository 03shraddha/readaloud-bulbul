/**
 * src/background/tts-client.js
 *
 * Thin HTTP client for the backend TTS API (shared_contracts §8). Pure,
 * session-agnostic: given a sentence + settings + an AbortSignal, returns a
 * decoded synthesis result or throws a classified error.
 *
 * Retry policy (owned here, per shared_contracts §8/§9): retry ONLY when
 * error.retryable === true, max 2 retries, backoff 400ms then 1200ms + jitter.
 * Non-retryable (or retries exhausted) => throw; the caller (prefetch-queue)
 * is responsible for skipping that sentence, toasting, and moving on.
 */

import { SYNTH_PATH, DEFAULT_SPEAKER } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('background:tts-client');

/** Backoff schedule, ms, before retry #1 and retry #2 respectively. */
const RETRY_DELAYS_MS = [400, 1200];
const MAX_RETRIES = 2;
const JITTER_MAX_MS = 200;

/**
 * @param {number} ms
 * @returns {number}
 */
function withJitter(ms) {
  return ms + Math.floor(Math.random() * JITTER_MAX_MS);
}

/**
 * @returns {Error & {code:string, retryable:boolean, aborted:boolean}}
 */
function makeAbortError() {
  const err = new Error('Synthesis request aborted');
  err.code = 'ABORTED';
  err.retryable = false;
  err.aborted = true;
  return err;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {boolean} retryable
 * @returns {Error & {code:string, retryable:boolean}}
 */
function makeClassifiedError(code, message, retryable) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

/**
 * Sleep that rejects early (with an ABORTED error) if the signal fires while
 * waiting out a backoff delay.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(makeAbortError());
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(makeAbortError());
      },
      { once: true }
    );
  });
}

/**
 * POST {backendBaseUrl}{SYNTH_PATH} once. Throws a classified error on any
 * non-2xx / network / parse failure; never returns a partial result.
 * @param {object} params
 * @param {import('../shared/types.js').Sentence} params.sentence
 * @param {object} params.settings - needs backendBaseUrl, speaker, pace, temperature; languageCode falls back to sentence.languageCode
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{audioBase64:string, mimeType:string, sampleRate:number, durationMs:number|null, requestId:string, mock:boolean}>}
 */
async function synthesizeOnce({ sentence, settings, signal }) {
  const baseUrl = settings?.backendBaseUrl;
  const url = `${baseUrl}${SYNTH_PATH}`;

  // Fallback to DEFAULT_SPEAKER if speaker is invalid/missing
  const speaker = (settings?.speaker && settings.speaker !== 'default' && settings.speaker.trim())
    ? settings.speaker.trim()
    : DEFAULT_SPEAKER;

  const body = {
    text: sentence.text,
    language_code: sentence.languageCode || settings?.languageCode,
    speaker,
    pace: settings?.pace,
    temperature: settings?.temperature,
    speech_sample_rate: 24000,
    output_audio_codec: 'mp3',
    client_request_id: sentence.id,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw makeAbortError();
    // Network-level failure (DNS, connection refused, offline, etc). Treat as
    // retryable — the backend may just be starting up.
    throw makeClassifiedError('NETWORK', err?.message || 'Network error contacting backend', true);
  }

  let json = null;
  try {
    json = await response.json();
  } catch (err) {
    throw makeClassifiedError('INTERNAL', 'Backend response was not valid JSON', true);
  }

  if (!response.ok) {
    const info = json?.error || {};
    throw makeClassifiedError(
      info.code || 'INTERNAL',
      info.message || `Backend returned HTTP ${response.status}`,
      typeof info.retryable === 'boolean' ? info.retryable : response.status >= 500
    );
  }

  return {
    audioBase64: json.audio_base64,
    mimeType: json.mime_type,
    sampleRate: json.sample_rate,
    durationMs: typeof json.duration_ms === 'number' ? json.duration_ms : null,
    requestId: json.request_id,
    mock: !!json.mock,
  };
}

/**
 * Synthesize one sentence, retrying per policy above. Rejects with a
 * classified error (Error & {code, retryable, aborted?}) if all attempts
 * fail or the signal aborts.
 * @param {object} params
 * @param {import('../shared/types.js').Sentence} params.sentence
 * @param {object} params.settings
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{audioBase64:string, mimeType:string, sampleRate:number, durationMs:number|null, requestId:string, mock:boolean}>}
 */
export async function synthesizeSentence({ sentence, settings, signal }) {
  let attempt = 0;

  for (;;) {
    if (signal?.aborted) throw makeAbortError();

    try {
      return await synthesizeOnce({ sentence, settings, signal });
    } catch (err) {
      if (err?.aborted || signal?.aborted) throw makeAbortError();

      const retryable = !!err.retryable;
      if (!retryable || attempt >= MAX_RETRIES) {
        log.warn(`giving up on sentence ${sentence.id} after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`, err.message);
        throw err;
      }

      const backoff = withJitter(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
      attempt += 1;
      log.debug(`retrying sentence ${sentence.id}, attempt ${attempt} in ${backoff}ms (${err.code})`);
      await delay(backoff, signal);
    }
  }
}
