/**
 * src/content/ui/icons.js
 *
 * Inline SVG strings for the floating widget. Deliberately generic /
 * geometric — no wordmarks, no brand marks. Every icon is a self-contained
 * `<svg>` string sized on a 24x24 grid, `fill="currentColor"`, so callers can
 * drop them straight into innerHTML and control color via CSS `color`.
 */

const svg = (body, viewBox = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" fill="none" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  play: svg('<path d="M7 5.5v13a1 1 0 0 0 1.53.85l10.4-6.5a1 1 0 0 0 0-1.7l-10.4-6.5A1 1 0 0 0 7 5.5Z" fill="currentColor"/>'),

  pause: svg(
    '<rect x="6" y="5" width="4.5" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.2" fill="currentColor"/>'
  ),

  previous: svg(
    '<path d="M7 5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1 1 1 0 0 0 1-1v-12a1 1 0 0 0-1-1Z" fill="currentColor"/><path d="M18.53 5.15a1 1 0 0 0-1.03.06l-8.5 6a1 1 0 0 0 0 1.58l8.5 6A1 1 0 0 0 19 18v-12a1 1 0 0 0-.47-.85Z" fill="currentColor"/>'
  ),

  next: svg(
    '<path d="M17 5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1 1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" fill="currentColor"/><path d="M5.47 5.15a1 1 0 0 1 1.03.06l8.5 6a1 1 0 0 1 0 1.58l-8.5 6A1 1 0 0 1 5 18v-12a1 1 0 0 1 .47-.85Z" fill="currentColor"/>'
  ),

  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),

  gear: svg(
    '<path d="M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z" stroke="currentColor" stroke-width="1.6"/><path d="M19.4 13.75c.06-.4.1-.8.1-1.25s-.04-.85-.1-1.25l1.6-1.25a.7.7 0 0 0 .17-.9l-1.5-2.6a.7.7 0 0 0-.85-.31l-1.9.76a6.9 6.9 0 0 0-2.15-1.25l-.29-2.02a.7.7 0 0 0-.7-.6h-3a.7.7 0 0 0-.7.6l-.29 2.02c-.78.29-1.5.72-2.15 1.25l-1.9-.76a.7.7 0 0 0-.85.31l-1.5 2.6a.7.7 0 0 0 .17.9l1.6 1.25c-.06.4-.1.82-.1 1.25s.04.85.1 1.25l-1.6 1.25a.7.7 0 0 0-.17.9l1.5 2.6a.7.7 0 0 0 .85.31l1.9-.76c.65.53 1.37.96 2.15 1.25l.29 2.02a.7.7 0 0 0 .7.6h3a.7.7 0 0 0 .7-.6l.29-2.02c.78-.29 1.5-.72 2.15-1.25l1.9.76a.7.7 0 0 0 .85-.31l1.5-2.6a.7.7 0 0 0-.17-.9l-1.6-1.25Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
  ),

  close: svg(
    '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  ),

  grip: svg(
    '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>'
  ),

  check: svg(
    '<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  ),

  chevronDown: svg(
    '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
  ),

  warning: svg(
    '<path d="M12 3.5 21 19H3L12 3.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="11.25" y="9.5" width="1.5" height="5" rx="0.7" fill="currentColor"/><circle cx="12" cy="16.5" r="1" fill="currentColor"/>'
  ),

  info: svg(
    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><rect x="11.25" y="10.5" width="1.5" height="6" rx="0.7" fill="currentColor"/><circle cx="12" cy="7.6" r="1.05" fill="currentColor"/>'
  ),
};

export default ICONS;
