#!/usr/bin/env node
/**
 * test/harness/session-recovery-check.mjs
 *
 * Dependency-free Node script (same inline-harness pattern as
 * contract-check.mjs) exercising the lazy service-worker-restart recovery
 * path added to src/background/session.js: recoverSessionForTab() /
 * resolveCurrent(), reached through both
 *   1. the REQUEST_STATE flow (getPlaybackStateFor), and
 *   2. a direct CONTROL_* message arriving with the content script's
 *      pre-restart sessionId, after `current` has been wiped (simulating the
 *      MV3 service worker having been torn down and woken back up).
 *
 * A minimal in-memory chrome.storage.local / chrome.tabs stub stands in for
 * the real extension APIs -- just enough surface for session.js's import
 * chain (persistence.js, offscreen-manager.js, prefetch-queue.js) to load
 * and run without touching real chrome.* or network APIs. session.js is
 * loaded via dynamic import() *after* the stub is installed, since static
 * imports would otherwise be hoisted above it.
 *
 * Run with: node test/harness/session-recovery-check.mjs
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

// ---------------------------------------------------------------------------
// Minimal chrome.* stub
// ---------------------------------------------------------------------------

const SESSION_KEY = 'ra.session';
const storageData = {};
const liveTabIds = new Set([1, 2, 3, 4, 5]); // 999 is deliberately never "open"

/** Every chrome.tabs.sendMessage call, for tests that need to observe
 * whether a (possibly stale/superseded) session actually messaged the tab. */
const sentTabMessages = [];

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
      if (!liveTabIds.has(tabId)) {
        throw new Error(`No tab with id: ${tabId}.`);
      }
      return { id: tabId };
    },
    async sendMessage(tabId, envelope) {
      sentTabMessages.push({ tabId, envelope });
      return undefined;
    },
  },
  runtime: {
    async sendMessage() {
      return undefined;
    },
  },
};

function putSnapshot(snapshot) {
  storageData[SESSION_KEY] = snapshot;
}

const session = await import('../../src/background/session.js');

// ---------------------------------------------------------------------------
// 1. REQUEST_STATE flow (getPlaybackStateFor) lazily recovers a snapshot
// ---------------------------------------------------------------------------

group('1. getPlaybackStateFor() lazy recovery (REQUEST_STATE flow)');

await check('fresh snapshot for a live tab is recovered, forced to paused', async () => {
  putSnapshot({
    sessionId: 's_recover_1',
    tabId: 1,
    contentKey: 'article:deadbeef:cafebabe',
    index: 7,
    status: 'playing', // pre-restart status; recovery must still land on paused
    rate: 1.25,
    updatedAt: Date.now(),
  });

  const state = await session.getPlaybackStateFor(1);
  assertEqual(state.status, 'paused', 'recovered session must never auto-resume to playing');
  assertEqual(state.contentKey, 'article:deadbeef:cafebabe', 'contentKey must be restored from the snapshot');
  assertEqual(state.index, 7, 'cursor/index must be restored from the snapshot');
  assertEqual(state.rate, 1.25, 'rate must be restored from the snapshot');
  assertEqual(state.sessionId, 's_recover_1', 'sessionId must be restored from the snapshot');

  // Reset the singleton for the next scenario.
  await session.handleControlStop('s_recover_1', 'user-stop', 1);
});

await check('a stale snapshot (older than the TTL) is discarded, not recovered', async () => {
  putSnapshot({
    sessionId: 's_recover_stale',
    tabId: 2,
    contentKey: 'article:aaaa:bbbb',
    index: 3,
    status: 'paused',
    rate: 1.0,
    updatedAt: Date.now() - 2 * 60 * 60 * 1000, // 2h old; TTL is 1h
  });

  const state = await session.getPlaybackStateFor(2);
  assertEqual(state.status, 'idle', 'a stale snapshot must not be recovered');
  assert(!storageData[SESSION_KEY], 'the stale snapshot must be cleared from storage once discarded');
});

await check('a snapshot whose tab no longer exists is discarded, not recovered', async () => {
  putSnapshot({
    sessionId: 's_recover_gone',
    tabId: 999, // not in liveTabIds -> chrome.tabs.get throws
    contentKey: 'article:cccc:dddd',
    index: 1,
    status: 'paused',
    rate: 1.0,
    updatedAt: Date.now(),
  });

  const state = await session.getPlaybackStateFor(999);
  assertEqual(state.status, 'idle', 'a snapshot for a closed tab must not be recovered');
  assert(!storageData[SESSION_KEY], 'the snapshot for a closed tab must be cleared from storage');
});

// ---------------------------------------------------------------------------
// 2. Direct CONTROL_* message after a simulated SW restart
// ---------------------------------------------------------------------------

group('2. CONTROL_* message recovers `current` instead of being silently dropped');

await check('CONTROL_PAUSE with the content script\'s still-held sessionId recovers `current`', async () => {
  putSnapshot({
    sessionId: 's_recover_ctrl',
    tabId: 3,
    contentKey: 'article:1111:2222',
    index: 4,
    status: 'playing',
    rate: 1.0,
    updatedAt: Date.now(),
  });

  // This is exactly what service-worker.js does for a CONTROL_PAUSE envelope:
  // pass along whatever sessionId the content script still has from before
  // the restart, plus the sender's tabId.
  await session.handleControlPause('s_recover_ctrl', 3);

  const state = await session.getPlaybackStateFor(3);
  assertEqual(state.sessionId, 's_recover_ctrl', 'CONTROL_PAUSE must have recovered and populated `current` (not no-op\'d)');
  assertEqual(state.status, 'paused', 'CONTROL_PAUSE on the recovered session must land on paused');

  await session.handleControlStop('s_recover_ctrl', 'user-stop', 3);
});

await check('a CONTROL_* whose sessionId does not match the snapshot is not applied, but tab-scoped recovery still sticks', async () => {
  putSnapshot({
    sessionId: 's_owner',
    tabId: 4,
    contentKey: 'article:3333:4444',
    index: 0,
    status: 'paused',
    rate: 1.0,
    updatedAt: Date.now(),
  });

  // A stale/foreign sessionId must not be able to mutate the recovered
  // session -- but recovering `current` for the tab is still correct so a
  // *subsequent* correctly-scoped message (or REQUEST_STATE) isn't left idle.
  await session.handleControlSetRate({ rate: 1.5 }, 's_someone_else', 4);

  let state = await session.getPlaybackStateFor(4);
  assertEqual(state.sessionId, 's_owner', 'recovery is tab-scoped and must have happened despite the mismatched sessionId');
  assertEqual(state.rate, 1.0, 'a mismatched-sessionId CONTROL_SET_RATE must not be applied to the recovered session');

  // Now the real owner's sessionId (matching the snapshot) must work against
  // the already-recovered in-memory session.
  await session.handleControlSetRate({ rate: 1.5 }, 's_owner', 4);
  state = await session.getPlaybackStateFor(4);
  assertEqual(state.rate, 1.5, 'a matching-sessionId CONTROL_SET_RATE must apply normally once recovered');

  await session.handleControlStop('s_owner', 'user-stop', 4);
});

// ---------------------------------------------------------------------------
// 3. Re-activating without a fresh CONTENT_READY still resumes correctly
// ---------------------------------------------------------------------------

group('3. handleStartReading() falls back to a direct progress lookup when there is no pending resume offer');

function fakeUnits(count) {
  const sentences = [];
  for (let i = 0; i < count; i++) {
    sentences.push({ id: `s${i}`, unitId: 'u1', index: i, text: `Sentence ${i}.`, languageCode: 'en-IN', anchorKind: 'virtual', locator: null });
  }
  return [{ id: 'u1', kind: 'paragraph', label: null, sentences, meta: {} }];
}

await check('re-clicking the toolbar icon after a pause (no CONTENT_READY in between) resumes from the last saved index, not the top', async () => {
  const contentKey = 'article:reactivate:hash1';

  // First activation: fresh read, nothing to resume, reads a few sentences
  // in, then pauses (this is what writes a real ProgressRecord to storage).
  const sessionId1 = session.prepareNewSession(5);
  await session.handleStartReading(
    { contentKey, contentHash: 'hash1', kind: 'article', title: 'T', url: 'https://example.com/a', units: fakeUnits(5), startIndex: 0, exhausted: true },
    5,
    sessionId1
  );
  await session.handleControlSeek({ index: 3 }, sessionId1, 5);
  await session.handleControlPause(sessionId1, 5);

  let state = await session.getPlaybackStateFor(5);
  assertEqual(state.index, 3, 'sanity check: the first session paused at index 3');

  // Second activation on the SAME tab/content, deliberately with NO pending
  // resume offer cached (persistence.getPendingResume(5) is untouched here) --
  // this is exactly what re-clicking the toolbar icon produces on a page
  // whose one-shot CONTENT_READY pending offer was already consumed (or
  // never populated) earlier in this same page load.
  const sessionId2 = session.prepareNewSession(5);
  await session.handleStartReading(
    { contentKey, contentHash: 'hash1', kind: 'article', title: 'T', url: 'https://example.com/a', units: fakeUnits(5), startIndex: 0, exhausted: true },
    5,
    sessionId2
  );

  state = await session.getPlaybackStateFor(5);
  assertEqual(state.index, 3, 're-activating must resume at the previously-saved index, not restart at 0');

  await session.handleControlStop(sessionId2, 'user-stop', 5);
});

await check('a session superseded mid-resume-lookup does not apply stale state or message the tab', async () => {
  const contentKeyA = 'article:racea:hash1';
  const contentKeyB = 'article:raceb:hash2';

  // Seed A's record with a MISMATCHED contentHash ('oldhash' vs A's own
  // extraction reporting 'hash1' below) -- this is what makes the test
  // meaningful: tryApplyResume()'s article-kind REJECTION path
  // (isArticleResumeValid() failing) calls sendToTab() directly with no
  // destroyed/stopped guard of its own, unlike markReady() (which already
  // no-ops for a destroyed session). A matching hash would take the
  // SUCCESS path instead, which only mutates `cursor` silently and would
  // pass even without the fix this test is meant to catch.
  storageData[`ra.progress.${contentKeyA}`] = {
    schemaVersion: 1,
    contentKey: contentKeyA,
    kind: 'article',
    url: 'https://example.com/a',
    title: 'A',
    contentHash: 'oldhash',
    index: 7,
    unitId: null,
    sentenceId: null,
    previewText: '',
    totalSentences: 10,
    lastStatusId: null,
    readStatusIds: [],
    updatedAt: Date.now(),
  };

  const sessionIdA = session.prepareNewSession(1);
  const payloadA = {
    contentKey: contentKeyA,
    contentHash: 'hash1',
    kind: 'article',
    title: 'A',
    url: 'https://example.com/a',
    units: fakeUnits(10),
    startIndex: 0,
    exhausted: true,
  };

  // Start A's handleStartReading but do NOT await it yet: with no pending
  // resume cached, it runs synchronously up to `await
  // persistence.getStoredProgress(...)` and suspends there, exactly like a
  // real await yielding control back to the message loop.
  const pendingA = session.handleStartReading(payloadA, 1, sessionIdA);

  // Synchronously (before A's suspended lookup resolves), a second
  // activation on the SAME tab supersedes it -- e.g. mashing the toolbar
  // icon twice in quick succession. prepareNewSession() itself legitimately
  // ends A first (CLEAR_HIGHLIGHT + SESSION_ENDED, sent with A's sessionId)
  // -- that's correct, expected teardown, not the bug under test. The
  // marker is captured AFTER that teardown so it only covers messages from
  // this point on.
  const sessionIdB = session.prepareNewSession(1);
  const messageCountAfterSupersedeTeardown = sentTabMessages.length;

  const payloadB = {
    contentKey: contentKeyB,
    contentHash: 'hash2',
    kind: 'article',
    title: 'B',
    url: 'https://example.com/b',
    units: fakeUnits(3),
    startIndex: 0,
    exhausted: true,
  };
  await session.handleStartReading(payloadB, 1, sessionIdB);

  // Now let A's suspended call finish.
  await pendingA;

  const state = await session.getPlaybackStateFor(1);
  assertEqual(state.sessionId, sessionIdB, '`current` must still be the newer session B, not stale A');
  assertEqual(state.contentKey, contentKeyB, "B's own content must be reported, unaffected by A's late resume");
  assertEqual(state.index, 0, "B must not have inherited A's resumed index (7)");

  // The real point: A's late resume/markReady() must never have run at all,
  // so -- after its own legitimate teardown -- it must never send anything
  // else to the tab (no PLAYBACK_STATE from a stale markReady(), no TOAST
  // from a stale tryApplyResume() rejection).
  const messagesFromAAfterSupersede = sentTabMessages
    .slice(messageCountAfterSupersedeTeardown)
    .filter((m) => m.envelope?.sessionId === sessionIdA);
  assertEqual(messagesFromAAfterSupersede.length, 0, 'a superseded session must not message the tab after losing the race');

  await session.handleControlStop(sessionIdB, 'user-stop', 1);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`session-recovery-check: ${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);

if (failCount > 0) {
  console.log('\nFailures:');
  for (const { name, error } of failures) {
    console.log(`  - ${name}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('All service-worker-restart recovery invariants hold.');
}
