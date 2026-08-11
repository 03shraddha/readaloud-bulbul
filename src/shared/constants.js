/**
 * src/shared/constants.js
 *
 * Single source of truth for every tunable/default in shared_contracts §11.
 * No task may hardcode any of these values — import from here instead.
 */

// --- Backend ---
export const DEFAULT_BACKEND_BASE_URL = 'http://localhost:8787';
export const SYNTH_PATH = '/v1/synthesize';
export const SYNTH_BATCH_PATH = '/v1/synthesize/batch';
export const HEALTH_PATH = '/v1/health';
export const VOICES_PATH = '/v1/voices';

// --- Text ---
export const MAX_SENTENCE_CHARS = 900;
export const BULBUL_MAX_CHARS = 2500;

// --- Audio pipeline ---
export const PREFETCH_AHEAD = 3;
export const TTS_CONCURRENCY = 2;
export const TICK_INTERVAL_MS = 250;

// --- Persistence ---
export const PROGRESS_SAVE_DEBOUNCE_MS = 2000;
export const MAX_PROGRESS_ENTRIES = 200;
// How long a chrome.storage.local session snapshot (ra.session) stays
// eligible for lazy service-worker-restart recovery before it's treated as
// stale and discarded. See src/background/session.js recoverSessionForTab().
export const SESSION_SNAPSHOT_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Extraction ---
export const EXTRACT_MORE_TIMEOUT_MS = 8000;

// --- Playback rate options ---
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

// --- Languages / voice ---
export const SUPPORTED_LANGUAGES = [
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
];
export const DEFAULT_SPEAKER = 'simran';

// --- X / Twitter autoscroll pacing ---
export const X_AUTOSCROLL_STEP_PX = 600;
export const X_AUTOSCROLL_MIN_INTERVAL_MS = 1200;
export const X_MAX_UNITS_PER_BATCH = 25;

// --- Offscreen document ---
export const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

// --- Widget / highlight UI ---
export const SHADOW_ROOT_ID = 'boyle-root';
export const WIDGET_Z_INDEX = 2147483000;
export const GRADIENT_FROM = '#2F6BFF';
export const GRADIENT_TO = '#FF8A34';
