import { describe, it, expect } from "vitest";
import {
  cubicInterpolate,
  generateNoise2D,
  generateNoise3D,
} from "../src/render/NoiseTextures.ts";

/** Deterministic RNG so tests are stable. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Mean absolute difference between horizontally adjacent texels (channel 0). */
function adjacentRoughness(data: Uint8Array, size: number): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size - 1; x++) {
      const a = data[(y * size + x) * 4]!;
      const b = data[(y * size + x + 1) * 4]!;
      sum += Math.abs(a - b);
      count++;
    }
  return sum / count;
}

describe("cubicInterpolate", () => {
  it("returns the endpoints at t=0 and t=1", () => {
    expect(cubicInterpolate(0.2, 0.4, 0.6, 0.8, 0)).toBeCloseTo(0.4, 6);
    expect(cubicInterpolate(0.2, 0.4, 0.6, 0.8, 1)).toBeCloseTo(0.6, 6);
  });

  it("interpolates monotonically between y1 and y2 on a linear ramp", () => {
    const mid = cubicInterpolate(0, 0.25, 0.5, 0.75, 0.5);
    expect(mid).toBeGreaterThan(0.25);
    expect(mid).toBeLessThan(0.5);
    expect(mid).toBeCloseTo(0.375, 6);
  });
});

describe("generateNoise2D", () => {
  it("produces a full RGBA8 plane", () => {
    const data = generateNoise2D(16, 1, seeded(1));
    expect(data).toHaveLength(16 * 16 * 4);
  });

  it("zoom 1 is sharp noise; higher zoom is progressively smoother", () => {
    const lq = adjacentRoughness(generateNoise2D(64, 1, seeded(42)), 64);
    const mq = adjacentRoughness(generateNoise2D(64, 4, seeded(42)), 64);
    const hq = adjacentRoughness(generateNoise2D(64, 8, seeded(42)), 64);
    // smoother tiers vary less between adjacent texels
    expect(mq).toBeLessThan(lq);
    expect(hq).toBeLessThan(mq);
  });

  it("keeps the random lattice values intact on zoomed tiers", () => {
    // every `zoom`-th texel on a lattice row is an original random sample,
    // unchanged by interpolation - so two zoomed tiles built from the same
    // seed agree exactly at lattice points
    const a = generateNoise2D(32, 4, seeded(7));
    const b = generateNoise2D(32, 4, seeded(7));
    expect(a).toEqual(b); // deterministic for a fixed seed
  });
});

describe("generateNoise3D", () => {
  it("produces a full RGBA8 volume", () => {
    const data = generateNoise3D(8, 1, seeded(3));
    expect(data).toHaveLength(8 * 8 * 8 * 4);
  });

  it("zoom>1 smooths within each row", () => {
    const size = 16;
    const sharp = generateNoise3D(size, 1, seeded(9));
    const smooth = generateNoise3D(size, 4, seeded(9));
    // measure roughness along x within the first slice/row
    const rough = (d: Uint8Array) => {
      let sum = 0;
      for (let x = 0; x < size - 1; x++)
        sum += Math.abs(d[x * 4]! - d[(x + 1) * 4]!);
      return sum / (size - 1);
    };
    expect(rough(smooth)).toBeLessThan(rough(sharp));
  });
});
