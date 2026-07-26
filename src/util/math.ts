/**
 * Small numeric helpers shared across the renderer, parser, and equation
 * plumbing. Kept in one place so the same clamp isn't re-declared per module.
 */

/**
 * Constrain `x` to the inclusive range `[lo, hi]`.
 *
 * @param x - Value to constrain.
 * @param lo - Lower bound.
 * @param hi - Upper bound.
 * @returns `x` clamped to the range. `NaN` passes through unchanged (both
 *   comparisons are false), matching the comparison-based clamp this replaces.
 */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
