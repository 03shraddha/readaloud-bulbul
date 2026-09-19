#!/usr/bin/env node
/**
 * test/tts-client-speaker-guard.test.mjs
 *
 * Regression test for "reading never plays after switching to
 * bulbul:v4-flash".
 *
 * DEFAULT_SPEAKER moved from a bulbul:v3 bare voice name ('shubh') to a
 * bulbul:v4-flash voice_language_style ID ('aparna_en_edtech'). That code
 * change alone did not fix existing installs: src/shared/storage.js's
 * patchSettings() persists the FULL settings object on every write, not
 * just the changed key. The very first unrelated settings change made
 * under v3 (e.g. adjusting playback rate) captured whatever DEFAULT_SPEAKER
 * was at that moment and wrote it to chrome.storage permanently. That
 * stored value is explicit, so getSettings()'s `{...defaults, ...record}`
 * merge always prefers it over a later code-level DEFAULT_SPEAKER change --
 * upstream rejects it with HTTP 400 ("Speaker 'shubh' is not compatible
 * with model bulbul:v4-flash"), every sentence fails synthesis, and
 * playback never starts, no matter how many times the model/speaker
 * constants are fixed in source.
 *
 * The fix (src/background/tts-client.js's synthesizeOnce()) validates the
 * stored speaker's SHAPE before trusting it: every real bulbul:v4-flash ID
 * is voice_language_style (isValidV4SpeakerId(), src/shared/constants.js).
 * A stored value that doesn't match -- like the bare 'shubh' -- is treated
 * as v3 debris and replaced with DEFAULT_SPEAKER, regardless of what a user
 * or an old settings write left in chrome.storage.
 *
 * Run with: node test/tts-client-speaker-guard.test.mjs
 */

import { isValidV4SpeakerId, DEFAULT_SPEAKER } from '../src/shared/constants.js';

let passCount = 0;
let failCount = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
}

async function check(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name: `${currentGroup} > ${name}`, error: err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. isValidV4SpeakerId() shape detection
// ---------------------------------------------------------------------------

group('1. isValidV4SpeakerId() distinguishes v4 IDs from v3 debris');

const VALID_V4_IDS = [
  'aparna_en_edtech',
  'ritu_hi_customer',
  'ritu_hi_reels',
  'simran_enhi_customer',
  'shubh_en_recovery',
  'ratan_hi_customer_expressive', // style segment itself has an underscore
  'aayan_hi_conversational',
];

for (const id of VALID_V4_IDS) {
  await check(`"${id}" is recognized as a valid v4 speaker ID`, () => {
    assert(isValidV4SpeakerId(id), `expected ${id} to be valid`);
  });
}

const INVALID_IDS = [
  ['shubh', 'the exact bare v3 name that broke live playback'],
  ['anushka', 'another bare v3 voice name'],
  ['', 'empty string'],
  [null, 'null'],
  [undefined, 'undefined'],
  ['default', 'the sentinel meaning "use DEFAULT_SPEAKER"'],
  ['en_customer', 'missing the voice segment'],
  ['aparna_xx_customer', 'an unrecognized language segment'],
];

for (const [id, reason] of INVALID_IDS) {
  await check(`${JSON.stringify(id)} is rejected (${reason})`, () => {
    assert(!isValidV4SpeakerId(id), `expected ${JSON.stringify(id)} to be invalid`);
  });
}

await check('DEFAULT_SPEAKER itself is a valid v4 ID (guards against a future regression)', () => {
  assert(isValidV4SpeakerId(DEFAULT_SPEAKER), `DEFAULT_SPEAKER (${DEFAULT_SPEAKER}) must satisfy its own validator`);
});

// ---------------------------------------------------------------------------
// 2. synthesizeSentence() end-to-end: the stale-storage scenario
// ---------------------------------------------------------------------------

group('2. synthesizeSentence() never forwards a v3-shaped stored speaker');

/** Captures the JSON body of the last fetch() call. */
let lastRequestBody = null;

globalThis.fetch = async (url, opts) => {
  lastRequestBody = JSON.parse(opts.body);
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        audio_base64: 'QUJD',
        mime_type: 'audio/mpeg',
        sample_rate: 24000,
        duration_ms: 500,
        request_id: 'req_test',
        mock: true,
      };
    },
  };
};

const { synthesizeSentence } = await import('../src/background/tts-client.js');

const sentence = { id: 's1', index: 0, text: 'Hello world.', languageCode: 'en-IN' };

await check('a settings object carrying a leftover v3 speaker ("shubh") sends DEFAULT_SPEAKER instead', async () => {
  await synthesizeSentence({
    sentence,
    settings: {
      backendBaseUrl: 'http://localhost:8787',
      speaker: 'shubh', // exactly the value that broke live playback
      pace: 1.0,
      temperature: 0.6,
    },
  });
  assertEqual(lastRequestBody.speaker, DEFAULT_SPEAKER, 'a v3-shaped stored speaker must never reach the backend');
});

await check('a genuinely chosen v4 speaker is forwarded untouched', async () => {
  await synthesizeSentence({
    sentence,
    settings: {
      backendBaseUrl: 'http://localhost:8787',
      speaker: 'ritu_hi_customer',
      pace: 1.0,
      temperature: 0.6,
    },
  });
  assertEqual(lastRequestBody.speaker, 'ritu_hi_customer', 'a valid, deliberately-chosen speaker must not be overridden');
});

await check('no speaker at all falls back to DEFAULT_SPEAKER', async () => {
  await synthesizeSentence({
    sentence,
    settings: {
      backendBaseUrl: 'http://localhost:8787',
      pace: 1.0,
      temperature: 0.6,
    },
  });
  assertEqual(lastRequestBody.speaker, DEFAULT_SPEAKER, 'a missing speaker must fall back to DEFAULT_SPEAKER');
});

await check('the "default" sentinel falls back to DEFAULT_SPEAKER', async () => {
  await synthesizeSentence({
    sentence,
    settings: {
      backendBaseUrl: 'http://localhost:8787',
      speaker: 'default',
      pace: 1.0,
      temperature: 0.6,
    },
  });
  assertEqual(lastRequestBody.speaker, DEFAULT_SPEAKER, 'the "default" sentinel must resolve to DEFAULT_SPEAKER');
});

// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`tts-client-speaker-guard: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);
if (failCount > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.error.stack || f.error.message}`);
  process.exit(1);
}
console.log('Stale-speaker guard holds: a v3 speaker in storage can never reach bulbul:v4-flash.');
