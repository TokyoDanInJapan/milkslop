import { describe, it, expect } from "vitest";
import {
  borderPasses,
  borderPositions,
  darkenCenterVerts,
  VERTS_PER_BORDER,
  type BorderParams,
} from "../src/render/Borders.ts";

const params = (over: Partial<BorderParams> = {}): BorderParams => ({
  obSize: 0.05,
  obR: 1,
  obG: 0.5,
  obB: 0,
  obA: 0.8,
  ibSize: 0.03,
  ibR: 0,
  ibG: 0,
  ibB: 1,
  ibA: 0.6,
  ...over,
});

describe("borderPasses", () => {
  it("outer border spans clip radius 1 → 1-ob_size", () => {
    const [outer] = borderPasses(params());
    expect(outer!.outerRad).toBe(1);
    expect(outer!.innerRad).toBeCloseTo(0.95);
    expect(outer!).toMatchObject({ r: 1, g: 0.5, b: 0, a: 0.8 });
  });

  it("inner border nests directly inside the outer one", () => {
    const [outer, inner] = borderPasses(params());
    expect(inner!.outerRad).toBeCloseTo(outer!.innerRad);
    expect(inner!.innerRad).toBeCloseTo(1 - 0.05 - 0.03);
    expect(inner!).toMatchObject({ r: 0, g: 0, b: 1, a: 0.6 });
  });

  it("orders outer before inner, matching the original it=0/1 loop", () => {
    const passes = borderPasses(params());
    expect(passes).toHaveLength(2);
    expect(passes[0]!.outerRad).toBeGreaterThan(passes[1]!.outerRad);
  });
});

describe("borderPositions", () => {
  const iR = 0.9;
  const oR = 1.0;
  const pos = borderPositions(iR, oR);

  it("emits 4 quads as triangles", () => {
    expect(pos).toHaveLength(VERTS_PER_BORDER * 2);
  });

  it("first quad matches the original fan (i,i)(o,o)(o,-o)(i,-i)", () => {
    // fan → triangles (v0,v1,v2) and (v0,v2,v3)
    const fan = [
      [iR, iR],
      [oR, oR],
      [oR, -oR],
      [iR, -iR],
    ];
    const expected = [0, 1, 2, 0, 2, 3].flatMap((i) =>
      fan[i]!.map(Math.fround),
    );
    expect(Array.from(pos.slice(0, 12))).toEqual(expected);
  });

  it("each subsequent quad is the previous rotated exactly 90°", () => {
    for (let quad = 1; quad < 4; quad++) {
      for (let v = 0; v < 6; v++) {
        const px = pos[(quad - 1) * 12 + v * 2]!;
        const py = pos[(quad - 1) * 12 + v * 2 + 1]!;
        // (x, y) → (-y, x)
        expect(pos[quad * 12 + v * 2]).toBeCloseTo(-py, 12);
        expect(pos[quad * 12 + v * 2 + 1]).toBeCloseTo(px, 12);
      }
    }
  });

  it("all vertices lie within the border ring band", () => {
    for (let v = 0; v < VERTS_PER_BORDER; v++) {
      const m = Math.max(Math.abs(pos[v * 2]!), Math.abs(pos[v * 2 + 1]!));
      expect(m).toBeGreaterThanOrEqual(iR - 1e-6);
      expect(m).toBeLessThanOrEqual(oR + 1e-6);
    }
  });
});

describe("darkenCenterVerts", () => {
  const verts = darkenCenterVerts(0.75);

  it("is a 6-vertex fan: centre + 4 tips + closing tip", () => {
    expect(verts).toHaveLength(6);
    expect(verts[0]).toEqual([0, 0, 3 / 32]);
    expect(verts[5]).toEqual(verts[1]);
  });

  it("tips are fully transparent and aspect-corrected on x", () => {
    for (let i = 1; i < 6; i++) expect(verts[i]![2]).toBe(0);
    expect(verts[1]![0]).toBeCloseTo(-0.05 * 0.75, 6);
    expect(verts[2]![1]).toBeCloseTo(-0.05, 6);
  });
});
