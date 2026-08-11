/**
 * backend/lib/validate.js
 *
 * Enforces shared_contracts §8 request validation for /v1/synthesize (and,
 * per-item, for /v1/synthesize/batch): the 2500-char limit, the 11 language
 * codes, the 7 sample rates, the 8 codecs, and the pace/temperature ranges.
 * Throws an AppError (see lib/errors.js) with the exact error code on any
 * violation; otherwise returns a fully-defaulted, normalized params object.
 */

import { ERRORS } from './errors.js';

export const SUPPORTED_LANGUAGES = [
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
];

export const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];

export const CODECS = ['wav', 'mp3', 'linear16', 'mulaw', 'alaw', 'opus', 'flac', 'aac'];

export const DEFAULT_SPEAKER = 'simran';

export const DEFAULTS = Object.freeze({
  language_code: 'en-IN',
  speaker: DEFAULT_SPEAKER,
  pace: 1.0,
  temperature: 0.6,
  speech_sample_rate: 24000,
  output_audio_codec: 'mp3',
});

const MAX_TEXT_CHARS = 2500;
const PACE_MIN = 0.5;
const PACE_MAX = 2.0;
const TEMPERATURE_MIN = 0.01;
const TEMPERATURE_MAX = 2.0;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {object} body raw request JSON (or a batch item merged with `defaults`)
 * @returns {{text:string, language_code:string, speaker:string, pace:number,
 *            temperature:number, speech_sample_rate:number,
 *            output_audio_codec:string, client_request_id:string|null}}
 */
export function validateSynthesizeInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ERRORS.invalidRequest('Request body must be a JSON object');
  }

  const { text } = body;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw ERRORS.invalidRequest('"text" is required and must be a non-empty string');
  }
  const trimmedText = text.trim();
  if (trimmedText.length > MAX_TEXT_CHARS) {
    throw ERRORS.textTooLong(
      `"text" length ${trimmedText.length} exceeds the ${MAX_TEXT_CHARS}-char limit`
    );
  }

  let language_code = DEFAULTS.language_code;
  if (body.language_code !== undefined) {
    if (typeof body.language_code !== 'string' || !SUPPORTED_LANGUAGES.includes(body.language_code)) {
      throw ERRORS.unsupportedLanguage(
        `"language_code" must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`
      );
    }
    language_code = body.language_code;
  }

  let speaker = DEFAULTS.speaker;
  if (body.speaker !== undefined) {
    if (typeof body.speaker !== 'string' || body.speaker.trim().length === 0) {
      throw ERRORS.invalidRequest('"speaker" must be a non-empty string');
    }
    speaker = body.speaker;
  }

  let pace = DEFAULTS.pace;
  if (body.pace !== undefined) {
    if (!isFiniteNumber(body.pace) || body.pace < PACE_MIN || body.pace > PACE_MAX) {
      throw ERRORS.invalidRequest(`"pace" must be a number between ${PACE_MIN} and ${PACE_MAX}`);
    }
    pace = body.pace;
  }

  let temperature = DEFAULTS.temperature;
  if (body.temperature !== undefined) {
    if (
      !isFiniteNumber(body.temperature) ||
      body.temperature < TEMPERATURE_MIN ||
      body.temperature > TEMPERATURE_MAX
    ) {
      throw ERRORS.invalidRequest(
        `"temperature" must be a number between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX}`
      );
    }
    temperature = body.temperature;
  }

  let speech_sample_rate = DEFAULTS.speech_sample_rate;
  if (body.speech_sample_rate !== undefined) {
    if (!SAMPLE_RATES.includes(body.speech_sample_rate)) {
      throw ERRORS.invalidRequest(
        `"speech_sample_rate" must be one of: ${SAMPLE_RATES.join(', ')}`
      );
    }
    speech_sample_rate = body.speech_sample_rate;
  }

  let output_audio_codec = DEFAULTS.output_audio_codec;
  if (body.output_audio_codec !== undefined) {
    if (typeof body.output_audio_codec !== 'string' || !CODECS.includes(body.output_audio_codec)) {
      throw ERRORS.unsupportedCodec(`"output_audio_codec" must be one of: ${CODECS.join(', ')}`);
    }
    output_audio_codec = body.output_audio_codec;
  }

  let client_request_id = null;
  if (body.client_request_id !== undefined) {
    if (typeof body.client_request_id !== 'string') {
      throw ERRORS.invalidRequest('"client_request_id" must be a string');
    }
    client_request_id = body.client_request_id;
  }

  return {
    text: trimmedText,
    language_code,
    speaker,
    pace,
    temperature,
    speech_sample_rate,
    output_audio_codec,
    client_request_id,
  };
}
