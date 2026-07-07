import { describe, it, expect } from "vitest";
import {
  bindShaderUniforms,
  type ShaderFrameState,
} from "../src/shader/bindUniforms.ts";

/**
 * bindUniforms drives a WebGL2 context but performs no rendering itself, so a
 * recording fake is enough to verify the binding contract: which uniforms get
 * which values, and how texture units are allocated.
 */

interface Call {
  fn: string;
  args: unknown[];
}

function makeFakeGl(): { gl: WebGL2RenderingContext; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (fn: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
      return ret;
    };
  const gl = {
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_3D: 0x806f,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    uniform1f: record("uniform1f"),
    uniform1i: record("uniform1i"),
    uniform3fv: record("uniform3fv"),
    uniform4f: record("uniform4f"),
    activeTexture: record("activeTexture"),
    bindTexture: record("bindTexture"),
    bindSampler: record("bindSampler"),
    createSampler: record("createSampler", { fake: "sampler" }),
    samplerParameteri: record("samplerParameteri"),
  } as unknown as WebGL2RenderingContext;
  return { gl, calls };
}

/** A frame state with recognisable values and distinct texture sentinels. */
function makeState(): ShaderFrameState {
  return {
    time: 2,
    fps: 60,
    frame: 7,
    progress: 0.25,
    bass: 1.1,
    mid: 1.2,
    treb: 1.3,
    bassAtt: 0.9,
    midAtt: 0.8,
    trebAtt: 0.7,
    texW: 640,
    texH: 480,
    aspectX: 1,
    aspectY: 0.75,
    decay: 0.98,
    randFrame: [0.1, 0.2, 0.3, 0.4],
    randPreset: [0.5, 0.6, 0.7, 0.8],
    hueCorners: Array.from({ length: 12 }, (_, i) => i / 12),
    q: Float64Array.from({ length: 32 }, (_, i) => i + 1),
    mainTex: { tex: "main" },
    blur1: { tex: "blur1" },
    blur2: { tex: "blur2" },
    blur3: { tex: "blur3" },
    noise: null,
  };
}

/** LocFn resolving every name to a per-name sentinel location. */
function makeLocFn(resolved: Map<string, object>, unresolved?: Set<string>) {
  return (name: string): WebGLUniformLocation | null => {
    if (unresolved?.has(name)) return null;
    let loc = resolved.get(name);
    if (!loc) resolved.set(name, (loc = { name }));
    return loc;
  };
}

function callsFor(calls: Call[], fn: string): Call[] {
  return calls.filter((c) => c.fn === fn);
}

function uniformValue(
  calls: Call[],
  fn: string,
  locs: Map<string, object>,
  name: string,
): unknown[] | undefined {
  return callsFor(calls, fn).find((c) => c.args[0] === locs.get(name))?.args;
}

describe("bindShaderUniforms", () => {
  it("binds the scalar, vec4, and packed q uniforms with frame values", () => {
    const { gl, calls } = makeFakeGl();
    const locs = new Map<string, object>();
    const s = makeState();
    bindShaderUniforms(gl, makeLocFn(locs), s);

    expect(uniformValue(calls, "uniform1f", locs, "bass")).toEqual([
      locs.get("bass"),
      1.1,
    ]);
    expect(uniformValue(calls, "uniform1f", locs, "decay")).toEqual([
      locs.get("decay"),
      0.98,
    ]);
    // texsize carries the reciprocals in zw
    expect(uniformValue(calls, "uniform4f", locs, "texsize")).toEqual([
      locs.get("texsize"),
      640,
      480,
      1 / 640,
      1 / 480,
    ]);
    // q1..q32 individually…
    expect(uniformValue(calls, "uniform1f", locs, "q1")).toEqual([
      locs.get("q1"),
      1,
    ]);
    expect(uniformValue(calls, "uniform1f", locs, "q32")).toEqual([
      locs.get("q32"),
      32,
    ]);
    // …and packed four-wide: _qh = q29..q32
    expect(uniformValue(calls, "uniform4f", locs, "_qh")).toEqual([
      locs.get("_qh"),
      29,
      30,
      31,
      32,
    ]);
    expect(
      uniformValue(calls, "uniform3fv", locs, "hue_shader_corners[0]"),
    ).toBeDefined();
  });

  it("allocates sequential texture units and routes blur/main textures", () => {
    const { gl, calls } = makeFakeGl();
    const locs = new Map<string, object>();
    const s = makeState();
    bindShaderUniforms(gl, makeLocFn(locs), s);

    const binds = callsFor(calls, "bindTexture").map((c) => c.args[1]);
    // STD_SAMPLERS order: main + 4 aliases (main tex), then blur1/2/3
    expect(binds.slice(0, 8)).toEqual([
      s.mainTex,
      s.mainTex,
      s.mainTex,
      s.mainTex,
      s.mainTex,
      s.blur1,
      s.blur2,
      s.blur3,
    ]);
    // units are sequential starting at 0
    const units = callsFor(calls, "uniform1i").map((c) => c.args[1]);
    expect(units).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // the four fc/fw/pc/pw aliases carry sampler objects; the rest bind null
    const samplers = callsFor(calls, "bindSampler").map((c) => c.args[1]);
    expect(samplers[0]).toBeNull(); // sampler_main
    expect(samplers.slice(1, 5).every((x) => x !== null)).toBe(true);
    expect(samplers.slice(5).every((x) => x === null)).toBe(true);
  });

  it("skips samplers the program does not declare (null locations)", () => {
    const { gl, calls } = makeFakeGl();
    const locs = new Map<string, object>();
    const unresolved = new Set([
      "sampler_fc_main",
      "sampler_fw_main",
      "sampler_pc_main",
      "sampler_pw_main",
      "sampler_blur2",
      "sampler_blur3",
    ]);
    bindShaderUniforms(gl, makeLocFn(locs, unresolved), makeState());
    const binds = callsFor(calls, "bindTexture").map((c) => c.args[1]);
    expect(binds.length).toBe(2); // sampler_main + sampler_blur1 only
    const units = callsFor(calls, "uniform1i").map((c) => c.args[1]);
    expect(units).toEqual([0, 1]); // no unit gaps for skipped samplers
  });

  it("binds a dropped user texture by name and falls back to white", () => {
    const { gl, calls } = makeFakeGl();
    const locs = new Map<string, object>();
    const s = makeState();
    const pifano = { tex: "pifano" } as unknown as WebGLTexture;
    const white = { tex: "white" } as unknown as WebGLTexture;
    s.userSamplers = ["sampler_pifano", "sampler_missing"];
    s.userTextures = new Map([["pifano", pifano]]);
    s.whiteTex = white;
    bindShaderUniforms(gl, makeLocFn(locs), s);
    const binds = callsFor(calls, "bindTexture").map((c) => c.args[1]);
    expect(binds).toContain(pifano);
    expect(binds).toContain(white);
  });
});
