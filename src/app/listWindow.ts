/**
 * Which slice of a filtered preset list to actually render.
 *
 * @remarks
 * Playlists routinely run to thousands of entries, and building a DOM row for
 * every one costs more than it is worth for a jump-to list. Rather than render
 * the first N matches - which would hide the active preset as soon as it cycled
 * past the cap - the window is centred on it, so the highlight (and the
 * scroll-into-view on open) always has something to land on.
 */

/** The half-open range `[start, end)` of matches to render. */
export interface ListWindow {
  start: number;
  end: number;
}

/**
 * Choose the slice of matches to render.
 *
 * @param matchCount - How many entries passed the search filter.
 * @param currentPos - Position of the active preset within the matches, or -1
 *   if it was filtered out.
 * @param max - Most rows to render at once.
 * @returns The half-open range of match positions to draw.
 */
export function listWindow(
  matchCount: number,
  currentPos: number,
  max: number,
): ListWindow {
  if (max <= 0) return { start: 0, end: 0 };
  if (matchCount <= max) return { start: 0, end: matchCount };

  // Centre on the active preset when it is in the filtered set, then clamp so
  // the window stays inside the list and always renders a full `max` rows.
  let start = 0;
  if (currentPos >= 0) {
    start = Math.min(Math.max(0, currentPos - (max >> 1)), matchCount - max);
  }
  return { start, end: start + max };
}
