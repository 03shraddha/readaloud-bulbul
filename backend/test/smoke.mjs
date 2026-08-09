#!/usr/bin/env node
/**
 * backend/test/smoke.mjs
 *
 * Boots the server in-process, in mock mode, on an ephemeral port, and
 * asserts:
 *   - GET  /v1/health returns ok:true, mock:true
 *   - POST /v1/synthesize succeeds and audio_base64 decodes to a valid
 *     RIFF/WAVE header
 *   - POST /v1/synthesize/batch with one oversized item yields a per-item
 *     TEXT_TOO_LONG error alongside a successful sibling, HTTP 200 overall
 *   - POST /v1/synthesize with an unsupported language_code returns 400
 *     UNSUPPORTED_LANGUAGE
 *
 * Env vars are set *before* the dynamic import of server.js/config.js,
 * since config.js reads process.env once at module-load time.
 */

process.env.MOCK_TTS = '1';
process.env.MOCK_LATENCY_MS = '0';
process.env.MOCK_FAIL_RATE = '0';

const assert = await import('node:assert/strict').then((m) => m.default);
const { createServer } = await import('../server.js');

const app = createServer();

const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, () => resolve(s));
  s.on('error', reject);
});

const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function isRiffWave(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

async function testHealth() {
  const res = await fetch(`${base}/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mock, true);
  assert.equal(body.model, 'bulbul:v3');
  console.log('[smoke] GET /v1/health OK');
}

async function testSynthesizeSuccess() {
  const res = await fetch(`${base}/v1/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello world, this is a smoke test sentence.' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mock, true);
  assert.equal(body.format, 'wav');
  assert.equal(body.mime_type, 'audio/wav');
  assert.equal(typeof body.audio_base64, 'string');
  assert.ok(body.audio_base64.length > 0);
  assert.ok(typeof body.duration_ms === 'number' && body.duration_ms > 0);

  const wavBuffer = Buffer.from(body.audio_base64, 'base64');
  assert.ok(isRiffWave(wavBuffer), 'audio_base64 must decode to a valid RIFF/WAVE header');
  console.log(`[smoke] POST /v1/synthesize OK (duration_ms=${body.duration_ms})`);
}

async function testBatchPartialFailure() {
  const oversized = 'a'.repeat(2600);
  const res = await fetch(`${base}/v1/synthesize/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        { id: 'ok-1', text: 'A short sentence that should synthesize fine.' },
        { id: 'too-long', text: oversized },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 2);

  const ok = body.results.find((r) => r.id === 'ok-1');
  assert.ok(ok && typeof ok.audio_base64 === 'string' && ok.audio_base64.length > 0);

  const failed = body.results.find((r) => r.id === 'too-long');
  assert.ok(failed && failed.error);
  assert.equal(failed.error.code, 'TEXT_TOO_LONG');
  console.log('[smoke] POST /v1/synthesize/batch partial failure OK');
}

async function testUnsupportedLanguage() {
  const res = await fetch(`${base}/v1/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello', language_code: 'xx-XX' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'UNSUPPORTED_LANGUAGE');
  console.log('[smoke] unsupported language_code -> 400 UNSUPPORTED_LANGUAGE OK');
}

async function main() {
  await testHealth();
  await testSynthesizeSuccess();
  await testBatchPartialFailure();
  await testUnsupportedLanguage();
  console.log('[smoke] ALL PASSED');
}

try {
  await main();
  server.close();
  process.exitCode = 0;
} catch (err) {
  console.error('[smoke] FAILED:', err);
  server.close();
  process.exitCode = 1;
}
