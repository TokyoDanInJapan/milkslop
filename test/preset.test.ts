import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMilk, CompiledPreset } from "../src/preset/index.ts";

const sample = readFileSync(
  fileURLToPath(new URL("./fixtures/sample.milk", import.meta.url)),
  "utf8",
);

describe("parseMilk", () => {
  const p = parseMilk(sample, "sample");

  it("reads scalar params with correct keys/values", () => {
    expect(p.vals.decay).toBeCloseTo(0.96, 5);
    expect(p.vals.gamma).toBeCloseTo(1.8, 5);
    expect(p.vals.zoom).toBeCloseTo(1.01, 5);
    expect(p.vals.rot).toBeCloseTo(0.02, 5);
    expect(p.vals.warp).toBeCloseTo(0.8, 5);
    expect(p.vals.wave_r).toBeCloseTo(0.8, 5);
    expect(p.vals.mv_x).toBeCloseTo(12, 5); // nMotionVectorsX → mv_x
    expect(p.vals.echo_zoom).toBeCloseTo(1.5, 5);
  });

  it("maps booleans to 0/1", () => {
    expect(p.vals.wave_additive).toBe(1);
    expect(p.vals.wave_thick).toBe(1);
    expect(p.vals.wave_brighten).toBe(1);
    expect(p.vals.invert).toBe(0);
  });

  it("falls back to defaults for absent keys", () => {
    expect(p.vals.echo_alpha).toBeCloseTo(0, 5);
    expect(p.vals.ib_r).toBeCloseTo(0.25, 5); // default, not in file
    expect(p.vals.mv_l).toBeCloseTo(0.9, 5);
    expect(p.vals.blur1_edge_darken).toBeCloseTo(0.25, 5);
  });

  it("assembles multi-line code blocks", () => {
    expect(p.perFrameInitCode).toContain("mybass = 0");
    // EEL lines concatenate with no separator (MilkDrop semantics) - count
    // statements rather than lines.
    expect(p.perFrameCode.split(";").filter((x) => x.trim())).toHaveLength(5);
    expect(p.perFrameCode).toContain("zoom = zoom + 0.02*sin(time*0.31)");
    expect(p.perPixelCode.split(";").filter((x) => x.trim())).toHaveLength(2);
  });

  it("detects PS versions from the version header", () => {
    expect(p.presetVersion).toBe(201);
    expect(p.warpPSVersion).toBe(2);
    expect(p.compPSVersion).toBe(2);
    expect(p.warpShader).toContain("tex2D(sampler_main");
  });

  it("parses enabled custom wave with its code blocks", () => {
    const enabledWaves = p.waves.filter((w) => w.enabled);
    expect(enabledWaves).toHaveLength(1);
    const w = enabledWaves[0]!;
    expect(w.index).toBe(0);
    expect(w.samples).toBe(512);
    expect(w.drawThick).toBe(true);
    expect(w.additive).toBe(true);
    expect(w.perPointCode).toContain("cos(sample*6.28)");
  });

  it("leaves disabled waves/shapes flagged off", () => {
    expect(p.waves.filter((w) => w.enabled)).toHaveLength(1);
    expect(p.shapes.filter((s) => s.enabled)).toHaveLength(0);
  });
});

describe("parseMilk edge cases", () => {
  it("strips a leading backtick from code lines (literal-escape)", () => {
    const p = parseMilk(
      "[preset00]\nMILKDROP_PRESET_VERSION=201\nper_frame_1=`zoom = 1.0;\nper_frame_2=` rot = 0.1;",
      "bt",
    );
    expect(p.perFrameCode).toBe("zoom = 1.0; rot = 0.1;");
  });

  it("stops assembling a code block at the first missing index", () => {
    const p = parseMilk(
      "[preset00]\nper_frame_1=a=1;\nper_frame_2=b=2;\nper_frame_4=d=4;",
      "gap",
    );
    // per_frame_3 is missing, so per_frame_4 is not included
    expect(p.perFrameCode).toBe("a=1;b=2;");
  });

  it("forces PS version to 0 when shader text is absent", () => {
    const p = parseMilk(
      "[preset00]\nMILKDROP_PRESET_VERSION=201\nPSVERSION=2",
      "noshader",
    );
    expect(p.warpPSVersion).toBe(0);
    expect(p.compPSVersion).toBe(0);
  });

  it("treats pre-2.0 presets as no-shader regardless of keys", () => {
    const p = parseMilk(
      "[preset00]\nMILKDROP_PRESET_VERSION=100\nwarp_1=`shader_body{ret=0;}",
      "old",
    );
    expect(p.warpPSVersion).toBe(0);
  });
});

describe("CompiledPreset", () => {
  it("compiles and runs init + per_frame, producing usable outputs", () => {
    const preset = new CompiledPreset(parseMilk(sample));
    preset.runInit({ bass: 0, time: 0, frame: 0 });

    // frame 1: bass spikes; per_frame should move zoom/rot and set q1
    const ctx = preset.runPerFrame({ bass: 2.0, time: 1.0, frame: 1 });

    // mybass = 0*0.9 + 2*0.1 = 0.2 ; q1 = mybass
    expect(ctx.vars.get("q1")).toBeCloseTo(0.2, 5);
    // zoom started at baseline 1.01, then += 0.02*sin(0.31)
    expect(ctx.vars.get("zoom")).toBeGreaterThan(1.0);
    // wave_r = 0.5 + 0.5*sin(1.3)
    expect(ctx.vars.get("wave_r")).toBeCloseTo(0.5 + 0.5 * Math.sin(1.3), 5);
  });

  it("only compiles enabled custom waves/shapes", () => {
    const preset = new CompiledPreset(parseMilk(sample));
    expect(preset.waves).toHaveLength(1);
    expect(preset.shapes).toHaveLength(0);
    expect(preset.waves[0]!.perPoint).not.toBeNull();
  });

  it("persists user vars across frames but re-seeds q from init", () => {
    const preset = new CompiledPreset(parseMilk(sample));
    preset.runInit({ bass: 0, time: 0, frame: 0 });
    const c1 = preset.runPerFrame({ bass: 2.0, time: 1.0, frame: 1 });
    const mybass1 = c1.vars.get("mybass");
    const c2 = preset.runPerFrame({ bass: 2.0, time: 1.033, frame: 2 });
    const mybass2 = c2.vars.get("mybass");
    // mybass is a user var that accumulates frame-to-frame
    expect(mybass2).toBeGreaterThan(mybass1);
  });

  it("re-seeds scalar baseline each frame (LoadPerFrameEvallibVars semantics)", () => {
    // zoom=1.5 in .milk; per_frame doubles it.  Without re-seeding, frame 2
    // would see zoom=3.0 and output 6.0.  With re-seeding it always outputs 3.0.
    const preset = new CompiledPreset(
      parseMilk("[preset00]\nzoom=1.5\nper_frame_1=zoom=zoom*2;", "reseed"),
    );
    preset.runInit({});
    const c1 = preset.runPerFrame({ time: 1, frame: 1 });
    expect(c1.vars.get("zoom")).toBeCloseTo(3.0, 5);
    const c2 = preset.runPerFrame({ time: 2, frame: 2 });
    expect(c2.vars.get("zoom")).toBeCloseTo(3.0, 5); // still 3.0, not 6.0
  });

  it("progress is passed through and clamped to [0,1]", () => {
    const preset = new CompiledPreset(
      parseMilk("[preset00]\nper_frame_1=out=progress;", "prog"),
    );
    preset.runInit({});
    const c = preset.runPerFrame({ time: 1, frame: 1, progress: 0.4 });
    expect(c.vars.get("out")).toBeCloseTo(0.4, 5);
  });

  it("blur variable names match C EEL registration (blur1_min not blur1min)", () => {
    const p = parseMilk("[preset00]\nb1n=0.1\nb1x=0.9\n", "blur");
    expect(p.vals["blur1_min"]).toBeCloseTo(0.1, 5);
    expect(p.vals["blur1_max"]).toBeCloseTo(0.9, 5);
    // Verify it seeds into EEL with the underscore names
    const preset = new CompiledPreset(
      parseMilk("[preset00]\nb1n=0.2\nper_frame_1=out=blur1_min;", "blur_eel"),
    );
    preset.runInit({});
    const c = preset.runPerFrame({ time: 1, frame: 1 });
    expect(c.vars.get("out")).toBeCloseTo(0.2, 5);
  });
});

describe("preset library smoke tests", () => {
  // Use only the generated, feature-covering test set (test/presets-gen) so the
  // unit suite is self-contained and license-free - no dependency on the
  // user-authored corpus. Regenerate with `npx tsx scripts/gen-test-presets.mjs`.
  const presetsDir = fileURLToPath(new URL("./presets-gen", import.meta.url));
  const files = existsSync(presetsDir)
    ? readdirSync(presetsDir).filter((f) => f.endsWith(".milk"))
    : [];

  it("generated preset set is present", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`parses, compiles, and runs one frame: ${f}`, () => {
      const text = readFileSync(`${presetsDir}/${f}`, "utf8");
      const compiled = new CompiledPreset(parseMilk(text, f));
      compiled.runInit({ bass: 0, time: 0, frame: 0 });
      expect(() =>
        compiled.runPerFrame({ bass: 1.0, time: 1.0, frame: 1 }),
      ).not.toThrow();
    });
  }
});
