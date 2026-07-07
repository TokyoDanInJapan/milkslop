import { describe, it, expect } from "vitest";
import {
  buildWave,
  smoothWave,
  NUM_WAVEFORM_SAMPLES,
  type WaveBuildParams,
} from "../src/render/Waveform.ts";
import { safeBlurMinMax } from "../src/render/BlurPasses.ts";
import { computeAspect } from "../src/render/warp.ts";

const aspect = computeAspect(1024, 768);
const silence = new Float32Array(576);

const params = (over: Partial<WaveBuildParams> = {}): WaveBuildParams => ({
  mode: 0,
  alpha: 0.8,
  mystery: 0,
  x: 0.5,
  y: 0.5,
  scale: 1,
  modByVolume: false,
  modAlphaStart: 0.75,
  modAlphaEnd: 0.95,
  vol: 1,
  treb: 1,
  time: 0,
  blending: false,
  ...over,
});

describe("buildWave", () => {
  it("mode 0 emits half the samples plus a loop-closing vertex", () => {
    const w = buildWave(params(), silence, silence, aspect, 1024);
    expect(w.nVerts).toBe(NUM_WAVEFORM_SAMPLES / 2 + 1);
    // closing vertex duplicates the first
    expect(w.verts[(w.nVerts - 1) * 2]).toBeCloseTo(w.verts[0]!, 6);
    expect(w.verts[(w.nVerts - 1) * 2 + 1]).toBeCloseTo(w.verts[1]!, 6);
  });

  it("mode 0 skips the closing vertex while blending, like the original", () => {
    const w = buildWave(
      params({ blending: true }),
      silence,
      silence,
      aspect,
      1024,
    );
    expect(w.nVerts).toBe(NUM_WAVEFORM_SAMPLES / 2);
  });

  it("applies wave_mode % 8 (mode 8 wraps to 0)", () => {
    const a = buildWave(params({ mode: 8 }), silence, silence, aspect, 1024);
    const b = buildWave(params({ mode: 0 }), silence, silence, aspect, 1024);
    expect(a.nVerts).toBe(b.nVerts);
    expect(Array.from(a.verts.slice(0, 10))).toEqual(
      Array.from(b.verts.slice(0, 10)),
    );
  });

  it("mode 2 centers on (wave_x, wave_y) with the y-axis flip", () => {
    const w = buildWave(
      params({ mode: 2, x: 0.75, y: 0.25 }),
      silence,
      silence,
      aspect,
      1024,
    );
    // silence → every vertex sits at (posX, -(posY)) = (0.5, -(-0.5))
    expect(w.verts[0]).toBeCloseTo(0.5, 6);
    expect(w.verts[1]).toBeCloseTo(0.5, 6);
  });

  it("mode 3 ties alpha to treble (texsize-bucketed base)", () => {
    const quiet = buildWave(
      params({ mode: 3, treb: 0 }),
      silence,
      silence,
      aspect,
      1024,
    );
    const loud = buildWave(
      params({ mode: 3, treb: 1 }),
      silence,
      silence,
      aspect,
      1024,
    );
    expect(quiet.alpha).toBe(0);
    expect(loud.alpha).toBeCloseTo(0.22 * 1.3, 5);
  });

  it("mode 1 (x-y spiral) halves the verts and bumps alpha ×1.25", () => {
    const w = buildWave(params({ mode: 1 }), silence, silence, aspect, 1024);
    expect(w.nVerts).toBe(NUM_WAVEFORM_SAMPLES / 2);
    expect(w.nBreak).toBe(-1);
    // 0.8 × 1.25 = 1.0 (clamped)
    expect(w.alpha).toBeCloseTo(1, 5);
  });

  it("mode 4 (horizontal script) caps verts at texSizeX/3", () => {
    const wide = buildWave(params({ mode: 4 }), silence, silence, aspect, 1024);
    expect(wide.nVerts).toBe(Math.floor(1024 / 3));
    const small = buildWave(params({ mode: 4 }), silence, silence, aspect, 256);
    expect(small.nVerts).toBe(Math.floor(256 / 3));
    // first vertex starts at the left edge (+ wave_x offset, here 0)
    expect(wide.verts[0]).toBeCloseTo(-1, 5);
  });

  it("mode 5 (explosive complex) uses all samples with texsize-bucketed alpha", () => {
    const w = buildWave(params({ mode: 5 }), silence, silence, aspect, 1024);
    expect(w.nVerts).toBe(NUM_WAVEFORM_SAMPLES);
    // 0.8 × 0.11 bucket for 1024
    expect(w.alpha).toBeCloseTo(0.8 * 0.11, 5);
    // silence → complex product is zero → centered at (posX, -posY) = (0, 0)
    expect(w.verts[0]).toBeCloseTo(0, 6);
    expect(w.verts[1]).toBeCloseTo(0, 6);
  });

  it("mode 6 (angle line) halves verts and clips the start to the screen edge", () => {
    const w = buildWave(params({ mode: 6 }), silence, silence, aspect, 1024);
    expect(w.nVerts).toBe(NUM_WAVEFORM_SAMPLES / 2);
    expect(w.nBreak).toBe(-1);
    // endpoint clipped against the +/-1.1 box
    expect(w.verts[0]).toBeCloseTo(-1.1, 5);
  });

  it("mode 7 produces two lines split at nBreak", () => {
    const w = buildWave(params({ mode: 7 }), silence, silence, aspect, 1024);
    expect(w.nBreak).toBeGreaterThan(0);
    expect(w.nVerts).toBe(w.nBreak * 2);
  });

  it("folds an out-of-range wave_mystery into [-1, 1]", () => {
    // mystery=3 → fold: 3*0.5+0.5=2 → frac 0 → |0|*2-1 = -1 (same as mystery=-1)
    const folded = buildWave(
      params({ mystery: 3 }),
      silence,
      silence,
      aspect,
      1024,
    );
    const direct = buildWave(
      params({ mystery: -1 }),
      silence,
      silence,
      aspect,
      1024,
    );
    expect(folded.verts[0]).toBeCloseTo(direct.verts[0]!, 5);
  });

  it("mod-alpha-by-volume scales alpha across the start/end window", () => {
    const lo = buildWave(
      params({ modByVolume: true, vol: 0.75 }),
      silence,
      silence,
      aspect,
      1024,
    );
    const hi = buildWave(
      params({ modByVolume: true, vol: 0.95 }),
      silence,
      silence,
      aspect,
      1024,
    );
    expect(lo.alpha).toBe(0);
    expect(hi.alpha).toBeCloseTo(0.8, 5);
  });
});

describe("smoothWave", () => {
  it("inserts midpoints: n verts → 2n-1", () => {
    const input = new Float32Array([0, 0, 1, 1, 2, 0]);
    const out = new Float32Array(64);
    expect(smoothWave(input, 3, out)).toBe(5);
  });

  it("inserted points on a straight evenly-spaced line are midpoints", () => {
    const n = 5;
    const input = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      input[i * 2] = i;
      input[i * 2 + 1] = 2 * i;
    }
    const out = new Float32Array(64);
    const m = smoothWave(input, n, out);
    // vertex 3 (index 3) is the midpoint between input verts 1 and 2
    expect(m).toBe(2 * n - 1);
    expect(out[3 * 2]).toBeCloseTo(1.5, 5);
    expect(out[3 * 2 + 1]).toBeCloseTo(3, 5);
  });
});

describe("safeBlurMinMax", () => {
  it("passes well-formed nested ranges through", () => {
    const { mins, maxs } = safeBlurMinMax({
      mins: [0, 0.1, 0.2],
      maxs: [1, 0.9, 0.8],
      edgeDarken: 0,
    });
    expect(mins).toEqual([0, 0.1, 0.2]);
    expect(maxs).toEqual([1, 0.9, 0.8]);
  });

  it("narrows later levels into earlier ones", () => {
    const { mins, maxs } = safeBlurMinMax({
      mins: [0.3, 0, 0],
      maxs: [0.7, 1, 1],
      edgeDarken: 0,
    });
    expect(mins[1]).toBeCloseTo(0.3, 6);
    expect(maxs[1]).toBeCloseTo(0.7, 6);
  });

  it("pushes a collapsed range back apart by the minimum distance", () => {
    const { mins, maxs } = safeBlurMinMax({
      mins: [0.5, 0, 0],
      maxs: [0.5, 1, 1],
      edgeDarken: 0,
    });
    expect(maxs[0]! - mins[0]!).toBeCloseTo(0.1, 6);
    expect((mins[0]! + maxs[0]!) / 2).toBeCloseTo(0.5, 6);
  });
});
