/**
 * src/content/ui/widget.js
 *
 * The floating player widget. `createWidget({onControl})` returns a small
 * API: { mount, unmount, render(playbackState), showTextFallback(text),
 * toast(level, msg), setPosition(p) }.
 *
 * The widget is a PURE render of PlaybackState (shared_contracts §4) — it
 * never keeps its own playback state. It attaches a Shadow DOM root
 * (#SHADOW_ROOT_ID) at WIDGET_Z_INDEX, is draggable by its header (pointer
 * events, position clamped to the viewport, position:fixed so it survives
 * scrolling, re-anchored on resize), and exposes play/pause, prev/next
 * sentence, a speed selector over RATES, stop, a progress bar, a sentence
 * text preview (doubling as the §10 unmounted-tweet fallback surface), and a
 * settings popover for autoScroll / skipPromoted / announceRetweets.
 *
 * Every control calls `onControl(controlType, payload)` with the exact
 * CONTROL_* shape from shared_contracts §3 — the caller (content/main.js) is
 * responsible for wrapping that into a message envelope and sending it to
 * the background.
 *
 * mount()/unmount() are the widget's whole visibility lifecycle: it "appears
 * on toolbar-icon activation and disappears on stop" (PRD). unmount() is
 * always synchronous/immediate — see the SESSION_ENDED handling below for
 * why a deferred unmount would be actively wrong.
 *
 * The resume offer ("Resume reading?") is a SEPARATE, much smaller component
 * — `createResumeBanner({onDecision})` — with its own Shadow DOM root. It is
 * NOT part of this widget's mount path: RESUME_AVAILABLE can arrive at
 * page-load time (persistence.handleContentReady(), before the user has
 * clicked anything), and offering to resume must never itself summon the
 * full player. Only an explicit user action — clicking "Resume" on the
 * banner, or a fresh toolbar-icon ACTIVATE — mounts the full widget.
 */

import { MSG, TARGET, makeEnvelope, safeSendRuntimeMessage } from '../../shared/messages.js';
import { SHADOW_ROOT_ID, WIDGET_Z_INDEX, RATES } from '../../shared/constants.js';
import { getWidgetStyles, getResumeBannerStyles } from './widget-styles.js';
import { ICONS } from './icons.js';

const DEFAULT_MARGIN_PX = 20;
const TOAST_TTL_MS = 4200;
const MAX_TOASTS = 3;

/** Shadow-DOM host id for the resume banner — deliberately distinct from
 * SHADOW_ROOT_ID (the full widget's), since the two are separate mount
 * paths that are never meant to be conflated. */
const RESUME_BANNER_ROOT_ID = 'boyle-resume-root';

function formatRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '1x';
  return `${Number.isInteger(n) ? n.toFixed(0) : n}x`;
}

function nearestRateIndex(rate) {
  let bestIdx = 0;
  let bestDelta = Infinity;
  RATES.forEach((r, i) => {
    const delta = Math.abs(r - rate);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = i;
    }
  });
  return bestIdx;
}

function defaultPlaybackState() {
  return {
    sessionId: null,
    status: 'idle',
    index: -1,
    sentenceId: null,
    unitId: null,
    unitLabel: null,
    currentText: '',
    totalSentences: 0,
    exhausted: false,
    rate: 1,
    queuedAhead: 0,
    contentKey: null,
    kind: null,
    error: null,
  };
}

function buildMarkup() {
  return `
<div class="boyle-toasts" data-role="toasts"></div>
<div class="boyle-header" data-role="header">
  <span class="boyle-grip">${ICONS.grip}</span>
  <span class="boyle-title" data-role="title">Boyle</span>
  <button type="button" class="boyle-icon-btn" data-action="settings" title="Settings" aria-haspopup="true" aria-expanded="false">${ICONS.gear}</button>
</div>
<div class="boyle-body" data-role="body">
  <div class="boyle-status-row">
    <span class="boyle-unit-label" data-role="unit-label"></span>
    <span class="boyle-status-pill" data-role="status-pill">idle</span>
  </div>
  <div class="boyle-preview" data-role="preview"></div>
  <div class="boyle-progress-track"><div class="boyle-progress-fill" data-role="progress-fill"></div></div>
  <div class="boyle-progress-text" data-role="progress-text">— / —</div>
  <div class="boyle-controls">
    <button type="button" class="boyle-icon-btn" data-action="prev" title="Previous sentence" aria-label="Previous sentence">${ICONS.previous}</button>
    <button type="button" class="boyle-icon-btn boyle-play-btn" data-action="toggle" title="Play / pause" aria-label="Play or pause">${ICONS.play}</button>
    <button type="button" class="boyle-icon-btn" data-action="next" title="Next sentence" aria-label="Next sentence">${ICONS.next}</button>
    <button type="button" class="boyle-icon-btn" data-action="stop" title="Stop" aria-label="Stop">${ICONS.stop}</button>
    <span class="boyle-spacer"></span>
    <button type="button" class="boyle-rate-btn" data-action="rate" title="Playback speed">1x</button>
  </div>
  <div class="boyle-popover-wrap">
    <div class="boyle-settings-popover" data-role="settings-popover" hidden>
      <div class="boyle-settings-title">Settings</div>
      <label class="boyle-setting-row" data-key="autoScroll" data-checked="true">
        <span>Auto-scroll</span>
        <span class="boyle-switch"></span>
        <input type="checkbox" data-toggle="autoScroll" checked />
      </label>
      <label class="boyle-setting-row" data-key="skipPromoted" data-checked="true">
        <span>Skip promoted</span>
        <span class="boyle-switch"></span>
        <input type="checkbox" data-toggle="skipPromoted" checked />
      </label>
      <label class="boyle-setting-row" data-key="announceRetweets" data-checked="true">
        <span>Announce retweets</span>
        <span class="boyle-switch"></span>
        <input type="checkbox" data-toggle="announceRetweets" checked />
      </label>
    </div>
  </div>
</div>
`;
}

/**
 * @param {{onControl?: (type:string, payload:object)=>void}} [callbacks]
 */
export function createWidget({ onControl } = {}) {
  let hostEl = null;
  let shadow = null;
  let refs = {};

  let lastState = defaultPlaybackState();
  let fallbackText = null; // last text passed to showTextFallback(); see updatePreview()
  let lastErrorCode = null;

  let position = null; // {x,y} in px, or null = default bottom-right
  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let dragOrigin = { x: 0, y: 0 };
  let settingsOpen = false;

  const toastTimers = new Set();

  function clampToViewport(pos) {
    if (!hostEl) return pos;
    const rect = hostEl.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    return {
      x: Math.min(Math.max(0, pos.x), maxX),
      y: Math.min(Math.max(0, pos.y), maxY),
    };
  }

  /**
   * @param {{x:number,y:number}|null} pos
   * @param {{persist?: boolean}} [opts]
   */
  function applyPosition(pos, { persist = false } = {}) {
    if (!hostEl) {
      position = pos && typeof pos.x === 'number' && typeof pos.y === 'number' ? pos : null;
      return;
    }

    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      const clamped = clampToViewport(pos);
      position = clamped;
      hostEl.style.left = `${clamped.x}px`;
      hostEl.style.top = `${clamped.y}px`;
      hostEl.style.right = 'auto';
      hostEl.style.bottom = 'auto';
    } else {
      position = null;
      hostEl.style.left = 'auto';
      hostEl.style.top = 'auto';
      hostEl.style.right = `${DEFAULT_MARGIN_PX}px`;
      hostEl.style.bottom = `${DEFAULT_MARGIN_PX}px`;
    }

    if (persist) {
      onControl?.(MSG.CONTROL_SET_OPTION, {
        key: 'widgetPosition',
        value: position ? { x: position.x, y: position.y } : { x: null, y: null },
      });
    }
  }

  function handleResize() {
    if (position) applyPosition(position, { persist: false });
  }

  function updatePreview() {
    const text = lastState?.currentText || '';
    refs.preview.textContent = text;
    const isFallback = fallbackText != null && text === fallbackText;
    refs.preview.classList.toggle('boyle-preview--fallback', isFallback);
  }

  function updateProgress() {
    const total = lastState?.totalSentences || 0;
    const idx = lastState?.index ?? -1;
    const pct = total > 0 && idx >= 0 ? Math.min(100, ((idx + 1) / total) * 100) : 0;
    refs.progressFill.style.width = `${pct}%`;
    refs.progressText.textContent = total > 0 && idx >= 0 ? `${idx + 1} / ${total}` : '— / —';
  }

  function updateControls() {
    const state = lastState;
    const hasSession = !!state.sessionId && state.index >= 0;

    refs.playBtn.innerHTML = state.status === 'playing' ? ICONS.pause : ICONS.play;
    refs.playBtn.setAttribute('aria-pressed', String(state.status === 'playing'));
    refs.playBtn.disabled = state.status === 'idle' && !state.sessionId;

    refs.prevBtn.disabled = !hasSession || state.index <= 0;
    refs.nextBtn.disabled = !hasSession;
    refs.stopBtn.disabled = state.status === 'idle';

    refs.rateBtn.textContent = formatRate(state.rate ?? 1);
    refs.statusPill.textContent = state.status;
    refs.unitLabel.textContent = state.unitLabel || '';
  }

  function maybeToastError(state) {
    const code = state?.error?.code ?? null;
    if (code && code !== lastErrorCode) {
      toast('error', state.error.message || 'Something went wrong.');
    }
    lastErrorCode = code;
  }

  /**
   * @param {import('../../shared/types.js').PlaybackState} state
   */
  function render(state) {
    if (!state) return;
    lastState = { ...defaultPlaybackState(), ...state };
    if (!hostEl) return; // not mounted yet; state is retained for the next mount()
    updatePreview();
    updateProgress();
    updateControls();
    maybeToastError(lastState);
  }

  /**
   * @param {string} text
   */
  function showTextFallback(text) {
    fallbackText = text ?? '';
    if (!hostEl) return;
    refs.preview.textContent = fallbackText;
    refs.preview.classList.add('boyle-preview--fallback');
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   */
  function toast(level, message) {
    if (!hostEl) return;
    const safeLevel = ['info', 'warn', 'error'].includes(level) ? level : 'info';
    const el = document.createElement('div');
    el.className = `boyle-toast boyle-toast--${safeLevel}`;
    const icon = safeLevel === 'info' ? ICONS.info : ICONS.warning;
    el.innerHTML = `<span class="boyle-toast-icon">${icon}</span><span class="boyle-toast-msg"></span>`;
    el.querySelector('.boyle-toast-msg').textContent = message ?? '';
    refs.toasts.appendChild(el);

    while (refs.toasts.children.length > MAX_TOASTS) {
      refs.toasts.removeChild(refs.toasts.firstChild);
    }

    const timer = setTimeout(() => {
      el.remove();
      toastTimers.delete(timer);
    }, TOAST_TTL_MS);
    toastTimers.add(timer);
  }

  /**
   * @param {{x:number|null,y:number|null}|null} pos
   */
  function setPosition(pos) {
    applyPosition(pos, { persist: false });
  }

  function handleDocumentPointerDown(e) {
    if (!settingsOpen) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(refs.settingsPopover) || path.includes(refs.settingsBtn)) return;
    closeSettings();
  }

  function closeSettings() {
    settingsOpen = false;
    refs.settingsPopover.hidden = true;
    refs.settingsBtn.setAttribute('aria-expanded', 'false');
  }

  function wireEvents() {
    refs.playBtn.addEventListener('click', () => onControl?.(MSG.CONTROL_TOGGLE, {}));
    refs.prevBtn.addEventListener('click', () =>
      onControl?.(MSG.CONTROL_SKIP, { direction: 'prev', granularity: 'sentence' })
    );
    refs.nextBtn.addEventListener('click', () =>
      onControl?.(MSG.CONTROL_SKIP, { direction: 'next', granularity: 'sentence' })
    );
    refs.stopBtn.addEventListener('click', () => onControl?.(MSG.CONTROL_STOP, {}));

    refs.rateBtn.addEventListener('click', () => {
      const idx = nearestRateIndex(lastState?.rate ?? 1);
      const next = RATES[(idx + 1) % RATES.length];
      refs.rateBtn.textContent = formatRate(next);
      onControl?.(MSG.CONTROL_SET_RATE, { rate: next });
    });

    refs.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsOpen = !settingsOpen;
      refs.settingsPopover.hidden = !settingsOpen;
      refs.settingsBtn.setAttribute('aria-expanded', String(settingsOpen));
    });

    refs.container.querySelectorAll('[data-toggle]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.toggle;
        const value = input.checked;
        const row = input.closest('.boyle-setting-row');
        if (row) row.dataset.checked = String(value);
        onControl?.(MSG.CONTROL_SET_OPTION, { key, value });
      });
    });

    refs.header.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('button')) return;
      dragging = true;
      const rect = hostEl.getBoundingClientRect();
      dragOrigin = { x: rect.left, y: rect.top };
      dragStart = { x: e.clientX, y: e.clientY };
      try {
        refs.header.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        refs.header.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      applyPosition(position, { persist: true });
    };

    refs.header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      applyPosition({ x: dragOrigin.x + dx, y: dragOrigin.y + dy }, { persist: false });
    });
    refs.header.addEventListener('pointerup', endDrag);
    refs.header.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', handleResize);
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  }

  function collectRefs(container) {
    const byRole = (role) => container.querySelector(`[data-role="${role}"]`);
    return {
      container,
      toasts: byRole('toasts'),
      header: byRole('header'),
      body: byRole('body'),
      unitLabel: byRole('unit-label'),
      statusPill: byRole('status-pill'),
      preview: byRole('preview'),
      progressFill: byRole('progress-fill'),
      progressText: byRole('progress-text'),
      prevBtn: container.querySelector('[data-action="prev"]'),
      playBtn: container.querySelector('[data-action="toggle"]'),
      nextBtn: container.querySelector('[data-action="next"]'),
      stopBtn: container.querySelector('[data-action="stop"]'),
      rateBtn: container.querySelector('[data-action="rate"]'),
      settingsBtn: container.querySelector('[data-action="settings"]'),
      settingsPopover: byRole('settings-popover'),
    };
  }

  function mount() {
    if (hostEl) return;

    hostEl = document.createElement('div');
    hostEl.id = SHADOW_ROOT_ID;
    hostEl.style.position = 'fixed';
    hostEl.style.zIndex = String(WIDGET_Z_INDEX);

    shadow = hostEl.attachShadow({ mode: 'closed' });

    const styleEl = document.createElement('style');
    styleEl.textContent = getWidgetStyles();
    shadow.appendChild(styleEl);

    const container = document.createElement('div');
    container.className = 'boyle-widget';
    container.innerHTML = buildMarkup();
    shadow.appendChild(container);

    refs = collectRefs(container);
    wireEvents();

    (document.documentElement || document.body).appendChild(hostEl);

    applyPosition(position, { persist: false });
    render(lastState);
    if (fallbackText != null) showTextFallback(fallbackText);
  }

  function unmount() {
    if (!hostEl) return;
    window.removeEventListener('resize', handleResize);
    document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    for (const timer of toastTimers) clearTimeout(timer);
    toastTimers.clear();
    hostEl.remove();
    hostEl = null;
    shadow = null;
    refs = {};
    settingsOpen = false;
  }

  return {
    mount,
    unmount,
    render,
    showTextFallback,
    toast,
    setPosition,
  };
}

// ---------------------------------------------------------------------------
// Resume banner — a separate, minimal, dismissible component with its own
// Shadow DOM root. Deliberately NOT `createWidget()`: mounting/showing this
// must never mount the full player (see module doc comment above).
// ---------------------------------------------------------------------------

function buildResumeBannerMarkup() {
  return `
<button type="button" class="boyle-resume-banner-close" data-action="close" aria-label="Dismiss">${ICONS.close}</button>
<div class="boyle-resume-banner-title">Resume reading?</div>
<div class="boyle-resume-banner-preview" data-role="preview"></div>
<div class="boyle-resume-banner-actions">
  <button type="button" class="boyle-btn boyle-btn--secondary" data-action="start-over">Start over</button>
  <button type="button" class="boyle-btn boyle-btn--primary" data-action="resume">Resume</button>
</div>
`;
}

/**
 * @param {{onDecision?: (decision:{accept:boolean,index:number})=>void}} [callbacks]
 */
function createResumeBanner({ onDecision } = {}) {
  let hostEl = null;
  let shadow = null;
  let refs = {};
  let payload = null;

  function unmount() {
    if (!hostEl) return;
    hostEl.remove();
    hostEl = null;
    shadow = null;
    refs = {};
  }

  function mount() {
    if (hostEl) return;

    hostEl = document.createElement('div');
    hostEl.id = RESUME_BANNER_ROOT_ID;
    hostEl.style.position = 'fixed';
    hostEl.style.zIndex = String(WIDGET_Z_INDEX);

    shadow = hostEl.attachShadow({ mode: 'closed' });

    const styleEl = document.createElement('style');
    styleEl.textContent = getResumeBannerStyles();
    shadow.appendChild(styleEl);

    const container = document.createElement('div');
    container.className = 'boyle-resume-banner';
    container.innerHTML = buildResumeBannerMarkup();
    shadow.appendChild(container);

    refs = {
      container,
      preview: container.querySelector('[data-role="preview"]'),
      resumeBtn: container.querySelector('[data-action="resume"]'),
      startOverBtn: container.querySelector('[data-action="start-over"]'),
      closeBtn: container.querySelector('[data-action="close"]'),
    };

    refs.resumeBtn.addEventListener('click', () => {
      const idx = payload?.index ?? 0;
      unmount();
      onDecision?.({ accept: true, index: idx });
    });
    refs.startOverBtn.addEventListener('click', () => {
      const idx = payload?.index ?? 0;
      unmount();
      onDecision?.({ accept: false, index: idx });
    });
    // A plain dismiss (the "x") is not a decision — it doesn't tell the
    // background anything, it just hides the offer for now. Unlike
    // "Start over" it does not decline the pending resume.
    refs.closeBtn.addEventListener('click', () => unmount());

    (document.documentElement || document.body).appendChild(hostEl);
    if (payload) refs.preview.textContent = payload.previewText || '';
  }

  /**
   * @param {import('../../shared/types.js').ResumeAvailablePayload|null} nextPayload
   */
  function show(nextPayload) {
    payload = nextPayload || null;
    if (!payload) {
      unmount();
      return;
    }
    mount();
    refs.preview.textContent = payload.previewText || '';
  }

  return { show, unmount };
}

// ---------------------------------------------------------------------------
// Backward-compatible default export.
//
// src/content/main.js (foundation) currently dynamic-imports this module and
// does `mod.default ?? mod`, then calls the result directly — e.g.
// `widget.showTextFallback(text)` and `widget.onMessage(type, payload)` — as
// if it were an already-constructed widget, rather than calling
// `createWidget(...)` itself. To keep that call site working without
// modifying main.js (out of scope for this task / owned by foundation), the
// default export is a lazily-mounted singleton wired to send CONTROL_*
// messages straight to the background, plus a small `onMessage(type,
// payload)` dispatcher for the background -> content messages main.js
// forwards verbatim (SESSION_STARTED, PLAYBACK_STATE, RESUME_AVAILABLE,
// SESSION_ENDED, TOAST).
//
// Two lifecycles are deliberately kept independent here:
//  - The full widget singleton only ever mounts via an explicit `mount()`
//    call (from main.js's ACTIVATE handler) or the resume banner's "Resume"
//    button — never as a side effect of merely receiving a message.
//  - `dispatchMessage` never calls `ensureSingleton()` for RESUME_AVAILABLE,
//    so a page load with saved progress cannot summon the full player.
//  - On SESSION_ENDED the singleton (if one exists) is unmounted
//    IMMEDIATELY, synchronously, in this same call — never deferred. That
//    matters because `prepareNewSession()` (background/session.js) ends the
//    outgoing session — sending SESSION_ENDED — *before* sending the next
//    ACTIVATE when the same tab is re-activated. ACTIVATE always does a
//    fresh, independent mount regardless of the widget's current state, so
//    there is no ordering dependency between the two — but a delayed
//    unmount here would race past that fresh mount and tear down the
//    just-remounted widget instead of the one that actually ended.
//
// `createWidget` remains the primary, spec-compliant export for any caller
// that wants to construct and own its own instance.
// ---------------------------------------------------------------------------

let trackedSessionId = null;
let trackedResumeContentKey = null;
let singleton = null;
let resumeBanner = null;

function sendControl(type, payload) {
  safeSendRuntimeMessage(makeEnvelope(type, TARGET.BACKGROUND, trackedSessionId, payload));
}

function sendResumeDecision({ accept, index }) {
  safeSendRuntimeMessage(
    makeEnvelope(MSG.RESUME_DECISION, TARGET.BACKGROUND, trackedSessionId, {
      contentKey: trackedResumeContentKey,
      accept,
      index,
    })
  );
  // A fresh Resume/Start-over decision means whatever banner offer this was
  // answering no longer applies to this page load.
  resumeBanner?.show(null);
}

/** Creates (mounting) the full player singleton if it doesn't exist yet. */
function ensureSingleton() {
  if (!singleton) {
    singleton = createWidget({ onControl: sendControl });
    singleton.mount();
  }
  return singleton;
}

/** Read-only access: never creates/mounts. Used where "if it exists" matters. */
function peekSingleton() {
  return singleton;
}

function ensureResumeBanner() {
  if (!resumeBanner) {
    resumeBanner = createResumeBanner({ onDecision: sendResumeDecision });
  }
  return resumeBanner;
}

function dispatchMessage(type, payload) {
  switch (type) {
    case MSG.SESSION_STARTED:
      trackedSessionId = payload?.sessionId ?? trackedSessionId;
      break;
    case MSG.PLAYBACK_STATE:
      trackedSessionId = payload?.sessionId ?? trackedSessionId;
      ensureSingleton().render(payload);
      break;
    case MSG.RESUME_AVAILABLE:
      // Deliberately NOT ensureSingleton(): showing a resume offer must
      // never mount the full player widget (see module + section doc above).
      trackedResumeContentKey = payload?.contentKey ?? trackedResumeContentKey;
      ensureResumeBanner().show(payload);
      break;
    case MSG.SESSION_ENDED: {
      // Immediate, synchronous unmount — see the block comment above for why
      // this must not be deferred.
      const widget = peekSingleton();
      if (widget) {
        widget.toast(
          payload?.reason === 'error' ? 'error' : 'info',
          payload?.message || `Session ended: ${payload?.reason ?? 'unknown'}`
        );
        widget.unmount();
      }
      break;
    }
    case MSG.TOAST:
      ensureSingleton().toast(payload?.level ?? 'info', payload?.message ?? '');
      break;
    default:
      break;
  }
}

const defaultExport = {
  mount: (...args) => ensureSingleton().mount(...args),
  // Never creates a widget just to immediately tear it down — if there's no
  // singleton, there's nothing mounted, so unmounting is already satisfied.
  //
  // This is content/main.js's teardown() entry point (pagehide, X/Twitter
  // pushState navigation, and the pre-mount teardown in handleActivate), and
  // teardown means "everything this content script put on the page goes
  // away". The resume banner lives in its own Shadow DOM root, outside the
  // full widget's singleton, so it has to be dismissed explicitly here —
  // otherwise a "Resume reading?" offer for the *previous* X view survives an
  // SPA navigation and answers with a now-stale contentKey. Dropping the
  // offer without sending a RESUME_DECISION is exactly what the banner's own
  // "x" button does, so the background is never left waiting on it.
  unmount: (...args) => {
    peekSingleton()?.unmount(...args);
    resumeBanner?.unmount();
  },
  render: (...args) => ensureSingleton().render(...args),
  showTextFallback: (...args) => ensureSingleton().showTextFallback(...args),
  toast: (...args) => ensureSingleton().toast(...args),
  setPosition: (...args) => ensureSingleton().setPosition(...args),
  /** Compatibility shim consumed by content/main.js's forwardToWidget(). */
  onMessage: (type, payload) => dispatchMessage(type, payload),
};

export default defaultExport;
