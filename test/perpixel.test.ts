import { describe, it, expect } from "vitest";
import { parseMilk, CompiledPreset } from "../src/preset/index.ts";
import {
  computeAspect,
  computeWarpUV,
  warpCoefficients,
  type WarpParams,
} from "../src/render/warp.ts";

// Mirrors the per-vertex loop in WarpMesh.render without WebGL, to verify the
// per_frame → per_pixel bridge and that warped UVs vary across the grid.
const preset = `
[preset00]
MILKDROP_PRESET_VERSION=201
zoom=1.0
rot=0.0
warp=0.0
per_frame_1=zoom = 1.0 + 0.1*bass;
per_pixel_1=zoom = zoom + 0.5*(0.5 - rad);
`;

describe("per_pixel integration", () => {
  it("bridges q-vars and motion vars, varying zoom across the grid", () => {
    const p = new CompiledPreset(parseMilk(preset));
    p.runInit({ bass: 0, time: 0 });
    const ctx = p.runPerFrame({ bass: 1.0, time: 0.5 });

    // per_frame set zoom = 1.0 + 0.1*1.0 = 1.1
    expect(ctx.vars.get("zoom")).toBeCloseTo(1.1, 5);

    const motion = {
      zoom: ctx.vars.get("zoom"),
      zoomexp: 1,
      rot: 0,
      warp: 0,
      cx: 0.5,
      cy: 0.5,
      dx: 0,
      dy: 0,
      sx: 1,
      sy: 1,
    };

    p.prepPerPixelFrame();
    const pp = p.ppCtx.vars;

    // vertex at centre (rad 0): per_pixel zoom = 1.1 + 0.5*0.5 = 1.35
    pp.set("rad", 0);
    pp.set("zoom", motion.zoom);
    p.runPerPixel();
    expect(pp.get("zoom")).toBeCloseTo(1.35, 5);

    // vertex at edge (rad 1): zoom = 1.1 + 0.5*(-0.5) = 0.85
    pp.set("rad", 1);
    pp.set("zoom", motion.zoom);
    p.runPerPixel();
    expect(pp.get("zoom")).toBeCloseTo(0.85, 5);
  });

  it("produces distinct warped UVs across grid vertices", () => {
    const aspect = computeAspect(1280, 720);
    const params: WarpParams = {
      zoom: 1.1,
      zoomExp: 1,
      rot: 0.1,
      warp: 0.5,
      cx: 0.5,
      cy: 0.5,
      dx: 0,
      dy: 0,
      sx: 1,
      sy: 1,
    };
    const frame = {
      warpTime: 1.0,
      warpScaleInv: 1,
      f: warpCoefficients(1.0),
      texelOffsetX: 0,
      texelOffsetY: 0,
    };
    const centre = computeWarpUV(0, 0, 0, params, frame, aspect);
    const corner = computeWarpUV(1, 1, 1, params, frame, aspect);
    expect(
      Math.hypot(centre.u - corner.u, centre.v - corner.v),
    ).toBeGreaterThan(0.1);
  });
});
