/**
 * MilkDrop's "thick line" fattening: instead of a wide-line primitive, the
 * original redraws a line strip four times, nudged by one texel between passes
 * (`milkdropfs.cpp`'s `DrawWave` / `DrawCustomWaves` / `DrawCustomShapes` all
 * do this). The pass table is shared here. How it is applied is not, because
 * the call sites legitimately differ:
 *
 * - Waveform and custom waves translate an already-built vertex buffer, so the
 *   steps accumulate: the drawn positions walk (0,0) → (+x,0) → (+x,+y) → (0,+y).
 * - Custom shapes rebuild their geometry per pass and add the step to the base
 *   position, so the drawn positions are (0,0), (+x,0), (0,+y), (-x,0).
 */

/** Passes used to fatten a line (the original's 4-pass nudge). */
export const THICK_PASSES = 4;

/**
 * Per-pass `(x, y)` step in texel multiples. Scale by `2 / texSize` to get
 * clip-space offsets. Index by pass number, `0` being the un-nudged pass.
 */
export const THICK_PASS_STEPS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Translate an interleaved vertex buffer in place by pass `pass`'s step.
 *
 * @remarks
 * Steps are **cumulative** - call this once per pass, in order, on the same
 * buffer, and the drawn positions trace the box described above. Pass 0 is a
 * no-op, so callers can loop from 0 without a special case.
 *
 * @param verts - Interleaved vertex data. X at `i*stride`, y at `i*stride+1`.
 * @param count - Number of vertices to move.
 * @param stride - Floats per vertex.
 * @param pass - Pass index, 0..{@link THICK_PASSES}-1.
 * @param xInc - Clip-space width of one texel (`2 / texSizeX`).
 * @param yInc - Clip-space height of one texel (`2 / texSizeY`).
 */
export function applyThickPass(
  verts: Float32Array,
  count: number,
  stride: number,
  pass: number,
  xInc: number,
  yInc: number,
): void {
  const step = THICK_PASS_STEPS[pass];
  if (!step) return;
  const dx = step[0] * xInc;
  const dy = step[1] * yInc;
  if (dx === 0 && dy === 0) return;
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    verts[o] = verts[o]! + dx;
    verts[o + 1] = verts[o + 1]! + dy;
  }
}
