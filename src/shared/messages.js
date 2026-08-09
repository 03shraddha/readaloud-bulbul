/**
 * src/shared/messages.js
 *
 * THE message contract module. Read-only for every task except foundation.
 * Every runtime (content, background, offscreen) imports `MSG` and the
 * envelope helpers from here instead of hardcoding string literals.
 *
 * See shared_contracts §2 (envelope) and §3 (catalog).
 */

/** @type {{BACKGROUND:'background', CONTENT:'content', OFFSCREEN:'offscreen'}} */
export const TARGET = Object.freeze({
  BACKGROUND: 'background',
  CONTENT: 'content',
  OFFSCREEN: 'offscreen',
});

/**
 * Full message-name catalog. Grouped by direction in comments for
 * readability; the exported object is flat.
 */
export const MSG = Object.freeze({
  // --- content -> background ---
  CONTENT_READY: 'CONTENT_READY',
  START_READING: 'START_READING',
  APPEND_UNITS: 'APPEND_UNITS',
  CONTROL_PLAY: 'CONTROL_PLAY',
  CONTROL_PAUSE: 'CONTROL_PAUSE',
  CONTROL_TOGGLE: 'CONTROL_TOGGLE',
  CONTROL_STOP: 'CONTROL_STOP',
  CONTROL_SKIP: 'CONTROL_SKIP',
  CONTROL_SEEK: 'CONTROL_SEEK',
  CONTROL_SET_RATE: 'CONTROL_SET_RATE',
  CONTROL_SET_OPTION: 'CONTROL_SET_OPTION',
  REQUEST_STATE: 'REQUEST_STATE',
  HIGHLIGHT_RESULT: 'HIGHLIGHT_RESULT',
  RESUME_DECISION: 'RESUME_DECISION',

  // --- background -> content ---
  ACTIVATE: 'ACTIVATE',
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_ENDED: 'SESSION_ENDED',
  PLAYBACK_STATE: 'PLAYBACK_STATE',
  HIGHLIGHT_SENTENCE: 'HIGHLIGHT_SENTENCE',
  CLEAR_HIGHLIGHT: 'CLEAR_HIGHLIGHT',
  REQUEST_MORE_UNITS: 'REQUEST_MORE_UNITS',
  RESUME_AVAILABLE: 'RESUME_AVAILABLE',
  TOAST: 'TOAST',

  // --- background -> offscreen ---
  OFFSCREEN_INIT: 'OFFSCREEN_INIT',
  SENTENCE_AUDIO_READY: 'SENTENCE_AUDIO_READY',
  AUDIO_PLAY: 'AUDIO_PLAY',
  AUDIO_PAUSE: 'AUDIO_PAUSE',
  AUDIO_STOP: 'AUDIO_STOP',
  AUDIO_SET_RATE: 'AUDIO_SET_RATE',
  AUDIO_FLUSH: 'AUDIO_FLUSH',

  // --- offscreen -> background ---
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  SENTENCE_STARTED: 'SENTENCE_STARTED',
  SENTENCE_ENDED: 'SENTENCE_ENDED',
  PLAYBACK_TICK: 'PLAYBACK_TICK',
  QUEUE_DRAINED: 'QUEUE_DRAINED',
  BUFFER_LOW: 'BUFFER_LOW',
  PLAYBACK_ERROR: 'PLAYBACK_ERROR',
});

/**
 * Build a standard message envelope.
 * @param {string} type - one of MSG.*
 * @param {'background'|'content'|'offscreen'} target
 * @param {string|null} sessionId
 * @param {object} [payload]
 * @returns {{type:string, target:string, sessionId:string|null, payload:object}}
 */
export function makeEnvelope(type, target, sessionId, payload = {}) {
  return { type, target, sessionId: sessionId ?? null, payload };
}

/**
 * Guard used at the top of every onMessage listener:
 *   if (!isForTarget(env, TARGET.OFFSCREEN)) return;
 * @param {{target?:string}} env
 * @param {string} target
 * @returns {boolean}
 */
export function isForTarget(env, target) {
  return !!env && env.target === target;
}

const IGNORABLE_ERROR_SUBSTRINGS = [
  'Receiving end does not exist',
  'The message port closed before a response was received',
  'Could not establish connection',
  'Extension context invalidated',
];

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isIgnorableSendError(err) {
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  return IGNORABLE_ERROR_SUBSTRINGS.some((s) => message.includes(s));
}

/**
 * Fire-and-forget chrome.runtime.sendMessage that swallows the well-known
 * "no receiver" family of errors. Safe to call from content or offscreen.
 * @param {object} envelope
 * @returns {Promise<any|undefined>}
 */
export async function safeSendRuntimeMessage(envelope) {
  try {
    return await chrome.runtime.sendMessage(envelope);
  } catch (err) {
    if (isIgnorableSendError(err)) return undefined;
    throw err;
  }
}

/**
 * Fire-and-forget chrome.tabs.sendMessage that swallows the well-known
 * "no receiver" family of errors. Safe to call from the background worker.
 * @param {number} tabId
 * @param {object} envelope
 * @returns {Promise<any|undefined>}
 */
export async function safeSendTabMessage(tabId, envelope) {
  try {
    return await chrome.tabs.sendMessage(tabId, envelope);
  } catch (err) {
    if (isIgnorableSendError(err)) return undefined;
    throw err;
  }
}
