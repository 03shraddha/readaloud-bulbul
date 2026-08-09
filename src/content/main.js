/**
 * src/content/main.js
 *
 * Foundation-owned in-page orchestrator, and the single content-side
 * message endpoint. Loaded via dynamic import() from src/content/loader.js.
 *
 * Responsibilities (see shared_contracts §1, §2, §3, §10):
 *  - Resolve an extractor via the registry (src/content/extract/registry.js).
 *  - On ACTIVATE: run extract(), assign monotonic Sentence.index values,
 *    keep a session-local Map<sentenceId, Sentence> (holding the opaque
 *    locators), strip locators before sending, and send START_READING.
 *  - On REQUEST_MORE_UNITS: call extractor.extractMore() and reply
 *    APPEND_UNITS.
 *  - On HIGHLIGHT_SENTENCE: run the ensureVisible -> resolveAnchor ->
 *    highlighter/fallback sequence and reply HIGHLIGHT_RESULT.
 *  - Forward PLAYBACK_STATE / CLEAR_HIGHLIGHT / RESUME_AVAILABLE /
 *    SESSION_ENDED / TOAST to the widget.
 *  - Forward widget control callbacks to the background as CONTROL_*.
 *  - Tear down on pagehide and on SPA URL change (X pushState).
 *
 * main.js imports the widget, highlighter, and extractors ONLY through
 * their published interfaces (dynamic import of web-accessible module
 * URLs) — this is what keeps the extractor and UI tasks from touching each
 * other's files. Those modules (widget.js, highlighter.js, article.js,
 * twitter.js, ...) are placeholders/empty directories at foundation time;
 * this file is safe to load before they exist because the imports below
 * are dynamic and defensively wrapped.
 */

import { MSG, TARGET, makeEnvelope, isForTarget, safeSendRuntimeMessage } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';
import { getResolvedExtractor } from './extract/registry.js';

const log = createLogger('content:main');

/** @type {string|null} */
let sessionId = null;

/** @type {import('../shared/types.js').Extractor|null} */
let activeExtractor = null;

/** Session-local map of sentenceId -> Sentence (WITH locator; never sent off-page). */
const sentenceMap = new Map();

/** Monotonic cursor for Sentence.index, never reused within a session. */
let nextSentenceIndex = 0;

/** @type {ReturnType<typeof import('./ui/widget.js')>|null} */
let widgetModule = null;

/** @type {any} */
let highlighterModule = null;

let lastUrl = location.href;

// ---------------------------------------------------------------------------
// Lazy, defensive loaders for the UI modules (owned by a separate task).
// ---------------------------------------------------------------------------

async function getWidget() {
  if (widgetModule) return widgetModule;
  try {
    const url = chrome.runtime.getURL('src/content/ui/widget.js');
    const mod = await import(url);
    widgetModule = mod.default ?? mod;
    return widgetModule;
  } catch (err) {
    log.warn('widget module unavailable', err);
    return null;
  }
}

async function getHighlighter() {
  if (highlighterModule) return highlighterModule;
  try {
    const url = chrome.runtime.getURL('src/content/ui/highlighter.js');
    const mod = await import(url);
    highlighterModule = mod.default ?? mod;
    return highlighterModule;
  } catch (err) {
    log.warn('highlighter module unavailable', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sentence bookkeeping
// ---------------------------------------------------------------------------

/**
 * Assign monotonic indices to freshly-extracted units' sentences, store the
 * full (locator-bearing) Sentence in sentenceMap, and return a locator-free
 * deep copy suitable for sending off-page.
 * @param {import('../shared/types.js').ReadUnit[]} units
 * @returns {import('../shared/types.js').ReadUnit[]}
 */
function assignIndicesAndStrip(units) {
  return units.map((unit) => ({
    ...unit,
    sentences: unit.sentences.map((sentence) => {
      const withIndex = { ...sentence, index: nextSentenceIndex++ };
      sentenceMap.set(withIndex.id, withIndex);

      // Strip the opaque locator before this ever leaves the page context.
      const { locator, ...stripped } = withIndex;
      return stripped;
    }),
  }));
}

// ---------------------------------------------------------------------------
// Message handlers: background -> content
// ---------------------------------------------------------------------------

async function handleActivate() {
  try {
    activeExtractor = await getResolvedExtractor(location);
    if (!activeExtractor) {
      log.error('no extractor resolved for host', location.host);
      return;
    }

    const settings = {}; // background owns settings; extractor.init gets what it needs later
    await activeExtractor.init({ log: createLogger(`content:${activeExtractor.id}`), settings });

    const result = await activeExtractor.extract();
    const units = assignIndicesAndStrip(result.units);
    const startIndex = units[0]?.sentences[0]?.index ?? 0;

    await safeSendRuntimeMessage(
      makeEnvelope(MSG.START_READING, TARGET.BACKGROUND, sessionId, {
        contentKey: result.contentKey,
        contentHash: result.contentHash,
        kind: activeExtractor.id,
        title: result.title,
        url: location.href,
        units,
        startIndex,
        exhausted: result.exhausted,
      })
    );
  } catch (err) {
    log.error('ACTIVATE failed', err);
  }
}

/**
 * @param {import('../shared/types.js').RequestMoreUnitsPayload} payload
 */
async function handleRequestMoreUnits(payload) {
  if (!activeExtractor) return;
  try {
    const result = await activeExtractor.extractMore(payload.reason);
    const units = result ? assignIndicesAndStrip(result.units) : [];
    const exhausted = result ? result.exhausted : true;

    await safeSendRuntimeMessage(
      makeEnvelope(MSG.APPEND_UNITS, TARGET.BACKGROUND, sessionId, { units, exhausted })
    );
  } catch (err) {
    log.error('extractMore failed', err);
    await safeSendRuntimeMessage(
      makeEnvelope(MSG.APPEND_UNITS, TARGET.BACKGROUND, sessionId, { units: [], exhausted: true })
    );
  }
}

/**
 * The §10 highlight/fallback protocol.
 * @param {import('../shared/types.js').HighlightSentencePayload} payload
 */
async function handleHighlightSentence(payload) {
  const sentence = sentenceMap.get(payload.sentenceId);
  const widget = await getWidget();

  if (!sentence || !activeExtractor) {
    widget?.showTextFallback?.(payload.text);
    await safeSendRuntimeMessage(
      makeEnvelope(MSG.HIGHLIGHT_RESULT, TARGET.BACKGROUND, sessionId, {
        sentenceId: payload.sentenceId,
        index: payload.index,
        ok: false,
        reason: 'unmounted',
      })
    );
    return;
  }

  try {
    await activeExtractor.ensureVisible(sentence);
    const anchor = await activeExtractor.resolveAnchor(sentence);

    if (anchor) {
      const highlighter = await getHighlighter();
      await highlighter?.apply?.(anchor, { sentenceId: payload.sentenceId });
      await safeSendRuntimeMessage(
        makeEnvelope(MSG.HIGHLIGHT_RESULT, TARGET.BACKGROUND, sessionId, {
          sentenceId: payload.sentenceId,
          index: payload.index,
          ok: true,
        })
      );
    } else {
      widget?.showTextFallback?.(payload.text);
      await safeSendRuntimeMessage(
        makeEnvelope(MSG.HIGHLIGHT_RESULT, TARGET.BACKGROUND, sessionId, {
          sentenceId: payload.sentenceId,
          index: payload.index,
          ok: false,
          reason: 'no-anchor',
        })
      );
    }
  } catch (err) {
    log.error('highlight failed', err);
    widget?.showTextFallback?.(payload.text);
    await safeSendRuntimeMessage(
      makeEnvelope(MSG.HIGHLIGHT_RESULT, TARGET.BACKGROUND, sessionId, {
        sentenceId: payload.sentenceId,
        index: payload.index,
        ok: false,
        reason: 'error',
      })
    );
  }
}

async function handleClearHighlight(payload) {
  const highlighter = await getHighlighter();
  highlighter?.clear?.(payload?.sentenceId);
}

async function forwardToWidget(type, payload) {
  const widget = await getWidget();
  widget?.onMessage?.(type, payload);
}

/**
 * Single content-side message endpoint. Routes background -> content
 * messages declared in shared_contracts §3.
 */
function onRuntimeMessage(env, _sender, _sendResponse) {
  if (!isForTarget(env, TARGET.CONTENT)) return undefined;
  if (env.sessionId != null && sessionId != null && env.sessionId !== sessionId) return undefined;

  switch (env.type) {
    case MSG.ACTIVATE:
      if (env.sessionId) sessionId = env.sessionId;
      handleActivate();
      break;
    case MSG.SESSION_STARTED:
      sessionId = env.payload?.sessionId ?? sessionId;
      forwardToWidget(env.type, env.payload);
      break;
    case MSG.REQUEST_MORE_UNITS:
      handleRequestMoreUnits(env.payload);
      break;
    case MSG.HIGHLIGHT_SENTENCE:
      handleHighlightSentence(env.payload);
      break;
    case MSG.CLEAR_HIGHLIGHT:
      handleClearHighlight(env.payload);
      break;
    case MSG.PLAYBACK_STATE:
    case MSG.RESUME_AVAILABLE:
    case MSG.SESSION_ENDED:
    case MSG.TOAST:
      forwardToWidget(env.type, env.payload);
      break;
    default:
      log.debug('unhandled message', env.type);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Widget -> background control forwarding
// ---------------------------------------------------------------------------

/**
 * Registered with the widget module so its control callbacks (play/pause/
 * skip/seek/rate/options) get relayed to the background as CONTROL_* messages.
 * @param {string} controlType - one of MSG.CONTROL_*
 * @param {object} [payload]
 */
export function sendControl(controlType, payload = {}) {
  safeSendRuntimeMessage(makeEnvelope(controlType, TARGET.BACKGROUND, sessionId, payload));
}

// ---------------------------------------------------------------------------
// Boot + teardown
// ---------------------------------------------------------------------------

function announceContentReady() {
  const extractorId = activeExtractor?.id ?? null;
  safeSendRuntimeMessage(
    makeEnvelope(MSG.CONTENT_READY, TARGET.BACKGROUND, sessionId, {
      url: location.href,
      host: location.host,
      extractorId,
      title: document.title,
    })
  );
}

function teardown() {
  activeExtractor?.dispose?.();
  activeExtractor = null;
  sentenceMap.clear();
  nextSentenceIndex = 0;
}

function watchForSpaNavigation() {
  // X/Twitter is a pushState SPA; re-check the URL periodically and on the
  // popstate event so a session-per-view teardown/rebind can happen later.
  const checkUrl = () => {
    if (location.href !== lastUrl) {
      const previousUrl = lastUrl;
      lastUrl = location.href;
      log.debug('SPA navigation detected', { from: previousUrl, to: lastUrl });
      teardown();
    }
  };

  window.addEventListener('popstate', checkUrl);

  const originalPushState = history.pushState;
  history.pushState = function patchedPushState(...args) {
    const result = originalPushState.apply(this, args);
    checkUrl();
    return result;
  };
}

function boot() {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  window.addEventListener('pagehide', teardown);
  watchForSpaNavigation();
  announceContentReady();
  log.debug('content main booted', { url: location.href });
}

boot();
