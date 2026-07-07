import { describe, it, expect } from "vitest";
import {
  computeAspect,
  computeWarpUV,
  vertexRadAng,
  warpCoefficients,
  type WarpFrame,
  type WarpParams,
} from "../src/render/warp.ts";

const identityParams = (): WarpParams => ({
  zoom: 1,
  zoomExp: 1,
  rot: 0,
  warp: 0,
  cx: 0.5,
  cy: 0.5,
  dx: 0,
  dy: 0,
  sx: 1,
  sy: 1,
});

const noWarpFrame = (): WarpFrame => ({
  warpTime: 0,
  warpScaleInv: 1,
  f: [0, 0, 0, 0],
  texelOffsetX: 0,
  texelOffsetY: 0,
});

describe("computeAspect", () => {
  it("maps the shorter dimension to [-1,1]", () => {
    const land = computeAspect(1600, 900);
    expect(land.aspectX).toBe(1);
    expect(land.aspectY).toBeCloseTo(900 / 1600, 6);
    const port = computeAspect(900, 1600);
    expect(port.aspectY).toBe(1);
    expect(port.aspectX).toBeCloseTo(900 / 1600, 6);
  });
});

describe("vertexRadAng", () => {
  it("rad is 0 at centre and 1 at corners", () => {
    const a = computeAspect(1000, 1000);
    expect(vertexRadAng(0, 0, a).rad).toBeCloseTo(0, 6);
    expect(vertexRadAng(1, 1, a).rad).toBeCloseTo(1, 6);
    expect(vertexRadAng(-1, -1, a).rad).toBeCloseTo(1, 6);
  });
});

describe("computeWarpUV", () => {
  const a = computeAspect(1000, 1000); // square → aspect 1, simplest

  it("identity transform maps centre to centre", () => {
    const { u, v } = computeWarpUV(0, 0, 0, identityParams(), noWarpFrame(), a);
    expect(u).toBeCloseTo(0.5, 6);
    expect(v).toBeCloseTo(0.5, 6);
  });

  it("identity maps a corner to a UV corner", () => {
    // top-right clip (1,1) → with y-flip, v near 0
    const { u, v } = computeWarpUV(1, 1, 1, identityParams(), noWarpFrame(), a);
    expect(u).toBeCloseTo(1.0, 6);
    expect(v).toBeCloseTo(0.0, 6);
  });

  it("zoom > 1 pulls samples toward the centre (magnifies)", () => {
    const p = identityParams();
    p.zoom = 2;
    const { u } = computeWarpUV(1, 0, 1, p, noWarpFrame(), a);
    // at zoom 2, the right edge samples u = 1*0.5*0.5 + 0.5 = 0.75 (inside)
    expect(u).toBeCloseTo(0.75, 6);
  });

  it("dx translation shifts the sample coordinate", () => {
    const p = identityParams();
    p.dx = 0.1;
    const { u } = computeWarpUV(0, 0, 0, p, noWarpFrame(), a);
    expect(u).toBeCloseTo(0.4, 6); // 0.5 - dx
  });

  it("90° rotation maps +x offset to +y (about centre)", () => {
    const p = identityParams();
    p.rot = Math.PI / 2;
    // a point on the +u axis from centre should rotate to the +v axis
    const { u, v } = computeWarpUV(1, 0, 1, p, noWarpFrame(), a);
    expect(u).toBeCloseTo(0.5, 5);
    expect(v).toBeCloseTo(1.0, 5);
  });
});

describe("warpCoefficients", () => {
  it("is deterministic and in the documented range", () => {
    const f = warpCoefficients(0);
    expect(f).toHaveLength(4);
    // f[0] = 11.68 + 4*cos(10)
    expect(f[0]).toBeCloseTo(11.68 + 4 * Math.cos(10), 6);
  });
});
