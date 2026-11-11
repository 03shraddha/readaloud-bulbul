#!/usr/bin/env node
/**
 * test/seek-cache-selection-resume.test.mjs
 *
 * Covers the playback-robustness changes:
 *  1. Audio cache: skipping back and forward re-sends audio already
 *     synthesized, with no new backend request.
 *  2. A request on the wire survives a nearby skip and is not repeated.
 *  3. Selection-only read: CONTROL_SEEK{index,endIndex} never fetches past
 *     endIndex and pauses when the selection has been read.
 *  4. A dead first sentence moves the session cursor, so the widget does not
 *     stay on 'buffering'.
 *  5. Mid-sentence resume: the paused position is stored in the snapshot and
 *     sent back as startAtMs when the sentence is dispatched again.
 *  6. AudioQueue: play() AbortError is not reported as a playback error,
 *     pause() reports the exact position, startAtMs seeks the clip.
 *
 * Same dependency-free harness as test/offscreen-teardown-recovery.test.mjs.
 * Run with: node test/seek-cache-selection-resume.test.mjs
 */

let passCount = 0;
let failCount = 0;

async function check(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}
function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- stubs -----------------------------------------------------------------

const storageData = {};
let runtimeMessages = [];
let tabMessages = [];
let offscreenDocExists = false;
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
        for (const k of Array.isArray(keys) ? keys : [keys]) delete storageData[k];
      },
    },
    onChanged: { addListener() {} },
  },
  tabs: {
    async get(tabId) {
      return { id: tabId };
    },
    async sendMessage(tabId, envelope) {
      tabMessages.push(envelope);
      return undefined;
    },
  },
  runtime: {
    async sendMessage(envelope) {
      runtimeMessages.push(envelope);
      return undefined;
    },
  },
  offscreen: {
    async hasDocument() {
      return offscreenDocExists;
    },
    async createDocument() {
      offscreenDocExists = true;
      offscreenManager?.notifyOffscreenReady();
    },
    async closeDocument() {
      offscreenDocExists = false;
    },
  },
};

/** Texts the stub backend was asked for, in order. */
let fetchedTexts = [];
/** Texts that fail with a non-retryable error. */
const failingTexts = new Set();
/** Delay before the stub backend answers. */
let fetchDelayMs = 0;

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  fetchedTexts.push(body.text);
  if (fetchDelayMs) await settle(fetchDelayMs);
  if (init.signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  if (failingTexts.has(body.text)) {
    return {
      ok: false,
      status: 400,
      async json() {
        return { error: { code: 'BAD_INPUT', message: 'nope', retryable: false } };
      },
    };
  }
  return {
    ok: true,
    status: 200,
    async json() {
      return { audio_base64: 'QUJD', mime_type: 'audio/mpeg', sample_rate: 24000, duration_ms: 4000, request_id: 'r' };
    },
  };
};

offscreenManager = await import('../src/background/offscreen-manager.js');
const session = await import('../src/background/session.js');
const { clearAudioCache } = await import('../src/background/audio-cache.js');
const { MSG } = await import('../src/shared/messages.js');
const { PREFETCH_AHEAD } = await import('../src/shared/constants.js');

const TAB_ID = 7;

function makeUnits(count, tag) {
  return [
    {
      id: 'u1',
      kind: 'paragraph',
      label: null,
      meta: {},
      sentences: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        index: i,
        text: `${tag} sentence ${i}.`,
        languageCode: 'en-IN',
      })),
    },
  ];
}

async function startSession(count, tag) {
  runtimeMessages = [];
  tabMessages = [];
  fetchedTexts = [];
  const id = session.prepareNewSession(TAB_ID);
  await session.handleStartReading(
    {
      contentKey: `article:${tag}:h`,
      contentHash: 'h',
      kind: 'article',
      title: tag,
      url: `https://example.com/${tag}`,
      exhausted: true,
      startIndex: 0,
      units: makeUnits(count, tag),
    },
    TAB_ID,
    id
  );
  await settle();
  return id;
}

const audioReady = () => runtimeMessages.filter((m) => m.type === MSG.SENTENCE_AUDIO_READY);
const dispatchedIndices = () => audioReady().map((m) => m.payload.index);
const lastState = () => [...tabMessages].reverse().find((m) => m.type === MSG.PLAYBACK_STATE)?.payload;

/** Play sentence `i` to its end, the way the offscreen document reports it. */
async function playThrough(i) {
  session.handleSentenceStarted({ sentenceId: `s${i}`, index: i });
  session.handleSentenceEnded({ sentenceId: `s${i}`, index: i, durationMs: 4000 });
  await settle();
}

// --- 1. cache --------------------------------------------------------------

console.log('\n1. Skipping back and forward uses cached audio');

let sid = await startSession(20, 'cache');
await session.handleControlPlay(sid, TAB_ID);
await settle();

await check('setup: the first sentences are synthesized once each', async () => {
  assertEqual(fetchedTexts.length, PREFETCH_AHEAD, 'one request per prefetched sentence');
});

await check('skip back two sentences: audio is re-sent, backend is not called', async () => {
  await playThrough(0);
  await playThrough(1);
  await playThrough(2);
  session.handleSentenceStarted({ sentenceId: 's3', index: 3 });
  const fetchesBefore = fetchedTexts.length;
  runtimeMessages = [];

  await session.handleControlSkip({ direction: 'prev', granularity: 'sentence' }, sid, TAB_ID);
  await session.handleControlSkip({ direction: 'prev', granularity: 'sentence' }, sid, TAB_ID);
  await settle();

  const flushes = runtimeMessages.filter((m) => m.type === MSG.AUDIO_FLUSH);
  assertEqual(flushes[flushes.length - 1].payload.fromIndex, 1, 'offscreen must be flushed to the skip target');
  assert(dispatchedIndices().includes(1), 'sentence 1 must be dispatched again after the skip back');
  assert(dispatchedIndices().includes(2), 'sentence 2 must be dispatched again after the skip back');
  const refetched = fetchedTexts.slice(fetchesBefore).filter((t) => /sentence [0-8]\.$/.test(t));
  assertEqual(refetched.length, 0, `already-synthesized sentences were fetched again: ${refetched.join(' | ')}`);
});

await check('skip forward again: still no repeat request for known sentences', async () => {
  const before = fetchedTexts.length;
  await session.handleControlSkip({ direction: 'next', granularity: 'sentence' }, sid, TAB_ID);
  await session.handleControlSkip({ direction: 'next', granularity: 'sentence' }, sid, TAB_ID);
  await settle();
  const counts = {};
  for (const t of fetchedTexts) counts[t] = (counts[t] || 0) + 1;
  const repeated = Object.entries(counts).filter(([, n]) => n > 1);
  assertEqual(repeated.length, 0, `sentences requested more than once: ${JSON.stringify(repeated)}`);
  assert(fetchedTexts.length - before <= 2, 'at most the newly exposed sentences may be fetched');
});

// --- 2. in-flight survives a nearby skip -------------------------------------

console.log('\n2. A request on the wire survives a nearby skip');

clearAudioCache();
fetchDelayMs = 120;
sid = await startSession(20, 'wire');
await check('skip next while the first requests are still on the wire: none is repeated', async () => {
  // Requests for 0,1,2 are in flight (TTS_CONCURRENCY). Skip to 1 right away.
  await session.handleControlSkip({ direction: 'next', granularity: 'sentence' }, sid, TAB_ID);
  await settle(500);
  const counts = {};
  for (const t of fetchedTexts) counts[t] = (counts[t] || 0) + 1;
  const repeated = Object.entries(counts).filter(([, n]) => n > 1);
  assertEqual(repeated.length, 0, `requests repeated after a one-sentence skip: ${JSON.stringify(repeated)}`);
  assert(dispatchedIndices().includes(1), 'the skip target must still be dispatched');
  assert(!dispatchedIndices().includes(0), 'the sentence skipped past must not be dispatched');
});
fetchDelayMs = 0;

// --- 3. selection-only read --------------------------------------------------

console.log('\n3. Selection-only read stops at the end of the selection');

clearAudioCache();
sid = await startSession(20, 'sel');
runtimeMessages = [];
fetchedTexts = [];
await session.handleControlSeek({ index: 4, endIndex: 5 }, sid, TAB_ID);
await session.handleControlPlay(sid, TAB_ID);
await settle();

await check('only the selected sentences are dispatched', async () => {
  const indices = [...new Set(dispatchedIndices())].sort((a, b) => a - b);
  assertEqual(JSON.stringify(indices), JSON.stringify([4, 5]), 'dispatch must stay inside the selection');
});

await check('after the last selected sentence the session pauses on the next one', async () => {
  await playThrough(4);
  await playThrough(5);
  runtimeMessages = [];
  session.handleQueueDrained({ lastIndex: 5 });
  await settle();
  const state = lastState();
  assertEqual(state.status, 'paused', 'session must pause at the end of the selection');
  assertEqual(state.index, 6, 'cursor must sit on the sentence after the selection');
  assert(runtimeMessages.some((m) => m.type === MSG.AUDIO_PAUSE), 'offscreen must be told to pause');
  assert(
    tabMessages.some((m) => m.type === MSG.TOAST && /selected text/i.test(m.payload.message)),
    'the reader must be told the selection is done'
  );
});

await check('Play afterwards carries on from the next sentence, with no bound', async () => {
  await session.handleControlPlay(sid, TAB_ID);
  await settle();
  const indices = dispatchedIndices();
  assert(indices.includes(6) && indices.includes(7), 'reading must continue past the old selection end');
});

await check('a plain skip clears the selection bound', async () => {
  await session.handleControlSeek({ index: 2, endIndex: 2 }, sid, TAB_ID);
  await session.handleControlSkip({ direction: 'next', granularity: 'sentence' }, sid, TAB_ID);
  runtimeMessages = [];
  await settle();
  await session.handleControlSkip({ direction: 'next', granularity: 'sentence' }, sid, TAB_ID);
  await settle();
  assert(dispatchedIndices().some((i) => i > 4), 'an ordinary skip must return to an unbounded read');
});

// --- 4. dead first sentence ---------------------------------------------------

console.log('\n4. A first sentence that cannot be voiced does not freeze the widget');

clearAudioCache();
failingTexts.add('dead sentence 0.');
sid = await startSession(10, 'dead');
await session.handleControlPlay(sid, TAB_ID);
await settle(300);

await check('the cursor moves past the dead sentence', async () => {
  assertEqual(lastState().index, 1, 'cursor must move to the first playable sentence');
});
await check('the next SENTENCE_STARTED is accepted and status becomes playing', async () => {
  session.handleSentenceStarted({ sentenceId: 's1', index: 1 });
  await settle();
  assertEqual(lastState().status, 'playing', 'status must leave buffering once audio starts');
  assert(
    tabMessages.some((m) => m.type === MSG.HIGHLIGHT_SENTENCE && m.payload.index === 1),
    'the highlight must follow the sentence that is playing'
  );
});
failingTexts.clear();

// --- 5. mid-sentence resume ---------------------------------------------------

console.log('\n5. A long pause resumes inside the sentence, not at its start');

clearAudioCache();
sid = await startSession(10, 'resume');
await session.handleControlPlay(sid, TAB_ID);
await settle();
await playThrough(0);
session.handleSentenceStarted({ sentenceId: 's1', index: 1 });
session.handlePlaybackTick({ sentenceId: 's1', index: 1, currentTimeMs: 2000, durationMs: 4000 });
await session.handleControlPause(sid, TAB_ID);
// Offscreen's final tick on pause carries the exact position.
session.handlePlaybackTick({ sentenceId: 's1', index: 1, currentTimeMs: 2600, durationMs: 4000 });
await settle(60);

await check('the exact paused position is written to the session snapshot', async () => {
  const snapshot = Object.values(storageData).find((v) => v && v.sessionId === sid && 'offsetMs' in v);
  assert(snapshot, 'a session snapshot with offsetMs must exist');
  assertEqual(snapshot.offsetMs, 2600, 'snapshot must hold the position of the final tick');
});

await check('after Chrome closes the idle offscreen document, the sentence resumes at the offset', async () => {
  offscreenDocExists = false; // silent idle teardown
  runtimeMessages = [];
  const before = fetchedTexts.length;
  await session.handleControlPlay(sid, TAB_ID);
  await settle(80);
  const first = audioReady().find((m) => m.payload.index === 1);
  assert(first, 'the paused sentence must be dispatched again');
  assertEqual(first.payload.startAtMs, 2350, 'it must start a quarter second before the paused position');
  const later = audioReady().find((m) => m.payload.index === 2);
  assertEqual(later?.payload.startAtMs, 0, 'later sentences must start at the top');
  assertEqual(fetchedTexts.length - before <= 1, true, 'resume must come from the cache, not the backend');
});

await check('a skip afterwards starts its target from the top', async () => {
  runtimeMessages = [];
  await session.handleControlSkip({ direction: 'prev', granularity: 'sentence' }, sid, TAB_ID);
  await session.handleControlSkip({ direction: 'next', granularity: 'sentence' }, sid, TAB_ID);
  await settle();
  for (const m of audioReady()) assertEqual(m.payload.startAtMs, 0, `index ${m.payload.index} must not carry an offset`);
});

await session.handleControlStop(sid, 'user-stop', TAB_ID);
await settle();

// --- 6. AudioQueue -------------------------------------------------------------

console.log('\n6. AudioQueue: interrupted play(), pause position, start offset');

class FakeAudio {
  constructor() {
    this.listeners = {};
    this.currentTime = 0;
    this.duration = 4;
    this.playbackRate = 1;
    this.playBehavior = 'ok';
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  emit(type) {
    for (const fn of [...(this.listeners[type] || [])]) fn();
  }
  removeAttribute() {
    this.src = '';
  }
  load() {}
  pause() {}
  play() {
    if (this.playBehavior === 'abort') {
      const err = new Error('The play() request was interrupted by a call to pause().');
      err.name = 'AbortError';
      return Promise.reject(err);
    }
    if (this.playBehavior === 'notallowed') {
      const err = new Error('not allowed');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    }
    return Promise.resolve();
  }
}

globalThis.URL.createObjectURL = () => `blob:fake/${Math.random()}`;
globalThis.URL.revokeObjectURL = () => {};

const { createAudioQueue } = await import('../src/offscreen/audio-queue.js');

function makeQueue() {
  const events = [];
  const elA = new FakeAudio();
  const elB = new FakeAudio();
  const queue = createAudioQueue({ elA, elB, onEvent: (type, payload) => events.push({ type, payload }) });
  queue.reset(1, 0);
  return { queue, events, elA, elB };
}
const clip = (index, extra = {}) => ({
  sentenceId: `s${index}`,
  index,
  audioBase64: 'QUJD',
  mimeType: 'audio/mpeg',
  durationHintMs: 4000,
  ...extra,
});

await check('play() interrupted by pause is not reported as a playback error', async () => {
  const { queue, events, elA } = makeQueue();
  elA.playBehavior = 'abort';
  queue.enqueue(clip(0));
  queue.play();
  queue.pause();
  await settle(10);
  assertEqual(events.filter((e) => e.type === MSG.PLAYBACK_ERROR).length, 0, 'AbortError must be ignored');
});

await check('a real play() rejection is still reported', async () => {
  const { queue, events, elA } = makeQueue();
  elA.playBehavior = 'notallowed';
  queue.enqueue(clip(0));
  queue.play();
  await settle(10);
  assertEqual(events.filter((e) => e.type === MSG.PLAYBACK_ERROR).length, 1, 'NotAllowedError must be reported');
});

await check('pause() reports the exact position', async () => {
  const { queue, events, elA } = makeQueue();
  queue.enqueue(clip(0));
  queue.play();
  elA.currentTime = 1.75;
  queue.pause();
  const tick = events.filter((e) => e.type === MSG.PLAYBACK_TICK).pop();
  assert(tick, 'pause must emit a tick');
  assertEqual(tick.payload.currentTimeMs, 1750, 'tick must carry the element position');
});

await check('startAtMs seeks the clip once metadata is loaded', async () => {
  const { queue, elA } = makeQueue();
  queue.enqueue(clip(0, { startAtMs: 2350 }));
  assertEqual(elA.currentTime, 0, 'no seek before metadata');
  elA.emit('loadedmetadata');
  assertEqual(elA.currentTime, 2.35, 'clip must start at the offset');
});

await check('startAtMs too close to the end is ignored', async () => {
  const { queue, elA } = makeQueue();
  queue.enqueue(clip(0, { startAtMs: 3900 }));
  elA.emit('loadedmetadata');
  assertEqual(elA.currentTime, 0, 'clip must replay from the top');
});

console.log('\n------------------------------------------------------------');
console.log(`seek-cache-selection-resume: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);
process.exit(failCount ? 1 : 0);
