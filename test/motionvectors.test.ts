import { describe, it, expect } from "vitest";
import {
  motionVectorVerts,
  reversePropagate,
  MAX_MV_VERTS,
  type MotionVectorParams,
} from "../src/render/MotionVectors.ts";

const GRID_X = 32;
const GRID_Y = 24;

/**
 * Build interleaved [nx, ny, u, v] mesh data the way WarpMesh.rebuild does,
 * with a per-vertex UV function (in D3D orientation, like computeWarpUV).
 */
function makeMesh(
  uv: (fx: number, fy: number) => [number, number],
): Float32Array {
  const data = new Float32Array((GRID_X + 1) * (GRID_Y + 1) * 4);
  let n = 0;
  for (let y = 0; y <= GRID_Y; y++) {
    for (let x = 0; x <= GRID_X; x++) {
      const fx = x / GRID_X;
      const fy = y / GRID_Y;
      const [u, v] = uv(fx, fy);
      data[n * 4] = fx * 2 - 1;
      data[n * 4 + 1] = fy * 2 - 1;
      data[n * 4 + 2] = u;
      data[n * 4 + 3] = v;
      n++;
    }
  }
  return data;
}

/** Identity warp: each pixel samples itself (u = fx, v = 1 - fy). */
const identityMesh = (): Float32Array => makeMesh((fx, fy) => [fx, 1 - fy]);

const params = (
  over: Partial<MotionVectorParams> = {},
): MotionVectorParams => ({
  mvX: 12,
  mvY: 9,
  mvDx: 0,
  mvDy: 0,
  mvL: 0.9,
  r: 1,
  g: 1,
  b: 1,
  a: 1,
  ...over,
});

describe("reversePropagate", () => {
  it("returns the same point under an identity warp", () => {
    const mesh = identityMesh();
    const [fx2, fy2] = reversePropagate(0.3, 0.7, GRID_X, GRID_Y, mesh);
    expect(fx2).toBeCloseTo(0.3, 5);
    expect(fy2).toBeCloseTo(0.7, 5);
  });

  it("traces a uniform translation back to its source", () => {
    // every pixel samples 0.1 to its right and 0.05 below (screen space)
    const mesh = makeMesh((fx, fy) => [fx + 0.1, 1 - (fy - 0.05)]);
    const [fx2, fy2] = reversePropagate(0.5, 0.5, GRID_X, GRID_Y, mesh);
    expect(fx2).toBeCloseTo(0.6, 5);
    expect(fy2).toBeCloseTo(0.45, 5);
  });

  it("bilinearly interpolates between grid vertices", () => {
    // u varies linearly with fx² - sampling mid-cell must interpolate the
    // corner values, not evaluate the function
    const mesh = makeMesh((fx, fy) => [fx * fx, 1 - fy]);
    const cell = 1 / GRID_X;
    const fx = 10.5 * cell; // halfway across cell 10
    const [fx2] = reversePropagate(fx, 0.5, GRID_X, GRID_Y, mesh);
    const expected = 0.5 * (10 * cell) ** 2 + 0.5 * (11 * cell) ** 2;
    expect(fx2).toBeCloseTo(expected, 6);
  });
});

describe("motionVectorVerts", () => {
  const TEXSIZE = 1024;
  const out = new Float32Array(MAX_MV_VERTS * 2);

  it("emits the original's count: the last row/col land at exactly 1.0 and are culled", () => {
    const n = motionVectorVerts(
      params(),
      GRID_X,
      GRID_Y,
      identityMesh(),
      TEXSIZE,
      out,
    );
    // for integral mv_x/mv_y the loop's last point hits fx=fy=1.0, which
    // fails the < 0.9999 cull - a 12×9 setting draws 11×8 vectors, as in
    // the original (milkdropfs.cpp:1314,1325)
    expect(n).toBe(11 * 8 * 2);
  });

  it("places grid points exactly like the original loop", () => {
    const p = params({ mvX: 4, mvY: 3 });
    motionVectorVerts(p, GRID_X, GRID_Y, identityMesh(), TEXSIZE, out);
    // first line head: x=0, y=0 → f = (0.25)/(n + 0.25 - 1), clip = f*2-1
    const fx = 0.25 / (4 + 0.25 - 1);
    const fy = 0.25 / (3 + 0.25 - 1);
    expect(out[0]).toBeCloseTo(fx * 2 - 1, 6);
    expect(out[1]).toBeCloseTo(fy * 2 - 1, 6);
  });

  it("enforces the one-texel minimum trail under an identity warp", () => {
    motionVectorVerts(params(), GRID_X, GRID_Y, identityMesh(), TEXSIZE, out);
    // zero displacement → the trail is stretched to the texel minimum: either
    // along the (float-noise) direction at exactly minLen, or as the
    // (minLen, minLen) fallback of length minLen·√2
    const minLen = 1 / TEXSIZE;
    const len = Math.hypot((out[2]! - out[0]!) / 2, (out[3]! - out[1]!) / 2);
    expect(len).toBeGreaterThanOrEqual(minLen * 0.999);
    expect(len).toBeLessThanOrEqual(minLen * Math.SQRT2 * 1.001);
  });

  it("scales trails by mv_l", () => {
    const mesh = makeMesh((fx, fy) => [fx + 0.1, 1 - fy]);
    motionVectorVerts(params({ mvL: 2 }), GRID_X, GRID_Y, mesh, TEXSIZE, out);
    // displacement 0.1 × mv_l 2 = 0.2 screen → 0.4 clip
    expect(out[2]! - out[0]!).toBeCloseTo(0.4, 5);
    expect(out[3]! - out[1]!).toBeCloseTo(0, 5);
  });

  it("caps the grid at 64×48", () => {
    const n = motionVectorVerts(
      params({ mvX: 100, mvY: 100 }),
      GRID_X,
      GRID_Y,
      identityMesh(),
      TEXSIZE,
      out,
    );
    // capped at 64×48, minus the culled last row/col (see count test)
    expect(n).toBe(63 * 47 * 2);
    expect(n).toBeLessThanOrEqual(MAX_MV_VERTS);
  });

  it("culls points pushed off-screen by mv_dx", () => {
    const full = motionVectorVerts(
      params(),
      GRID_X,
      GRID_Y,
      identityMesh(),
      TEXSIZE,
      out,
    );
    const shifted = motionVectorVerts(
      params({ mvDx: 0.5 }),
      GRID_X,
      GRID_Y,
      identityMesh(),
      TEXSIZE,
      out,
    );
    expect(shifted).toBeLessThan(full);
    expect(shifted).toBeGreaterThan(0);
  });

  it("draws nothing for a zero-count grid", () => {
    const n = motionVectorVerts(
      params({ mvX: 0 }),
      GRID_X,
      GRID_Y,
      identityMesh(),
      TEXSIZE,
      out,
    );
    expect(n).toBe(0);
  });
});
