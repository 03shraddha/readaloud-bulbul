/**
 * src/offscreen/offscreen.js
 *
 * The offscreen document's single message endpoint (shared_contracts §2,
 * §3, §9). Loaded as `<script type="module">` by offscreen.html. Its only
 * job is:
 *  - filter chrome.runtime messages to env.target === 'offscreen'
 *  - announce OFFSCREEN_READY on load
 *  - translate background -> offscreen control messages into AudioQueue
 *    calls, and AudioQueue's internal events back into offscreen ->
 *    background messages
 *
 * All actual decode/queue/playback logic lives in ./audio-queue.js; this
 * file is intentionally thin.
 */

import { MSG, TARGET, makeEnvelope, isForTarget, safeSendRuntimeMessage } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';
import { createAudioQueue } from './audio-queue.js';

const log = createLogger('offscreen');

/** Current session, established by OFFSCREEN_INIT; null before the first init. */
let sessionId = null;

const elA = document.getElementById('bufA');
const elB = document.getElementById('bufB');

const queue = createAudioQueue({
  elA,
  elB,
  log: createLogger('offscreen:audio-queue'),
  onEvent(type, payload) {
    safeSendRuntimeMessage(makeEnvelope(type, TARGET.BACKGROUND, sessionId, payload));
  },
});

/** @param {{sessionId:string|null, payload:import('../shared/types.js').OffscreenInitPayload}} env */
function handleInit(env) {
  sessionId = env.sessionId ?? env.payload?.sessionId ?? null;
  queue.reset(env.payload?.rate, env.payload?.startIndex);
  log.debug('OFFSCREEN_INIT', {
    sessionId,
    rate: env.payload?.rate,
    startIndex: env.payload?.startIndex,
  });
}

/**
 * Single background -> offscreen message endpoint.
 * @param {{type:string,target:string,sessionId:string|null,payload:object}} env
 */
function onRuntimeMessage(env) {
  if (!isForTarget(env, TARGET.OFFSCREEN)) return undefined;

  // OFFSCREEN_INIT is what *establishes* the current session, so it must
  // never be filtered out by a stale sessionId check.
  if (
    env.type !== MSG.OFFSCREEN_INIT &&
    env.sessionId != null &&
    sessionId != null &&
    env.sessionId !== sessionId
  ) {
    log.debug('ignoring message for a stale session', env.type, env.sessionId);
    return undefined;
  }

  switch (env.type) {
    case MSG.OFFSCREEN_INIT:
      handleInit(env);
      break;
    case MSG.SENTENCE_AUDIO_READY:
      queue.enqueue(env.payload);
      break;
    case MSG.AUDIO_PLAY:
      queue.play();
      break;
    case MSG.AUDIO_PAUSE:
      queue.pause();
      break;
    case MSG.AUDIO_STOP:
      queue.stop();
      break;
    case MSG.AUDIO_SET_RATE:
      queue.setRate(env.payload?.rate);
      break;
    case MSG.AUDIO_FLUSH:
      queue.flush(env.payload?.fromIndex);
      break;
    default:
      log.debug('unhandled message', env.type);
  }
  return undefined;
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);

safeSendRuntimeMessage(makeEnvelope(MSG.OFFSCREEN_READY, TARGET.BACKGROUND, sessionId, {}));

log.debug('offscreen document booted');
