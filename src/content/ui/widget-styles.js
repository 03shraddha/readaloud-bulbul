/**
 * src/content/ui/widget-styles.js
 *
 * CSS injected into the widget's own Shadow DOM root (#cadence-root, see
 * SHADOW_ROOT_ID). Fully self-contained visual identity: blue -> orange
 * gradient (GRADIENT_FROM/GRADIENT_TO) for the progress bar and active
 * accents, no external fonts/assets, respects prefers-color-scheme and
 * prefers-reduced-motion. No Sarvam name/logo/wordmark/monogram anywhere.
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
  --cadence-grad-from: ${GRADIENT_FROM};
  --cadence-grad-to: ${GRADIENT_TO};
  --cadence-bg: #ffffff;
  --cadence-bg-elevated: #f4f5f7;
  --cadence-text: #14161a;
  --cadence-text-muted: #5b616e;
  --cadence-border: rgba(20, 22, 26, 0.1);
  --cadence-shadow: 0 8px 30px rgba(20, 22, 26, 0.18), 0 1px 2px rgba(20, 22, 26, 0.1);
  --cadence-danger: #d1483f;
  --cadence-warn: #b5730a;
  --cadence-info: #2F6BFF;
`;

const HOST_VARIABLES_DARK_CSS = `
  --cadence-bg: #1c1e24;
  --cadence-bg-elevated: #262932;
  --cadence-text: #f2f3f5;
  --cadence-text-muted: #a7abb6;
  --cadence-border: rgba(255, 255, 255, 0.12);
  --cadence-shadow: 0 8px 30px rgba(0, 0, 0, 0.45), 0 1px 2px rgba(0, 0, 0, 0.4);
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

.cadence-widget {
  width: 320px;
  max-width: calc(100vw - 24px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: var(--cadence-text);
  background: var(--cadence-bg);
  border: 1px solid var(--cadence-border);
  border-radius: 14px;
  box-shadow: var(--cadence-shadow);
  overflow: hidden;
  pointer-events: auto;
  user-select: none;
}

.cadence-widget[hidden] {
  display: none !important;
}

.cadence-widget--minimized .cadence-body {
  display: none;
}

/* ---- Header / drag handle ---- */
.cadence-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: grab;
  background: var(--cadence-bg-elevated);
  border-bottom: 1px solid var(--cadence-border);
  touch-action: none;
}

.cadence-header:active {
  cursor: grabbing;
}

.cadence-grip {
  display: flex;
  color: var(--cadence-text-muted);
  flex: 0 0 auto;
}

.cadence-title {
  flex: 1 1 auto;
  font-weight: 600;
  font-size: 12.5px;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cadence-icon-btn {
  all: unset;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--cadence-text-muted);
  cursor: pointer;
  flex: 0 0 auto;
}

.cadence-icon-btn:hover {
  background: var(--cadence-border);
  color: var(--cadence-text);
}

.cadence-icon-btn:focus-visible {
  outline: 2px solid var(--cadence-grad-from);
  outline-offset: 1px;
}

.cadence-icon-btn[aria-pressed="true"],
.cadence-icon-btn.is-active {
  color: var(--cadence-grad-from);
}

/* ---- Body ---- */
.cadence-body {
  padding: 10px 12px 12px;
  user-select: text;
}

.cadence-status-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.cadence-unit-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--cadence-grad-from);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cadence-status-pill {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--cadence-text-muted);
  text-transform: capitalize;
  flex: 0 0 auto;
}

.cadence-preview {
  min-height: 2.8em;
  max-height: 5.6em;
  overflow-y: auto;
  font-size: 13px;
  color: var(--cadence-text);
  margin-bottom: 10px;
}

.cadence-preview--fallback {
  font-style: italic;
  color: var(--cadence-text-muted);
}

.cadence-preview--fallback::after {
  content: " (preview — not visible on page)";
  font-style: normal;
  font-size: 10.5px;
  opacity: 0.8;
}

.cadence-preview:empty::before {
  content: "Nothing playing yet.";
  color: var(--cadence-text-muted);
}

/* ---- Progress ---- */
.cadence-progress-track {
  position: relative;
  height: 5px;
  border-radius: 3px;
  background: var(--cadence-border);
  overflow: hidden;
  margin-bottom: 4px;
}

.cadence-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--cadence-grad-from), var(--cadence-grad-to));
  transition: width 160ms ease-out;
}

.cadence-progress-text {
  font-size: 10.5px;
  color: var(--cadence-text-muted);
  text-align: right;
  margin-bottom: 10px;
}

/* ---- Controls ---- */
.cadence-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cadence-controls .cadence-icon-btn {
  width: 30px;
  height: 30px;
}

.cadence-play-btn {
  width: 36px !important;
  height: 36px !important;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--cadence-grad-from), var(--cadence-grad-to));
  color: #fff !important;
}

.cadence-play-btn:hover {
  filter: brightness(1.08);
  background: linear-gradient(135deg, var(--cadence-grad-from), var(--cadence-grad-to));
}

.cadence-spacer {
  flex: 1 1 auto;
}

.cadence-rate-btn {
  all: unset;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--cadence-text-muted);
  border: 1px solid var(--cadence-border);
  border-radius: 8px;
  padding: 4px 7px;
  min-width: 40px;
  text-align: center;
}

.cadence-rate-btn:hover {
  color: var(--cadence-text);
  border-color: var(--cadence-grad-from);
}

/* ---- Settings popover ---- */
.cadence-popover-wrap {
  position: relative;
}

.cadence-settings-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 220px;
  background: var(--cadence-bg);
  border: 1px solid var(--cadence-border);
  border-radius: 10px;
  box-shadow: var(--cadence-shadow);
  padding: 8px 10px;
  z-index: 1;
}

.cadence-settings-popover[hidden] {
  display: none;
}

.cadence-settings-title {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--cadence-text-muted);
  margin: 2px 0 8px;
}

.cadence-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 0;
  cursor: pointer;
}

.cadence-setting-row span {
  font-size: 12px;
}

.cadence-switch {
  position: relative;
  width: 32px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--cadence-border);
  transition: background 120ms ease;
}

.cadence-switch::after {
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

.cadence-setting-row[data-checked="true"] .cadence-switch {
  background: linear-gradient(90deg, var(--cadence-grad-from), var(--cadence-grad-to));
}

.cadence-setting-row[data-checked="true"] .cadence-switch::after {
  transform: translateX(14px);
}

.cadence-setting-row input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  pointer-events: none;
}

/* ---- Toasts ---- */
.cadence-toasts {
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

.cadence-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--cadence-bg);
  border: 1px solid var(--cadence-border);
  box-shadow: var(--cadence-shadow);
  font-size: 12px;
  animation: cadence-toast-in 160ms ease-out;
}

.cadence-toast .cadence-toast-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

.cadence-toast--info .cadence-toast-icon {
  color: var(--cadence-info);
}

.cadence-toast--warn .cadence-toast-icon {
  color: var(--cadence-warn);
}

.cadence-toast--error .cadence-toast-icon {
  color: var(--cadence-danger);
}

@keyframes cadence-toast-in {
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
  .cadence-progress-fill,
  .cadence-switch,
  .cadence-switch::after,
  .cadence-toast {
    transition: none !important;
    animation: none !important;
  }
}
`;
}

/**
 * Styles for the small standalone "Resume reading?" banner (its own Shadow
 * DOM root — see widget.js `createResumeBanner`). Deliberately NOT the
 * `.cadence-widget` card: smaller, no header/drag-handle/controls, so it
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

.cadence-resume-banner {
  position: relative;
  width: 260px;
  max-width: calc(100vw - 24px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: var(--cadence-text);
  background: var(--cadence-bg);
  border: 1px solid var(--cadence-border);
  border-radius: 12px;
  box-shadow: var(--cadence-shadow);
  padding: 12px 14px;
  pointer-events: auto;
  user-select: none;
}

.cadence-resume-banner-close {
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
  color: var(--cadence-text-muted);
  cursor: pointer;
}

.cadence-resume-banner-close:hover {
  background: var(--cadence-border);
  color: var(--cadence-text);
}

.cadence-resume-banner-close:focus-visible {
  outline: 2px solid var(--cadence-grad-from);
  outline-offset: 1px;
}

.cadence-resume-banner-title {
  font-weight: 600;
  font-size: 12.5px;
  padding-right: 20px;
  margin-bottom: 4px;
}

.cadence-resume-banner-preview {
  color: var(--cadence-text-muted);
  font-size: 12px;
  margin-bottom: 10px;
  max-height: 3.6em;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cadence-resume-banner-actions {
  display: flex;
  gap: 8px;
}

.cadence-btn {
  all: unset;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 8px;
  text-align: center;
  flex: 1 1 auto;
}

.cadence-btn--primary {
  color: #fff;
  background: linear-gradient(135deg, var(--cadence-grad-from), var(--cadence-grad-to));
}

.cadence-btn--secondary {
  color: var(--cadence-text);
  background: transparent;
  border: 1px solid var(--cadence-border);
}

.cadence-btn:focus-visible {
  outline: 2px solid var(--cadence-grad-from);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .cadence-resume-banner * {
    transition: none !important;
    animation: none !important;
  }
}
`;
}

export default getWidgetStyles;
