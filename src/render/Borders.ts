/**
 * Outer/inner preset borders (`ob_*` / `ib_*`) and the `darken_center` fan,
 * ported from the tail of DrawSprites (milkdropfs.cpp). Each border is four
 * 90°-rotated alpha-blended quads drawn into the feedback buffer after the
 * waves, so they echo through the warp on subsequent frames - the effect most
 * presets that set `ob_a`/`ib_a` are built around. A border whose alpha is
 * ≤ 0.001 is skipped.
 *
 * The geometry helpers are pure and unit-tested; {@link Borders} is the thin
 * GL wrapper that draws them via a {@link ColorBatch}.
 */

import { ColorBatch, FLOATS_PER_VERT } from "./ColorBatch.ts";
import { constants } from "../config.ts";

/** Per-frame border values (post-equation `ob_*` / `ib_*` variables). */
export interface BorderParams {
  obSize: number;
  obR: number;
  obG: number;
  obB: number;
  obA: number;
  ibSize: number;
  ibR: number;
  ibG: number;
  ibB: number;
  ibA: number;
}

/** One resolved border ring: radial span plus colour. */
export interface BorderPass {
  innerRad: number;
  outerRad: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Resolve the two border rings exactly as the original's `it=0/1` loop does:
 * the outer border spans clip radius `1 → 1-ob_size`, the inner border nests
 * directly inside it, spanning `1-ob_size → 1-ob_size-ib_size`.
 */
export function borderPasses(p: BorderParams): BorderPass[] {
  return [
    {
      innerRad: 1 - p.obSize,
      outerRad: 1,
      r: p.obR,
      g: p.obG,
      b: p.obB,
      a: p.obA,
    },
    {
      innerRad: 1 - p.obSize - p.ibSize,
      outerRad: 1 - p.obSize,
      r: p.ibR,
      g: p.ibG,
      b: p.ibB,
      a: p.ibA,
    },
  ];
}

/** Vertices per border ring: 4 quads × 2 triangles × 3 vertices. */
export const VERTS_PER_BORDER = constants.borders.vertsPerBorder;

/**
 * Positions (clip-space `[x, y]` pairs, `2 * VERTS_PER_BORDER` floats) for one
 * border ring. The original draws a 4-vertex triangle fan
 * `(i,i) (o,o) (o,-o) (i,-i)` four times, rotating it 90° between draws;
 * this returns the same fans pre-triangulated for a single TRIANGLES draw.
 */
export function borderPositions(
  innerRad: number,
  outerRad: number,
): Float32Array {
  let quad: [number, number][] = [
    [innerRad, innerRad],
    [outerRad, outerRad],
    [outerRad, -outerRad],
    [innerRad, -innerRad],
  ];
  const fanIndices = [0, 1, 2, 0, 2, 3];
  const out = new Float32Array(VERTS_PER_BORDER * 2);
  let o = 0;
  for (let rot = 0; rot < 4; rot++) {
    for (const i of fanIndices) {
      out[o++] = quad[i]![0];
      out[o++] = quad[i]![1];
    }
    quad = quad.map(([x, y]) => [-y, x]);
  }
  return out;
}

/**
 * Vertices for the `darken_center` diamond fan (milkdropfs.cpp:3400): a small
 * black fan over the screen centre, centre alpha 3/32 fading to 0 at the
 * tips, half-size 0.05 with the x extent aspect-corrected. Returns
 * `[x, y, alpha]` triples: centre + 4 tips + closing tip.
 */
export function darkenCenterVerts(aspectY: number): number[][] {
  const h = constants.borders.darkenCenterHalfSize;
  const a = constants.borders.darkenCenterAlpha;
  return [
    [0, 0, a],
    [-h * aspectY, 0, 0],
    [0, -h, 0],
    [h * aspectY, 0, 0],
    [0, h, 0],
    [-h * aspectY, 0, 0],
  ];
}

/** Draws the outer and inner preset borders into the feedback buffer. */
export class Borders {
  private gl: WebGL2RenderingContext;
  private batch: ColorBatch;

  /** Set up the GL batch used to draw borders and the centre darken pass. */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.batch = new ColorBatch(gl, VERTS_PER_BORDER);
  }

  /** Draw both borders (outer first, like the original); no-ops on alpha 0. */
  render(p: BorderParams): void {
    for (const pass of borderPasses(p)) {
      if (pass.a <= 0.001) continue;
      const pos = borderPositions(pass.innerRad, pass.outerRad);
      const buf = this.batch.buffer;
      for (let i = 0; i < VERTS_PER_BORDER; i++) {
        const v = i * FLOATS_PER_VERT;
        buf[v] = pos[i * 2]!;
        buf[v + 1] = pos[i * 2 + 1]!;
        buf[v + 2] = pass.r;
        buf[v + 3] = pass.g;
        buf[v + 4] = pass.b;
        buf[v + 5] = pass.a;
      }
      this.batch.draw(this.gl.TRIANGLES, VERTS_PER_BORDER, false);
    }
  }

  /** Draw the `darken_center` fan (call only when the preset enables it). */
  renderDarkenCenter(aspectY: number): void {
    const verts = darkenCenterVerts(aspectY);
    const buf = this.batch.buffer;
    for (let i = 0; i < verts.length; i++) {
      const [x, y, a] = verts[i]!;
      const o = i * FLOATS_PER_VERT;
      buf[o] = x!;
      buf[o + 1] = y!;
      buf[o + 2] = 0;
      buf[o + 3] = 0;
      buf[o + 4] = 0;
      buf[o + 5] = a!;
    }
    this.batch.draw(this.gl.TRIANGLE_FAN, verts.length, false);
  }
}
