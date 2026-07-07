/**
 * Motion vectors (`mv_*`), ported from CPlugin::DrawMotionVectors and
 * ReversePropagatePoint (milkdropfs.cpp). An mv_x × mv_y grid of short line
 * segments is drawn into the feedback *source* just before the warp samples
 * it; each line runs from a grid point to where that pixel "came from",
 * found by bilinearly interpolating the warp mesh's UV field - so the lines
 * trace the flow and get warped along with everything else.
 *
 * The math is pure and unit-tested; {@link MotionVectors} is the thin GL
 * wrapper that draws the lines via a {@link ColorBatch}.
 */

import { ColorBatch, FLOATS_PER_VERT } from "./ColorBatch.ts";
import { constants } from "../config.ts";

/** Per-frame motion-vector values (post-equation `mv_*` variables). */
export interface MotionVectorParams {
  /** grid columns; the fraction nudges spacing (original `mv_x`) */
  mvX: number;
  /** grid rows (original `mv_y`) */
  mvY: number;
  /** horizontal placement offset (original `mv_dx`) */
  mvDx: number;
  /** vertical placement offset (original `mv_dy`) */
  mvDy: number;
  /** trail length multiplier (original `mv_l`) */
  mvL: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Grid-count caps from the original (64×48), with vertices per line = 2. */
export const MAX_MV_VERTS =
  constants.motionVectors.maxX * constants.motionVectors.maxY * 2;

/**
 * Where did the pixel at screen point (fx, fy) come from? Bilinearly
 * interpolates the warp mesh's sample UVs at that point - a 1:1 port of
 * ReversePropagatePoint (milkdropfs.cpp:1514), including the D3D→screen
 * flip of the v coordinate.
 *
 * @param fx - Screen x in 0..1.
 * @param fy - Screen y in 0..1 (bottom-up, clip-space orientation).
 * @param gridX - Warp mesh columns.
 * @param gridY - Warp mesh rows.
 * @param mesh - Interleaved `[nx, ny, u, v]` vertex data (see WarpMesh).
 * @returns The source point `[fx2, fy2]` in the same screen space.
 */
export function reversePropagate(
  fx: number,
  fy: number,
  gridX: number,
  gridY: number,
  mesh: Float32Array,
): [number, number] {
  const y0 = Math.floor(fy * gridY);
  const dy = fy * gridY - y0;
  const x0 = Math.floor(fx * gridX);
  const dx = fx * gridX - x0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  if (x0 < 0 || y0 < 0 || x1 > gridX || y1 > gridY) return [fx, fy];

  const stride = gridX + 1;
  const u = (x: number, y: number): number => mesh[(y * stride + x) * 4 + 2]!;
  const v = (x: number, y: number): number => mesh[(y * stride + x) * 4 + 3]!;

  let tu = u(x0, y0) * (1 - dx) * (1 - dy);
  let tv = v(x0, y0) * (1 - dx) * (1 - dy);
  tu += u(x1, y0) * dx * (1 - dy);
  tv += v(x1, y0) * dx * (1 - dy);
  tu += u(x0, y1) * (1 - dx) * dy;
  tv += v(x0, y1) * (1 - dx) * dy;
  tu += u(x1, y1) * dx * dy;
  tv += v(x1, y1) * dx * dy;

  return [tu, 1 - tv];
}

/**
 * Build the motion-vector line list - a 1:1 port of the DrawMotionVectors
 * loop (milkdropfs.cpp:1254-1386): grid counts capped at 64×48 (the fraction
 * of mv_x/mv_y stretches spacing), points shifted by mv_dx/mv_dy and culled
 * outside (0.0001, 0.9999), trails scaled by mv_l with a one-texel minimum.
 *
 * @param p - Motion-vector parameters.
 * @param gridX - Warp mesh columns.
 * @param gridY - Warp mesh rows.
 * @param mesh - Interleaved `[nx, ny, u, v]` warp mesh vertex data.
 * @param texSizeX - Feedback texture width (sets the minimum trail length).
 * @param out - Receives clip-space `[x, y]` pairs, two per line.
 * @returns The number of vertices written (2 per line).
 */
export function motionVectorVerts(
  p: MotionVectorParams,
  gridX: number,
  gridY: number,
  mesh: Float32Array,
  texSizeX: number,
  out: Float32Array,
): number {
  let nX = Math.floor(p.mvX);
  let nY = Math.floor(p.mvY);
  let dx = p.mvX - nX;
  let dy = p.mvY - nY;
  if (nX > constants.motionVectors.maxX) {
    nX = constants.motionVectors.maxX;
    dx = 0;
  }
  if (nY > constants.motionVectors.maxY) {
    nY = constants.motionVectors.maxY;
    dy = 0;
  }
  if (nX <= 0 || nY <= 0) return 0;

  if (dx < 0) dx = 0;
  if (dy < 0) dy = 0;
  if (dx > 1) dx = 1;
  if (dy > 1) dy = 1;
  const minLen = 1 / texSizeX;

  let n = 0;
  for (let y = 0; y < nY; y++) {
    let fy = (y + 0.25) / (nY + dy + 0.25 - 1.0);
    fy -= p.mvDy;
    if (fy <= 0.0001 || fy >= 0.9999) continue;
    for (let x = 0; x < nX; x++) {
      let fx = (x + 0.25) / (nX + dx + 0.25 - 1.0);
      fx += p.mvDx;
      if (fx <= 0.0001 || fx >= 0.9999) continue;

      let [fx2, fy2] = reversePropagate(fx, fy, gridX, gridY, mesh);

      // enforce minimum trail length
      let ddx = (fx2 - fx) * p.mvL;
      let ddy = (fy2 - fy) * p.mvL;
      const len = Math.sqrt(ddx * ddx + ddy * ddy);
      if (len > minLen) {
        // long enough
      } else if (len > 1e-8) {
        const s = minLen / len;
        ddx *= s;
        ddy *= s;
      } else {
        ddx = minLen;
        ddy = minLen;
      }
      fx2 = fx + ddx;
      fy2 = fy + ddy;

      out[n * 2] = fx * 2 - 1;
      out[n * 2 + 1] = fy * 2 - 1;
      out[n * 2 + 2] = fx2 * 2 - 1;
      out[n * 2 + 3] = fy2 * 2 - 1;
      n += 2;
    }
  }
  return n;
}

/** Draws the motion-vector line grid into the feedback source buffer. */
export class MotionVectors {
  private gl: WebGL2RenderingContext;
  private batch: ColorBatch;
  private scratch = new Float32Array(MAX_MV_VERTS * 2);

  /** Set up the GL batch used to draw the motion-vector field. */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.batch = new ColorBatch(gl, MAX_MV_VERTS);
  }

  /** Draw the grid (no-op when alpha is below 0.001, like the original). */
  render(
    p: MotionVectorParams,
    gridX: number,
    gridY: number,
    mesh: Float32Array,
    texSizeX: number,
  ): void {
    if (p.a < 0.001) return;
    const count = motionVectorVerts(
      p,
      gridX,
      gridY,
      mesh,
      texSizeX,
      this.scratch,
    );
    if (count === 0) return;
    const buf = this.batch.buffer;
    for (let i = 0; i < count; i++) {
      const o = i * FLOATS_PER_VERT;
      buf[o] = this.scratch[i * 2]!;
      buf[o + 1] = this.scratch[i * 2 + 1]!;
      buf[o + 2] = p.r;
      buf[o + 3] = p.g;
      buf[o + 4] = p.b;
      buf[o + 5] = p.a;
    }
    this.batch.draw(this.gl.LINES, count, false);
  }
}
