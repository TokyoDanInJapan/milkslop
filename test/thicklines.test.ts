import { describe, it, expect } from "vitest";
import {
  applyThickPass,
  THICK_PASSES,
  THICK_PASS_STEPS,
} from "../src/render/thickLines.ts";

const X = 0.5; // xInc
const Y = 0.25; // yInc

/** Two vertices at the origin, interleaved [x, y, r, g, b, a]. */
function verts(stride: number): Float32Array {
  const v = new Float32Array(2 * stride);
  for (let i = 0; i < 2; i++) {
    v[i * stride] = 0;
    v[i * stride + 1] = 0;
    for (let k = 2; k < stride; k++) v[i * stride + k] = 7; // colour sentinel
  }
  return v;
}

describe("thick-line pass table", () => {
  it("has one step per pass, starting un-nudged", () => {
    expect(THICK_PASS_STEPS).toHaveLength(THICK_PASSES);
    expect(THICK_PASS_STEPS[0]).toEqual([0, 0]);
  });

  it("steps sum to zero, so the passes close the box", () => {
    const sx = THICK_PASS_STEPS.reduce((a, s) => a + s[0], 0);
    const sy = THICK_PASS_STEPS.reduce((a, s) => a + s[1], 0);
    expect([sx, sy]).toEqual([0, 1]);
  });
});

describe("applyThickPass", () => {
  it("leaves the buffer untouched on pass 0", () => {
    const v = verts(2);
    applyThickPass(v, 2, 2, 0, X, Y);
    expect(Array.from(v)).toEqual([0, 0, 0, 0]);
  });

  it("walks the original's 4-pass box when applied cumulatively", () => {
    const v = verts(2);
    const seen: [number, number][] = [];
    for (let pass = 0; pass < THICK_PASSES; pass++) {
      applyThickPass(v, 2, 2, pass, X, Y);
      seen.push([v[0]!, v[1]!]);
    }
    // (0,0) → (+x,0) → (+x,+y) → (0,+y)
    expect(seen).toEqual([
      [0, 0],
      [X, 0],
      [X, Y],
      [0, Y],
    ]);
  });

  it("moves every vertex, not just the first", () => {
    const v = verts(2);
    applyThickPass(v, 2, 2, 1, X, Y);
    expect(v[0]).toBeCloseTo(X, 6);
    expect(v[2]).toBeCloseTo(X, 6);
  });

  it("respects the stride and leaves colour channels alone", () => {
    const v = verts(6);
    applyThickPass(v, 2, 6, 2, X, Y);
    expect(v[1]).toBeCloseTo(Y, 6); // first vertex y
    expect(v[7]).toBeCloseTo(Y, 6); // second vertex y
    expect(v[0]).toBe(0); // x untouched on this pass
    for (const i of [2, 3, 4, 5, 8, 9, 10, 11]) expect(v[i]).toBe(7);
  });

  it("only touches `count` vertices", () => {
    const v = verts(2);
    applyThickPass(v, 1, 2, 1, X, Y);
    expect(v[0]).toBeCloseTo(X, 6);
    expect(v[2]).toBe(0); // second vertex left alone
  });

  it("ignores an out-of-range pass", () => {
    const v = verts(2);
    applyThickPass(v, 2, 2, 9, X, Y);
    expect(Array.from(v)).toEqual([0, 0, 0, 0]);
  });
});
