import { describe, it, expect } from "vitest";
import { cosineInterp } from "../src/render/Present.ts";

describe("cosineInterp (blend easing)", () => {
  it("eases 0→1 with flat ends, matching MilkDrop's CosineInterp", () => {
    expect(cosineInterp(0)).toBeCloseTo(0, 6);
    expect(cosineInterp(1)).toBeCloseTo(1, 6);
    expect(cosineInterp(0.5)).toBeCloseTo(0.5, 6);
  });

  it("is monotonic and clamps out-of-range input", () => {
    expect(cosineInterp(-1)).toBeCloseTo(0, 6);
    expect(cosineInterp(2)).toBeCloseTo(1, 6);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.1) {
      const y = cosineInterp(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  it("eases slower at the start than the linear midpoint", () => {
    expect(cosineInterp(0.25)).toBeLessThan(0.25); // S-curve below the line early
    expect(cosineInterp(0.75)).toBeGreaterThan(0.75); // above the line late
  });
});
