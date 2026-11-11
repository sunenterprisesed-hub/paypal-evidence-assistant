/**
 * HTML-escapes any value for safe interpolation into templates.
 * Every dynamic value rendered into a page MUST pass through esc().
 */
export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Escapes a value for use inside a double-quoted HTML attribute. */
export function attr(value) {
  return esc(value);
}
