/**
 * src/background/service-worker.js
 *
 * The extension's MV3 background service worker. Owns:
 *  - the SINGLE chrome.runtime.onMessage listener (filters on
 *    env.target === 'background', routes by env.type, and returns `true`
 *    ONLY for REQUEST_STATE per shared_contracts §2/§3),
 *  - chrome.action.onClicked (send ACTIVATE to the active tab; if the
 *    content script hasn't loaded, inject the loader and retry once),
 *  - chrome.tabs.onRemoved / onUpdated (end sessions on navigation),
 *  - chrome.runtime.onSuspend (flush progress before the worker is killed).
 *
 * All actual orchestration logic lives in session.js / persistence.js /
 * offscreen-manager.js — this file is intentionally thin routing glue.
 */

import { MSG, TARGET, isForTarget, makeEnvelope } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';
import * as session from './session.js';
import * as persistence from './persistence.js';
import * as offscreenManager from './offscreen-manager.js';

const log = createLogger('background:sw');

/** Attempts (with delay between each) to reach a just-injected content
 * script before giving up. See activateTab()'s doc comment for why more
 * than one immediate retry is needed. */
const POST_INJECT_RETRY_ATTEMPTS = 5;
const POST_INJECT_RETRY_DELAY_MS = 100;

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Warm the settings cache immediately; session.js/prefetch-queue.js read it
// synchronously afterwards.
persistence.loadSettingsCache();

// ---------------------------------------------------------------------------
// The single chrome.runtime.onMessage listener
// ---------------------------------------------------------------------------

/**
 * @param {object} env - message envelope, see shared_contracts §2
 * @param {chrome.runtime.MessageSender} sender
 * @param {Function} sendResponse
 * @returns {boolean|undefined} true ONLY for REQUEST_STATE, to keep the
 *   sendResponse channel open for its async(ish) reply.
 */
function handleMessage(env, sender, sendResponse) {
  if (!isForTarget(env, TARGET.BACKGROUND)) return undefined;

  const tabId = sender?.tab?.id ?? null;

  switch (env.type) {
    // --- content -> background ---
    case MSG.CONTENT_READY:
      persistence.handleContentReady(env.payload, tabId);
      return undefined;

    case MSG.START_READING:
      session.handleStartReading(env.payload, tabId, env.sessionId);
      return undefined;

    case MSG.APPEND_UNITS:
      session.handleAppendUnits(env.payload, env.sessionId, tabId);
      return undefined;

    case MSG.CONTROL_PLAY:
      session.handleControlPlay(env.sessionId, tabId);
      return undefined;

    case MSG.CONTROL_PAUSE:
      session.handleControlPause(env.sessionId, tabId);
      return undefined;

    case MSG.CONTROL_TOGGLE:
      session.handleControlToggle(env.sessionId, tabId);
      return undefined;

    case MSG.CONTROL_STOP:
      session.handleControlStop(env.sessionId, 'user-stop', tabId);
      return undefined;

    case MSG.CONTROL_SKIP:
      session.handleControlSkip(env.payload, env.sessionId, tabId);
      return undefined;

    case MSG.CONTROL_SEEK:
      session.handleControlSeek(env.payload, env.sessionId, tabId);
      return undefined;

    case MSG.CONTROL_SET_RATE:
      session.handleControlSetRate(env.payload, env.sessionId, tabId);
      return undefined;

    case MSG.CONTROL_SET_OPTION:
      persistence.updateSetting(env.payload?.key, env.payload?.value);
      return undefined;

    case MSG.REQUEST_STATE:
      session.getPlaybackStateFor(tabId).then(sendResponse);
      return true;

    case MSG.HIGHLIGHT_RESULT:
      session.handleHighlightResult(env.payload, env.sessionId, tabId);
      return undefined;

    case MSG.RESUME_DECISION: {
      const shouldActivate = persistence.handleResumeDecision(env.payload, tabId);
      if (shouldActivate && tabId != null) activateTab(tabId);
      return undefined;
    }

    // --- offscreen -> background ---
    case MSG.OFFSCREEN_READY:
      offscreenManager.notifyOffscreenReady();
      return undefined;

    case MSG.SENTENCE_STARTED:
      session.handleSentenceStarted(env.payload);
      return undefined;

    case MSG.SENTENCE_ENDED:
      session.handleSentenceEnded(env.payload);
      return undefined;

    case MSG.PLAYBACK_TICK:
      session.handlePlaybackTick(env.payload);
      return undefined;

    case MSG.QUEUE_DRAINED:
      session.handleQueueDrained(env.payload);
      return undefined;

    case MSG.BUFFER_LOW:
      session.handleBufferLow(env.payload);
      return undefined;

    case MSG.PLAYBACK_ERROR:
      session.handlePlaybackError(env.payload);
      return undefined;

    default:
      log.debug('unhandled message type', env.type);
      return undefined;
  }
}

chrome.runtime.onMessage.addListener(handleMessage);

// ---------------------------------------------------------------------------
// Toolbar icon click -> ACTIVATE (with injection-and-retry fallback)
// ---------------------------------------------------------------------------

/**
 * Sends ACTIVATE to `tabId`, reserving a fresh sessionId first. If the
 * content script hasn't been injected yet (fresh install, or a page that
 * loaded before the extension did), injects the loader and retries.
 *
 * `chrome.scripting.executeScript()`'s promise resolves once loader.js's
 * synchronous IIFE finishes running -- but loader.js (src/content/loader.js)
 * does nothing more than kick off `import(mainUrl)` and return immediately;
 * it never awaits it. The actual `chrome.runtime.onMessage` listener is only
 * registered once that dynamically-imported main.js module has finished
 * being fetched/evaluated and its boot() has run -- which is inherently
 * asynchronous (a real network/cache fetch of an ES module graph, not a
 * same-tick continuation). A single immediate sendMessage() right after
 * executeScript() resolves races that import and reliably loses on a cold
 * module cache, throwing "Could not establish connection. Receiving end
 * does not exist." even though injection genuinely succeeded and the
 * listener shows up moments later. Retrying a few times with a short delay
 * gives that import the room it needs instead of giving up on the first miss.
 * @param {number} tabId
 */
async function activateTab(tabId) {
  const sessionId = session.prepareNewSession(tabId);
  const envelope = makeEnvelope(MSG.ACTIVATE, TARGET.CONTENT, sessionId, { reason: 'toolbar' });

  try {
    await chrome.tabs.sendMessage(tabId, envelope);
    return;
  } catch (err) {
    log.debug('content script not reachable, injecting loader and retrying', err?.message);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/loader.js'],
    });
  } catch (injectErr) {
    log.error('failed to inject loader', injectErr);
    session.abortPendingSession(sessionId);
    return;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= POST_INJECT_RETRY_ATTEMPTS; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, envelope);
      return;
    } catch (retryErr) {
      lastErr = retryErr;
      if (attempt < POST_INJECT_RETRY_ATTEMPTS) await delay(POST_INJECT_RETRY_DELAY_MS);
    }
  }

  log.error('failed to activate tab after injecting loader', lastErr);
  session.abortPendingSession(sessionId);
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  activateTab(tab.id).catch((err) => log.error('activateTab threw', err));
});

// ---------------------------------------------------------------------------
// Tab lifecycle: end sessions on navigation/close
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  session.endSessionForTab(tabId, 'navigation');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A real (non-SPA) navigation invalidates whatever session was reading
  // this tab's previous document. SPA (pushState) navigations are handled
  // content-side (main.js tears itself down) and don't fire this.
  if (changeInfo.status === 'loading' && changeInfo.url) {
    session.endSessionForTab(tabId, 'navigation');
  }
});

// ---------------------------------------------------------------------------
// Service worker suspend: flush progress immediately
// ---------------------------------------------------------------------------

chrome.runtime.onSuspend.addListener(() => {
  session.flushActiveSessionProgress();
});
