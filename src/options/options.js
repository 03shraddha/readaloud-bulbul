/**
 * src/options/options.js
 *
 * Standalone settings page. Reads/writes `ra.settings` directly through
 * src/shared/storage.js (getSettings/patchSettings) — this page runs with no
 * live playback session, so there is no CONTROL_SET_OPTION receiver to talk
 * to and no risk of racing a background-owned write during a session; per
 * shared_contracts §7 storage.js is exposed from `shared/` specifically so
 * this page can read (and, here, write) settings directly.
 *
 * Never hardcodes a value that exists as a shared constant — languages,
 * rates, the health endpoint path, and the gradient colors all come from
 * src/shared/constants.js.
 */

import { getSettings, patchSettings } from '../shared/storage.js';
import { PROGRESS_INDEX_KEY } from '../shared/keys.js';
import {
  RATES,
  SUPPORTED_LANGUAGES,
  DEFAULT_SPEAKER,
  HEALTH_PATH,
  VOICES_PATH,
  GRADIENT_FROM,
  GRADIENT_TO,
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('options');

// Prefix used by every per-content progress record (shared_contracts §7:
// `ra.progress.${contentKey}`). Deliberately includes the trailing dot so it
// can never accidentally match the sibling `ra.progressIndex` key.
const PROGRESS_KEY_PREFIX = 'ra.progress.';

// Human-friendly labels for the 11 Bulbul language codes. The *codes* come
// from SUPPORTED_LANGUAGES (the source of truth); this map only supplies
// display text and is safe to hardcode since it carries no contract meaning.
const LANGUAGE_LABELS = {
  'bn-IN': 'Bengali',
  'en-IN': 'English (India)',
  'gu-IN': 'Gujarati',
  'hi-IN': 'Hindi',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'mr-IN': 'Marathi',
  'od-IN': 'Odia',
  'pa-IN': 'Punjabi',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
};

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------

const els = {
  backendBaseUrl: document.getElementById('backendBaseUrl'),
  testConnectionBtn: document.getElementById('testConnectionBtn'),
  connectionStatus: document.getElementById('connectionStatus'),
  rate: document.getElementById('rate'),
  languageCode: document.getElementById('languageCode'),
  speaker: document.getElementById('speaker'),
  speakerOptions: document.getElementById('speakerOptions'),
  pace: document.getElementById('pace'),
  paceReadout: document.getElementById('paceReadout'),
  temperature: document.getElementById('temperature'),
  temperatureReadout: document.getElementById('temperatureReadout'),
  highlightStyle: document.getElementById('highlightStyle'),
  autoScroll: document.getElementById('autoScroll'),
  skipPromoted: document.getElementById('skipPromoted'),
  announceRetweets: document.getElementById('announceRetweets'),
  progressCount: document.getElementById('progressCount'),
  clearProgressBtn: document.getElementById('clearProgressBtn'),
  clearProgressStatus: document.getElementById('clearProgressStatus'),
  saveStatus: document.getElementById('saveStatus'),
};

// ---------------------------------------------------------------------------
// Setup: gradient identity (values from constants.js, not hardcoded here)
// ---------------------------------------------------------------------------

function applyGradientIdentity() {
  document.documentElement.style.setProperty('--gradient-from', GRADIENT_FROM);
  document.documentElement.style.setProperty('--gradient-to', GRADIENT_TO);
}

// ---------------------------------------------------------------------------
// Populate static option lists
// ---------------------------------------------------------------------------

function populateRateOptions(selected) {
  els.rate.innerHTML = '';
  for (const r of RATES) {
    const opt = document.createElement('option');
    opt.value = String(r);
    opt.textContent = `${r}×`;
    if (r === selected) opt.selected = true;
    els.rate.appendChild(opt);
  }
}

function populateLanguageOptions(selected) {
  els.languageCode.innerHTML = '';
  for (const code of SUPPORTED_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${LANGUAGE_LABELS[code] || code} (${code})`;
    if (code === selected) opt.selected = true;
    els.languageCode.appendChild(opt);
  }
}

/** @param {string[]} speakers */
function populateSpeakerDatalist(speakers) {
  els.speakerOptions.innerHTML = '';
  const unique = Array.from(new Set([DEFAULT_SPEAKER, ...speakers]));
  for (const s of unique) {
    const opt = document.createElement('option');
    opt.value = s;
    els.speakerOptions.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Load settings -> form
// ---------------------------------------------------------------------------

async function loadFormFromSettings() {
  const settings = await getSettings();

  els.backendBaseUrl.value = settings.backendBaseUrl;
  populateRateOptions(settings.rate);
  populateLanguageOptions(settings.languageCode);
  els.speaker.value = settings.speaker;
  populateSpeakerDatalist([]);

  els.pace.value = String(settings.pace);
  els.paceReadout.textContent = Number(settings.pace).toFixed(2);

  els.temperature.value = String(settings.temperature);
  els.temperatureReadout.textContent = Number(settings.temperature).toFixed(2);

  els.highlightStyle.value = settings.highlightStyle;
  els.autoScroll.checked = !!settings.autoScroll;
  els.skipPromoted.checked = !!settings.skipPromoted;
  els.announceRetweets.checked = !!settings.announceRetweets;

  return settings;
}

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

let saveStatusTimer = null;

function flashSaveStatus(message, isError = false) {
  els.saveStatus.textContent = message;
  els.saveStatus.classList.toggle('is-error', isError);
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => {
    els.saveStatus.textContent = '';
  }, 2000);
}

/**
 * @param {Partial<import('../shared/types.js').Settings>} patch
 */
async function save(patch) {
  try {
    await patchSettings(patch);
    flashSaveStatus('Saved');
  } catch (err) {
    log.error('failed to save settings', err);
    flashSaveStatus('Could not save — see console', true);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireFormEvents() {
  els.backendBaseUrl.addEventListener('change', () => {
    const value = els.backendBaseUrl.value.trim() || els.backendBaseUrl.placeholder;
    els.backendBaseUrl.value = value;
    save({ backendBaseUrl: value });
  });

  els.rate.addEventListener('change', () => {
    save({ rate: Number(els.rate.value) });
  });

  els.languageCode.addEventListener('change', () => {
    save({ languageCode: els.languageCode.value });
  });

  els.speaker.addEventListener('change', () => {
    const value = els.speaker.value.trim() || DEFAULT_SPEAKER;
    els.speaker.value = value;
    save({ speaker: value });
  });

  els.pace.addEventListener('input', () => {
    els.paceReadout.textContent = Number(els.pace.value).toFixed(2);
  });
  els.pace.addEventListener('change', () => {
    save({ pace: Number(els.pace.value) });
  });

  els.temperature.addEventListener('input', () => {
    els.temperatureReadout.textContent = Number(els.temperature.value).toFixed(2);
  });
  els.temperature.addEventListener('change', () => {
    save({ temperature: Number(els.temperature.value) });
  });

  els.highlightStyle.addEventListener('change', () => {
    save({ highlightStyle: els.highlightStyle.value });
  });

  els.autoScroll.addEventListener('change', () => {
    save({ autoScroll: els.autoScroll.checked });
  });

  els.skipPromoted.addEventListener('change', () => {
    save({ skipPromoted: els.skipPromoted.checked });
  });

  els.announceRetweets.addEventListener('change', () => {
    save({ announceRetweets: els.announceRetweets.checked });
  });

  els.testConnectionBtn.addEventListener('click', testConnection);
  els.clearProgressBtn.addEventListener('click', clearAllProgress);
}

// ---------------------------------------------------------------------------
// Test connection (GET /v1/health)
// ---------------------------------------------------------------------------

function setConnectionStatus(html, kind) {
  els.connectionStatus.innerHTML = html;
  els.connectionStatus.className = `status ${kind ? `status-${kind}` : ''}`.trim();
}

async function testConnection() {
  const base = (els.backendBaseUrl.value || els.backendBaseUrl.placeholder).trim().replace(/\/+$/, '');
  els.testConnectionBtn.disabled = true;
  setConnectionStatus('Checking&hellip;', 'pending');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${base}${HEALTH_PATH}`, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      setConnectionStatus(`Backend responded with HTTP ${res.status}`, 'error');
      return;
    }

    const body = await res.json();
    const badges = [];
    badges.push(body.ok ? badge('ok', 'ok') : badge('not ok', 'error'));
    badges.push(body.mock ? badge('mock', 'warn') : badge('live', 'ok'));
    badges.push(body.has_api_key ? badge('has API key', 'ok') : badge('no API key', 'warn'));
    setConnectionStatus(badges.join(' '), body.ok ? 'ok' : 'error');

    // Best-effort speaker suggestions, purely cosmetic — never blocks saving.
    tryPopulateVoices(base);
  } catch (err) {
    log.warn('health check failed', err);
    const message = err && err.name === 'AbortError' ? 'Timed out reaching backend' : 'Could not reach backend';
    setConnectionStatus(message, 'error');
  } finally {
    els.testConnectionBtn.disabled = false;
  }
}

function badge(text, kind) {
  return `<span class="badge badge-${kind}">${text}</span>`;
}

/** @param {string} base */
async function tryPopulateVoices(base) {
  try {
    const res = await fetch(`${base}${VOICES_PATH}`, { method: 'GET' });
    if (!res.ok) return;
    const body = await res.json();
    if (Array.isArray(body.speakers)) {
      populateSpeakerDatalist(body.speakers);
    }
  } catch (err) {
    log.debug('voices lookup skipped', err);
  }
}

// ---------------------------------------------------------------------------
// Clear all saved reading positions
// ---------------------------------------------------------------------------

async function countProgressEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(PROGRESS_KEY_PREFIX)).length;
}

async function refreshProgressCount() {
  const count = await countProgressEntries();
  els.progressCount.textContent =
    count === 0 ? 'No positions are currently saved.' : `${count} position${count === 1 ? '' : 's'} currently saved.`;
}

async function clearAllProgress() {
  els.clearProgressBtn.disabled = true;
  els.clearProgressStatus.textContent = '';
  try {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter((k) => k.startsWith(PROGRESS_KEY_PREFIX));
    keysToRemove.push(PROGRESS_INDEX_KEY);

    await chrome.storage.local.remove(keysToRemove);

    els.clearProgressStatus.textContent = 'All saved reading positions were cleared.';
    els.clearProgressStatus.classList.remove('is-error');
    await refreshProgressCount();
  } catch (err) {
    log.error('failed to clear progress', err);
    els.clearProgressStatus.textContent = 'Could not clear reading positions — see console.';
    els.clearProgressStatus.classList.add('is-error');
  } finally {
    els.clearProgressBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  applyGradientIdentity();
  await loadFormFromSettings();
  wireFormEvents();
  await refreshProgressCount();
}

boot();
