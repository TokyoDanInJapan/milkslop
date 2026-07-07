import { describe, it, expect } from "vitest";
import { stepHardCut } from "../src/app/Visualizer.ts";

const BASE = 2.5;
const HALFLIFE = 60;
const FPS = 60;

describe("stepHardCut", () => {
  it("triggers and doubles the threshold when loudness exceeds thresh×3", () => {
    const thresh = 5; // base*2 initial
    const r = stepHardCut(thresh, 16, BASE, HALFLIFE, FPS);
    expect(r.trigger).toBe(true);
    expect(r.thresh).toBe(10);
  });

  it("does not trigger at or below the thresh×3 boundary", () => {
    const r = stepHardCut(5, 15, BASE, HALFLIFE, FPS); // 5*3 = 15, not >
    expect(r.trigger).toBe(false);
  });

  it("decays toward the base loudness when quiet", () => {
    const r = stepHardCut(10, 0, BASE, HALFLIFE, FPS);
    expect(r.trigger).toBe(false);
    // moves toward base but not past it in one frame
    expect(r.thresh).toBeLessThan(10);
    expect(r.thresh).toBeGreaterThan(BASE);
  });

  it("decay converges to base over a long quiet stretch", () => {
    let t = 20;
    // halflife is in seconds; at 60fps full convergence takes tens of
    // thousands of frames (~1000s here)
    for (let i = 0; i < 60000; i++)
      t = stepHardCut(t, 0, BASE, HALFLIFE, FPS).thresh;
    expect(t).toBeCloseTo(BASE, 3);
  });

  it("applies a quarter-life over `halflife` seconds (per the -ln4 constant)", () => {
    let t = BASE + 4; // 4 above base
    // halflife seconds = halflife×fps frames
    for (let i = 0; i < HALFLIFE * FPS; i++)
      t = stepHardCut(t, 0, BASE, HALFLIFE, FPS).thresh;
    // exp(-ln4) = 0.25 → the excess (4) decays to ~1 above base
    expect(t - BASE).toBeCloseTo(1, 1);
  });

  it("skips the test below 1 fps (no trigger, unchanged threshold)", () => {
    const r = stepHardCut(5, 100, BASE, HALFLIFE, 0.5);
    expect(r.trigger).toBe(false);
    expect(r.thresh).toBe(5);
  });
});
