/**
 * backend/lib/mock-tts.js
 *
 * Dependency-free MOCK_TTS synthesis: builds a real, decodable 24 kHz mono
 * 16-bit PCM WAV in-process (a quiet 220 Hz sine tone with 10 ms fade
 * in/out) so the whole pipeline can be exercised without an API key.
 * Duration is text-proportional so highlight timing stays realistic.
 */

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const TONE_FREQ_HZ = 220;
const AMPLITUDE = 0.15; // low amplitude: audible but not annoying
const FADE_MS = 10;

const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 30000;
const WORDS_PER_SECOND = 2.6;

let mockRequestCounter = 0;

function countWords(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.length || 1;
}

/** durationMs = clamp(round(wordCount / 2.6 * 1000 / pace), 500, 30000) */
export function computeMockDurationMs(text, pace = 1.0) {
  const safePace = pace > 0 ? pace : 1.0;
  const wordCount = countWords(text);
  const raw = Math.round((wordCount / WORDS_PER_SECOND) * 1000 / safePace);
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, raw));
}

/** Builds a full RIFF/WAVE buffer (44-byte header + PCM data) with no deps. */
function buildWavBuffer(durationMs) {
  const numSamples = Math.max(1, Math.round((durationMs / 1000) * SAMPLE_RATE));
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const dataSize = numSamples * blockAlign;
  const byteRate = SAMPLE_RATE * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  // fmt sub-chunk
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // sub-chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format: 1 = PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data sub-chunk
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.max(1, Math.round((FADE_MS / 1000) * SAMPLE_RATE));
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    let envelope = 1;
    if (i < fadeSamples) {
      envelope = i / fadeSamples;
    } else if (i >= numSamples - fadeSamples) {
      envelope = Math.max(0, (numSamples - i) / fadeSamples);
    }
    const sample = Math.sin(2 * Math.PI * TONE_FREQ_HZ * t) * AMPLITUDE * envelope;
    const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    buffer.writeInt16LE(intSample, 44 + i * blockAlign);
  }

  return buffer;
}

/**
 * @param {{text:string, pace?:number}} params
 * @param {{latencyMs?:number, failRate?:number}} [opts]
 * @returns {Promise<{audioBase64:string, durationMs:number, requestId:string}>}
 */
export async function synthesizeMock({ text, pace = 1.0 }, opts = {}) {
  const latencyMs = opts.latencyMs ?? 250;
  const failRate = opts.failRate ?? 0;

  if (latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  if (failRate > 0 && Math.random() < failRate) {
    throw new Error('Simulated mock TTS failure (MOCK_FAIL_RATE)');
  }

  const durationMs = computeMockDurationMs(text, pace);
  const wavBuffer = buildWavBuffer(durationMs);
  mockRequestCounter += 1;

  return {
    audioBase64: wavBuffer.toString('base64'),
    durationMs,
    requestId: `mock_${mockRequestCounter}`,
  };
}
