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
 *    SESSION_ENDED / TOAST to the widget. PLAYBACK_STATE additionally gets
 *    an `upcoming` field (a short locator-free window of the next few
 *    sentences from sentenceMap) attached for the widget's click-to-seek
 *    list -- see computeUpcomingSentences().
 *  - Forward widget control callbacks to the background as CONTROL_*.
 *  - Tear down on pagehide and on SPA URL change (X pushState); an SPA
 *    navigation also sends CONTROL_STOP so the background session actually
 *    ends (same path as the widget's own Stop button) instead of being left
 *    running against a view the content script has already discarded.
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
import { getSettings } from '../shared/storage.js';
import { SETTINGS_KEY } from '../shared/keys.js';
import { getResolvedExtractor } from './extract/registry.js';

const log = createLogger('content:main');

/** @type {string|null} */
let sessionId = null;

/**
 * Read-only snapshot of `ra.settings`, refreshed on every ACTIVATE. The
 * background service worker owns all WRITES (shared_contracts §7); reading
 * here is what lets extractors honor autoScroll/skipPromoted/announceRetweets
 * and lets the highlighter honor highlightStyle.
 * @type {object}
 */
let currentSettings = {};

/** sentenceId of the highlight currently applied, so we can clear it. */
let activeHighlightId = null;

/**
 * Monotonic counter tagging each handleHighlightSentence() invocation.
 * ensureVisible()/resolveAnchor() latency varies wildly per sentence (a
 * near-instant DOM lookup vs. multi-second tweet-mount search), so an older
 * HIGHLIGHT_SENTENCE call can still be in-flight when a newer one for a
 * later sentence arrives and finishes first. Comparing a call's captured
 * requestId against this counter right before it touches the highlighter is
 * how it detects "a newer request has since taken over" and bails out
 * instead of clobbering the correct, current highlight.
 */
let highlightRequestSeq = 0;

/** @type {import('../shared/types.js').Extractor|null} */
let activeExtractor = null;

/** Session-local map of sentenceId -> Sentence (WITH locator; never sent off-page). */
const sentenceMap = new Map();

/** Monotonic cursor for Sentence.index, never reused within a session. */
let nextSentenceIndex = 0;

/**
 * How many sentences ahead of the current cursor to offer in the widget's
 * click-to-seek list (see computeUpcomingSentences() / forwardToWidget()).
 */
const UPCOMING_WINDOW_SIZE = 8;

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
    // Every ACTIVATE starts a brand-new background Session whose flat
    // sentence array is empty, so session-local indices MUST restart at 0.
    teardown();

    activeExtractor = await getResolvedExtractor(location);
    if (!activeExtractor) {
      log.error('no extractor resolved for host', location.host);
      return;
    }

    try {
      currentSettings = await getSettings();
    } catch (err) {
      log.warn('could not read settings; using extractor defaults', err);
      currentSettings = {};
    }

    // Show the player immediately; extraction can take a moment.
    const widget = await getWidget();
    widget?.mount?.();
    widget?.setPosition?.(currentSettings.widgetPosition ?? null);

    await activeExtractor.init({
      log: createLogger(`content:${activeExtractor.id}`),
      settings: currentSettings,
    });

    const result = await activeExtractor.extract();

    // Position the page at the very first sentence right now, rather than
    // waiting for the first HIGHLIGHT_SENTENCE round-trip -- that depends on
    // TTS synthesis finishing (a second or more of backend latency), during
    // which the page could load further content and the eventual scroll
    // would visibly race to catch up. Doing it here means there's exactly
    // one deliberate scroll at session start, immediately.
    const firstSentence = result.units[0]?.sentences[0] ?? null;
    if (firstSentence) {
      try {
        await activeExtractor.ensureVisible(firstSentence);
      } catch (err) {
        log.warn('initial ensureVisible failed', err);
      }
    }

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
 * @param {number} requestId - value captured at the top of the
 *   handleHighlightSentence() call being checked
 * @returns {boolean} true if a newer HIGHLIGHT_SENTENCE has started since,
 *   meaning this call is superseded and must not touch shared state
 */
function isStaleHighlightRequest(requestId) {
  return requestId !== highlightRequestSeq;
}

/**
 * The §10 highlight/fallback protocol.
 * @param {import('../shared/types.js').HighlightSentencePayload} payload
 */
async function handleHighlightSentence(payload) {
  const requestId = ++highlightRequestSeq;
  const sentence = sentenceMap.get(payload.sentenceId);
  const widget = await getWidget();

  if (!sentence || !activeExtractor) {
    // Superseded while awaiting the widget module: a newer request already
    // owns activeHighlightId, so leave it alone and skip HIGHLIGHT_RESULT
    // entirely -- background/session.js's handler is a diagnostic sink, not
    // a per-request handshake, so silently no-op-ing here is safe.
    if (isStaleHighlightRequest(requestId)) return;
    await clearActiveHighlight();
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

    // ensureVisible()/resolveAnchor() together can take anywhere from
    // near-instant to multiple seconds (extractor-dependent). If a later
    // HIGHLIGHT_SENTENCE has already resolved and become the active one
    // while we were awaiting those, we are stale: bail out now, before
    // touching the highlighter, activeHighlightId, or sending a result --
    // the newer request already did all of that correctly, and clearing or
    // re-highlighting on its behalf would be a visible backward jump.
    if (isStaleHighlightRequest(requestId)) return;

    if (anchor) {
      const highlighter = await getHighlighter();
      if (isStaleHighlightRequest(requestId)) return;
      // Nothing else clears the previous sentence's highlight, so without
      // this every read sentence would stay lit for the whole session.
      if (activeHighlightId && activeHighlightId !== payload.sentenceId) {
        highlighter?.clear?.(activeHighlightId);
      }
      await highlighter?.apply?.(anchor, {
        sentenceId: payload.sentenceId,
        style: currentSettings.highlightStyle,
      });
      // apply() is itself async and can race the same way; re-check right
      // before claiming ownership so a stale apply() never overwrites the
      // newer highlight it just finished painting over.
      if (isStaleHighlightRequest(requestId)) return;
      activeHighlightId = payload.sentenceId;
      await safeSendRuntimeMessage(
        makeEnvelope(MSG.HIGHLIGHT_RESULT, TARGET.BACKGROUND, sessionId, {
          sentenceId: payload.sentenceId,
          index: payload.index,
          ok: true,
        })
      );
    } else {
      await clearActiveHighlight();
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
    if (isStaleHighlightRequest(requestId)) return;
    await clearActiveHighlight();
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

/** Clear whatever highlight is currently applied, if any. */
async function clearActiveHighlight() {
  if (!activeHighlightId) return;
  const highlighter = await getHighlighter();
  highlighter?.clear?.(activeHighlightId);
  activeHighlightId = null;
}

async function handleClearHighlight(payload) {
  const highlighter = await getHighlighter();
  highlighter?.clear?.(payload?.sentenceId);
  if (payload?.sentenceId == null || payload.sentenceId === activeHighlightId) {
    activeHighlightId = null;
  }
}

/**
 * A short, locator-free preview of the sentences just ahead of the current
 * cursor, for the widget's click-to-seek list. Scans sentenceMap the same
 * way assignIndicesAndStrip() builds its locator-free copies -- the
 * locator never leaves this file. The window starts strictly AFTER
 * fromIndex, so the sentence currently playing is never included.
 * @param {number} fromIndex - PlaybackState.index (may be -1 when idle)
 * @returns {Array<{index:number, text:string}>}
 */
function computeUpcomingSentences(fromIndex) {
  const upcoming = [];
  for (const sentence of sentenceMap.values()) {
    if (sentence.index > fromIndex && sentence.index <= fromIndex + UPCOMING_WINDOW_SIZE) {
      upcoming.push({ index: sentence.index, text: sentence.text });
    }
  }
  upcoming.sort((a, b) => a.index - b.index);
  return upcoming;
}

async function forwardToWidget(type, payload) {
  const widget = await getWidget();
  if (type === MSG.PLAYBACK_STATE && payload) {
    // Build a new object rather than mutating the incoming payload -- it's
    // the same object env.payload handed to this call, and other callers
    // further down onRuntimeMessage's switch (or a future one) must not see
    // an `upcoming` field they didn't ask for grafted onto their reference.
    const upcoming = computeUpcomingSentences(payload.index ?? -1);
    widget?.onMessage?.(type, { ...payload, upcoming });
    return;
  }
  widget?.onMessage?.(type, payload);
}

/**
 * Single content-side message endpoint. Routes background -> content
 * messages declared in shared_contracts §3.
 */
function onRuntimeMessage(env, _sender, _sendResponse) {
  if (!isForTarget(env, TARGET.CONTENT)) return undefined;

  // ACTIVATE is what *establishes* the current session (each toolbar click
  // mints a fresh sessionId), so it must never be dropped by the stale-session
  // filter below — otherwise the second and every subsequent activation of a
  // tab would be silently ignored.
  if (
    env.type !== MSG.ACTIVATE &&
    env.sessionId != null &&
    sessionId != null &&
    env.sessionId !== sessionId
  ) {
    return undefined;
  }

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
    case MSG.SESSION_ENDED:
      clearActiveHighlight();
      forwardToWidget(env.type, env.payload);
      break;
    case MSG.PLAYBACK_STATE:
    case MSG.RESUME_AVAILABLE:
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
  activeHighlightId = null;
  // Synchronous best-effort: only possible if the module was already loaded
  // (pagehide gives us no time to await a dynamic import).
  highlighterModule?.clearAll?.();
  // The widget must disappear on teardown (SPA navigation / pagehide), not
  // just on SESSION_ENDED — see src/content/ui/widget.js module doc. This is
  // a no-op if the widget was never mounted (widgetModule.unmount() only
  // acts on an existing singleton, never creates one). handleActivate()
  // always calls teardown() before mounting a fresh widget, so this never
  // races the next mount — mount()/unmount() are independent, idempotent.
  widgetModule?.unmount?.();
}

function watchForSpaNavigation() {
  // X/Twitter is a pushState SPA. checkUrl only ever runs from the patched
  // pushState below and the popstate listener, so ordinary same-document
  // scroll/hash-only DOM activity (which fires neither) can't trigger this;
  // it only reacts to an actual location.href change, i.e. a real navigation.
  const checkUrl = () => {
    if (location.href !== lastUrl) {
      const previousUrl = lastUrl;
      lastUrl = location.href;
      log.debug('SPA navigation detected', { from: previousUrl, to: lastUrl });

      // Local teardown alone only clears this content script's own state;
      // the background session (session.js) has no other way to learn the
      // view it's reading just disappeared. Tell it via the same CONTROL_STOP
      // the widget's Stop button sends, so it ends the session the normal
      // way (SESSION_ENDED/CLEAR_HIGHLIGHT flow back as usual) instead of
      // being left running against a torn-down view. No-op background-side
      // if there's no active session (or it belongs to a different tab).
      if (sessionId) {
        sendControl(MSG.CONTROL_STOP);
      }

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

/**
 * Keep `currentSettings` fresh mid-session. Mutated IN PLACE because
 * extractors hold a reference to the very object handed to init(ctx) and
 * re-read it on each call (see article.js `this._settings`), so an in-place
 * update is what makes a live autoScroll toggle actually take effect.
 */
function watchSettings() {
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const change = changes[SETTINGS_KEY];
      if (!change || !change.newValue) return;
      Object.assign(currentSettings, change.newValue);
    });
  } catch (err) {
    log.debug('could not subscribe to settings changes', err);
  }
}

function boot() {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  watchSettings();
  window.addEventListener('pagehide', teardown);
  watchForSpaNavigation();
  announceContentReady();
  log.debug('content main booted', { url: location.href });
}

boot();
