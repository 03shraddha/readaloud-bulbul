#!/usr/bin/env node
/**
 * test/offscreen-teardown-recovery.test.mjs
 *
 * Regression test for "press Play after a pause and nothing ever plays
 * again".
 *
 * Chrome closes an offscreen document created with the AUDIO_PLAYBACK reason
 * after roughly 30 seconds without audio actually playing, and it does so
 * silently -- there is no event an extension can listen for. Pausing for
 * longer than that destroys the document. offscreen-manager then recreates it
 * transparently on the next ensureOffscreenReady() and re-sends
 * OFFSCREEN_INIT, which resets the AudioQueue: the replacement queue holds
 * nothing.
 *
 * Before the fix, every sentence background had already handed over was
 * stranded in PrefetchQueue.dispatched -- an array that only drains on
 * SENTENCE_ENDED, which can never arrive for audio that no longer exists.
 * queuedAhead stayed pinned at PREFETCH_AHEAD, fill() refused to fetch
 * anything more, and AUDIO_PLAY just set wantsPlay on an empty queue. The
 * session sat silent forever with no error surfaced anywhere.
 *
 * The harness is the same dependency-free inline pattern as
 * test/harness/session-recovery-check.mjs: a minimal chrome.* stub plus a
 * fetch stub standing in for the backend, with session.js dynamically
 * imported afterwards (static imports would hoist above the stub).
 *
 * Run with: node test/offscreen-teardown-recovery.test.mjs
 */

let passCount = 0;
let failCount = 0;
/** @type {Array<{name:string, error:Error}>} */
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
}

/**
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 */
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

/** Let queued microtasks and zero-delay timers drain. */
function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const storageData = {};

/** Everything background sent over chrome.runtime (i.e. to the offscreen doc). */
let runtimeMessages = [];
/** Everything background sent to the content script. */
const tabMessages = [];

/** Whether an offscreen document currently "exists". Flipping this to false
 * is how the test simulates Chrome's silent idle teardown. */
let offscreenDocExists = false;
let createDocumentCalls = 0;

/** Set once offscreen-manager.js is imported, so the createDocument stub can
 * deliver OFFSCREEN_READY instead of making waitUntilReady() eat its full
 * 5s timeout on every creation. */
let offscreenManager = null;

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = keys == null ? Object.keys(storageData) : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) out[k] = storageData[k];
        return out;
      },
      async set(obj) {
        Object.assign(storageData, obj);
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) delete storageData[k];
      },
    },
    onChanged: { addListener() {} },
  },
  tabs: {
    async get(tabId) {
      return { id: tabId };
    },
    async sendMessage(tabId, envelope) {
      tabMessages.push({ tabId, envelope });
      return undefined;
    },
  },
  runtime: {
    async sendMessage(envelope) {
      // Record whether a document actually existed at send time. The real
      // chrome.runtime.sendMessage rejects with "Receiving end does not
      // exist" when it doesn't, and safeSendRuntimeMessage swallows that --
      // so a message sent into the void looks identical to a delivered one
      // unless the test snapshots this.
      runtimeMessages.push({ ...envelope, __docAlive: offscreenDocExists });
      return undefined;
    },
  },
  offscreen: {
    async hasDocument() {
      return offscreenDocExists;
    },
    async createDocument() {
      createDocumentCalls++;
      offscreenDocExists = true;
      // The real document announces OFFSCREEN_READY as soon as it boots.
      offscreenManager?.notifyOffscreenReady();
      return undefined;
    },
    async closeDocument() {
      offscreenDocExists = false;
      return undefined;
    },
  },
};

/** Stand-in backend: every sentence synthesizes instantly and successfully. */
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return {
      audio_base64: 'QUJD',
      mime_type: 'audio/mpeg',
      sample_rate: 24000,
      duration_ms: 1000,
      request_id: 'req_test',
      mock: true,
    };
  },
});

offscreenManager = await import('../src/background/offscreen-manager.js');
const session = await import('../src/background/session.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {number} count
 * @returns {import('../src/shared/types.js').ReadUnit[]}
 */
function makeUnits(count) {
  return [
    {
      id: 'u1',
      kind: 'paragraph',
      label: null,
      meta: {},
      sentences: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        index: i,
        text: `Sentence number ${i}.`,
        languageCode: 'en-IN',
        locator: { kind: 'dom-range' },
      })),
    },
  ];
}

/** @param {string} type @returns {object[]} */
function messagesOfType(type) {
  return runtimeMessages.filter((m) => m && m.type === type);
}

const TAB_ID = 1;

// ---------------------------------------------------------------------------
// 1. The teardown -> resume path
// ---------------------------------------------------------------------------

group('1. Play after Chrome silently closed the idle offscreen document');

const sessionId = session.prepareNewSession(TAB_ID);

await check('setup: a session starts, synthesizes, and dispatches audio offscreen', async () => {
  await session.handleStartReading(
    {
      contentKey: 'article:aaaa:bbbb',
      contentHash: 'bbbb',
      kind: 'article',
      title: 'Test article',
      url: 'https://example.com/post',
      exhausted: true,
      startIndex: 0,
      units: makeUnits(8),
    },
    TAB_ID,
    sessionId
  );
  await settle();

  assertEqual(createDocumentCalls, 1, 'the first prefetch must have created the offscreen document');
  assert(
    messagesOfType('SENTENCE_AUDIO_READY').length > 0,
    'prefetch must have dispatched at least one synthesized sentence offscreen'
  );

  await session.handleControlPlay(sessionId, TAB_ID);
  await settle();
  assert(messagesOfType('AUDIO_PLAY').length === 1, 'Play must have sent exactly one AUDIO_PLAY');
});

await check('setup: the user pauses', async () => {
  await session.handleControlPause(sessionId, TAB_ID);
  await settle();
  assertEqual(messagesOfType('AUDIO_PAUSE').length, 1, 'Pause must have sent AUDIO_PAUSE');

  const state = await session.getPlaybackStateFor(TAB_ID);
  assertEqual(state.status, 'paused', 'the session must be paused');
});

await check('Play re-creates the document AND re-seeds it with audio', async () => {
  // Chrome closes an idle AUDIO_PLAYBACK document after ~30s. No event fires;
  // the document is simply gone the next time we look.
  offscreenDocExists = false;
  runtimeMessages = [];

  await session.handleControlPlay(sessionId, TAB_ID);
  await settle(80);

  assertEqual(createDocumentCalls, 2, 'Play must have recreated the destroyed offscreen document');
  assertEqual(
    messagesOfType('OFFSCREEN_INIT').length,
    1,
    'the recreated document must be re-initialized'
  );
  assertEqual(messagesOfType('AUDIO_PLAY').length, 1, 'Play must still arm the replacement queue');

  // The actual regression: OFFSCREEN_INIT emptied the replacement queue, so
  // background has to hand it sentences again. Without the re-seed, every
  // index still counts as `dispatched`, queuedAhead stays at PREFETCH_AHEAD,
  // and fill() never fetches anything -- zero SENTENCE_AUDIO_READY, silence
  // forever.
  const reDispatched = messagesOfType('SENTENCE_AUDIO_READY');
  assert(
    reDispatched.length > 0,
    'audio must be re-synthesized into the replacement queue (this is the bug: it never was)'
  );
});

await check('the re-seed restarts at the playhead, not back at the top', async () => {
  const state = await session.getPlaybackStateFor(TAB_ID);
  const indices = messagesOfType('SENTENCE_AUDIO_READY').map((m) => m.payload.index);
  const lowest = Math.min(...indices);
  assertEqual(
    lowest,
    Math.max(0, state.index),
    'the first re-seeded sentence must be the one the cursor is sitting on'
  );
});

await check('a second Play with the document still alive does not restart the queue again', async () => {
  runtimeMessages = [];
  await session.handleControlPause(sessionId, TAB_ID);
  await settle();
  runtimeMessages = [];

  await session.handleControlPlay(sessionId, TAB_ID);
  await settle(80);

  assertEqual(createDocumentCalls, 2, 'no new document should have been created');
  assertEqual(
    messagesOfType('OFFSCREEN_INIT').length,
    0,
    'a live document must not be re-initialized'
  );
  assertEqual(
    messagesOfType('SENTENCE_AUDIO_READY').length,
    0,
    'an ordinary resume must not re-synthesize anything -- the queue still holds its audio'
  );
});

await session.handleControlStop(sessionId, 'user-stop', TAB_ID);
await settle();

// ---------------------------------------------------------------------------
// 2. The same teardown during synthesis
// ---------------------------------------------------------------------------

group('2. The document dies mid-synthesis, before the dispatch');

await check('a sentence is never counted as dispatched into a document that vanished', async () => {
  createDocumentCalls = 0;
  offscreenDocExists = false;
  runtimeMessages = [];

  const sid = session.prepareNewSession(TAB_ID);

  // Kill the document between ensureOffscreenReady() and the dispatch, the
  // window where a multi-second synthesis round trip actually sits.
  const realFetch = globalThis.fetch;
  let killed = false;
  globalThis.fetch = async (...args) => {
    if (!killed && offscreenDocExists) {
      killed = true;
      offscreenDocExists = false;
    }
    return realFetch(...args);
  };

  await session.handleStartReading(
    {
      contentKey: 'article:cccc:dddd',
      contentHash: 'dddd',
      kind: 'article',
      title: 'Test article 2',
      url: 'https://example.com/post-2',
      exhausted: true,
      startIndex: 0,
      units: makeUnits(8),
    },
    TAB_ID,
    sid
  );
  await settle(120);
  globalThis.fetch = realFetch;

  assert(offscreenDocExists, 'the document must have been recreated');
  const dispatches = messagesOfType('SENTENCE_AUDIO_READY');
  assert(dispatches.length > 0, 'audio must still be dispatched');
  const lost = dispatches.filter((m) => !m.__docAlive);
  assertEqual(
    lost.length,
    0,
    `every dispatch must reach a live document; ${lost.length} vanished into a closed one ` +
      `(indices ${JSON.stringify(lost.map((m) => m.payload.index))}) -- each of those stays in ` +
      'PrefetchQueue.dispatched forever, since its SENTENCE_ENDED can never arrive'
  );

  const state = await session.getPlaybackStateFor(TAB_ID);
  assert(state.status !== 'error', `session must not have errored (status: ${state.status})`);

  await session.handleControlStop(sid, 'user-stop', TAB_ID);
  await settle();
});

// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`offscreen-teardown-recovery: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);
if (failCount > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.error.stack || f.error.message}`);
  process.exit(1);
}
console.log('Offscreen-document teardown recovery holds.');
