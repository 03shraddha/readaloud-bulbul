/**
 * src/content/ui/widget-styles.js
 *
 * CSS injected into the widget's own Shadow DOM root (#boyle-root, see
 * SHADOW_ROOT_ID). Fully self-contained visual identity: blue -> orange
 * gradient (GRADIENT_FROM/GRADIENT_TO) for the circular progress ring and
 * active accents, no external fonts/assets, respects prefers-color-scheme
 * and prefers-reduced-motion. No Sarvam name/logo/wordmark/monogram
 * anywhere.
 *
 * Also exports `getResumeBannerStyles()` for the small standalone
 * "Resume reading?" banner (its own Shadow DOM root, separate from the full
 * player widget — see widget.js `createResumeBanner`). It shares the same
 * color palette / `:host` variables so the two feel like one visual system
 * even though they never mount at the same time in the same tree.
 */

import { GRADIENT_FROM, GRADIENT_TO, WIDGET_Z_INDEX } from '../../shared/constants.js';

const HOST_VARIABLES_CSS = `
  color-scheme: light dark;
  --boyle-grad-from: ${GRADIENT_FROM};
  --boyle-grad-to: ${GRADIENT_TO};
  --boyle-bg: #ffffff;
  --boyle-bg-elevated: #f4f5f7;
  --boyle-text: #14161a;
  --boyle-text-muted: #5b616e;
  --boyle-border: rgba(20, 22, 26, 0.1);
  --boyle-shadow: 0 8px 30px rgba(20, 22, 26, 0.18), 0 1px 2px rgba(20, 22, 26, 0.1);
  --boyle-danger: #d1483f;
  --boyle-warn: #b5730a;
  --boyle-info: #2F6BFF;
`;

const HOST_VARIABLES_DARK_CSS = `
  --boyle-bg: #1c1e24;
  --boyle-bg-elevated: #262932;
  --boyle-text: #f2f3f5;
  --boyle-text-muted: #a7abb6;
  --boyle-border: rgba(255, 255, 255, 0.12);
  --boyle-shadow: 0 8px 30px rgba(0, 0, 0, 0.45), 0 1px 2px rgba(0, 0, 0, 0.4);
`;

export function getWidgetStyles() {
  return `
:host {
  all: initial;
  position: fixed;
  z-index: ${WIDGET_Z_INDEX};
  top: auto;
  left: auto;
  right: 20px;
  bottom: 20px;
  display: block;
${HOST_VARIABLES_CSS}}

@media (prefers-color-scheme: dark) {
  :host {
${HOST_VARIABLES_DARK_CSS}  }
}

* {
  box-sizing: border-box;
}

.boyle-widget {
  width: 320px;
  max-width: calc(100vw - 24px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: var(--boyle-text);
  background: var(--boyle-bg);
  border: 1px solid var(--boyle-border);
  border-radius: 14px;
  box-shadow: var(--boyle-shadow);
  overflow: hidden;
  pointer-events: auto;
  user-select: none;
}

.boyle-widget[hidden] {
  display: none !important;
}

.boyle-widget--minimized .boyle-body {
  display: none;
}

/* ---- Header / drag handle ---- */
.boyle-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: grab;
  background: var(--boyle-bg-elevated);
  border-bottom: 1px solid var(--boyle-border);
  touch-action: none;
}

.boyle-header:active {
  cursor: grabbing;
}

.boyle-grip {
  display: flex;
  color: var(--boyle-text-muted);
  flex: 0 0 auto;
}

.boyle-title {
  flex: 1 1 auto;
  font-weight: 600;
  font-size: 12.5px;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.boyle-icon-btn {
  all: unset;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--boyle-text-muted);
  cursor: pointer;
  flex: 0 0 auto;
}

.boyle-icon-btn:hover {
  background: var(--boyle-border);
  color: var(--boyle-text);
}

.boyle-icon-btn:focus-visible {
  outline: 2px solid var(--boyle-grad-from);
  outline-offset: 1px;
}

.boyle-icon-btn[aria-pressed="true"],
.boyle-icon-btn.is-active {
  color: var(--boyle-grad-from);
}

/* ---- Body ---- */
.boyle-body {
  padding: 10px 12px 12px;
  user-select: text;
}

.boyle-status-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.boyle-unit-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--boyle-grad-from);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.boyle-status-pill {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--boyle-text-muted);
  text-transform: capitalize;
  flex: 0 0 auto;
}

.boyle-preview {
  min-height: 2.8em;
  max-height: 5.6em;
  overflow-y: auto;
  font-size: 13px;
  color: var(--boyle-text);
  margin-bottom: 10px;
}

.boyle-preview--fallback {
  font-style: italic;
  color: var(--boyle-text-muted);
}

.boyle-preview--fallback::after {
  content: " (preview — not visible on page)";
  font-style: normal;
  font-size: 10.5px;
  opacity: 0.8;
}

.boyle-preview:empty::before {
  content: "Nothing playing yet.";
  color: var(--boyle-text-muted);
}

/* ---- Progress ring ---- */
.boyle-progress-row {
  display: flex;
  justify-content: center;
  margin-bottom: 10px;
}

.boyle-progress-ring-wrap {
  position: relative;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
}

.boyle-progress-ring {
  position: absolute;
  inset: 0;
  transform: rotate(-90deg);
}

.boyle-progress-ring-track {
  fill: none;
  stroke: var(--boyle-border);
  stroke-width: 4;
}

.boyle-progress-ring-fill {
  fill: none;
  stroke: url(#boyle-ring-gradient);
  stroke-width: 4;
  stroke-linecap: round;
  transition: stroke-dashoffset 160ms ease-out;
}

.boyle-progress-ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8.5px;
  font-weight: 700;
  color: var(--boyle-text-muted);
  white-space: nowrap;
  pointer-events: none;
}

/* ---- Controls ---- */
.boyle-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.boyle-controls .boyle-icon-btn {
  width: 30px;
  height: 30px;
}

.boyle-play-btn {
  width: 36px !important;
  height: 36px !important;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--boyle-grad-from), var(--boyle-grad-to));
  color: #fff !important;
}

.boyle-play-btn:hover {
  filter: brightness(1.08);
  background: linear-gradient(135deg, var(--boyle-grad-from), var(--boyle-grad-to));
}

.boyle-spacer {
  flex: 1 1 auto;
}

.boyle-rate-btn {
  all: unset;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--boyle-text-muted);
  border: 1px solid var(--boyle-border);
  border-radius: 8px;
  padding: 4px 7px;
  min-width: 40px;
  text-align: center;
}

.boyle-rate-btn:hover {
  color: var(--boyle-text);
  border-color: var(--boyle-grad-from);
}

/* ---- Settings popover ---- */
.boyle-popover-wrap {
  position: relative;
}

.boyle-settings-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 220px;
  background: var(--boyle-bg);
  border: 1px solid var(--boyle-border);
  border-radius: 10px;
  box-shadow: var(--boyle-shadow);
  padding: 8px 10px;
  z-index: 1;
}

.boyle-settings-popover[hidden] {
  display: none;
}

.boyle-settings-title {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--boyle-text-muted);
  margin: 2px 0 8px;
}

.boyle-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 0;
  cursor: pointer;
}

.boyle-setting-row span {
  font-size: 12px;
}

.boyle-switch {
  position: relative;
  width: 32px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--boyle-border);
  transition: background 120ms ease;
}

.boyle-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  transition: transform 120ms ease;
}

.boyle-setting-row[data-checked="true"] .boyle-switch {
  background: linear-gradient(90deg, var(--boyle-grad-from), var(--boyle-grad-to));
}

.boyle-setting-row[data-checked="true"] .boyle-switch::after {
  transform: translateX(14px);
}

.boyle-setting-row input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  pointer-events: none;
}

/* ---- Toasts ---- */
.boyle-toasts {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}

.boyle-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--boyle-bg);
  border: 1px solid var(--boyle-border);
  box-shadow: var(--boyle-shadow);
  font-size: 12px;
  animation: boyle-toast-in 160ms ease-out;
}

.boyle-toast .boyle-toast-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

.boyle-toast--info .boyle-toast-icon {
  color: var(--boyle-info);
}

.boyle-toast--warn .boyle-toast-icon {
  color: var(--boyle-warn);
}

.boyle-toast--error .boyle-toast-icon {
  color: var(--boyle-danger);
}

@keyframes boyle-toast-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .boyle-progress-ring-fill,
  .boyle-switch,
  .boyle-switch::after,
  .boyle-toast {
    transition: none !important;
    animation: none !important;
  }
}
`;
}

/**
 * Styles for the small standalone "Resume reading?" banner (its own Shadow
 * DOM root — see widget.js `createResumeBanner`). Deliberately NOT the
 * `.boyle-widget` card: smaller, no header/drag-handle/controls, so it
 * reads as a lightweight prompt rather than the full player.
 */
export function getResumeBannerStyles() {
  return `
:host {
  all: initial;
  position: fixed;
  z-index: ${WIDGET_Z_INDEX};
  top: auto;
  left: auto;
  right: 20px;
  bottom: 20px;
  display: block;
${HOST_VARIABLES_CSS}}

@media (prefers-color-scheme: dark) {
  :host {
${HOST_VARIABLES_DARK_CSS}  }
}

* {
  box-sizing: border-box;
}

.boyle-resume-banner {
  position: relative;
  width: 260px;
  max-width: calc(100vw - 24px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: var(--boyle-text);
  background: var(--boyle-bg);
  border: 1px solid var(--boyle-border);
  border-radius: 12px;
  box-shadow: var(--boyle-shadow);
  padding: 12px 14px;
  pointer-events: auto;
  user-select: none;
}

.boyle-resume-banner-close {
  all: unset;
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--boyle-text-muted);
  cursor: pointer;
}

.boyle-resume-banner-close:hover {
  background: var(--boyle-border);
  color: var(--boyle-text);
}

.boyle-resume-banner-close:focus-visible {
  outline: 2px solid var(--boyle-grad-from);
  outline-offset: 1px;
}

.boyle-resume-banner-title {
  font-weight: 600;
  font-size: 12.5px;
  padding-right: 20px;
  margin-bottom: 4px;
}

.boyle-resume-banner-preview {
  color: var(--boyle-text-muted);
  font-size: 12px;
  margin-bottom: 10px;
  max-height: 3.6em;
  overflow: hidden;
  text-overflow: ellipsis;
}

.boyle-resume-banner-actions {
  display: flex;
  gap: 8px;
}

.boyle-btn {
  all: unset;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 8px;
  text-align: center;
  flex: 1 1 auto;
}

.boyle-btn--primary {
  color: #fff;
  background: linear-gradient(135deg, var(--boyle-grad-from), var(--boyle-grad-to));
}

.boyle-btn--secondary {
  color: var(--boyle-text);
  background: transparent;
  border: 1px solid var(--boyle-border);
}

.boyle-btn:focus-visible {
  outline: 2px solid var(--boyle-grad-from);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .boyle-resume-banner * {
    transition: none !important;
    animation: none !important;
  }
}
`;
}

export default getWidgetStyles;
