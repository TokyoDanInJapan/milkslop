/**
 * Shared per-frame uniform/sampler binding for MilkDrop shaders. Used by both
 * the composite pass (fullscreen) and the warp pass (mesh).
 */

import { Q_UNIFORMS, STD_SAMPLERS, userSamplerKey } from "./environment.ts";
import type { NoiseTextures } from "../render/NoiseTextures.ts";

/** Per-frame values bound to a preset shader's uniforms and samplers. */
export interface ShaderFrameState {
  time: number;
  fps: number;
  frame: number;
  progress: number;
  bass: number;
  mid: number;
  treb: number;
  bassAtt: number;
  midAtt: number;
  trebAtt: number;
  texW: number;
  texH: number;
  aspectX: number;
  aspectY: number;
  decay: number;
  randFrame: [number, number, number, number];
  randPreset: [number, number, number, number];
  /** Four animated hue_shader corner colours, flat RGB (length 12). */
  hueCorners: number[];
  q: Float64Array; // length 32
  mainTex: WebGLTexture;
  blur1: WebGLTexture;
  blur2: WebGLTexture;
  blur3: WebGLTexture;
  noise: NoiseTextures | null;
  /** User (image) sampler names this shader declares, e.g. `sampler_pifano`. */
  userSamplers?: string[];
  /** Registered user textures keyed by {@link userSamplerKey}. */
  userTextures?: Map<string, WebGLTexture>;
  /** Neutral 1×1 white fallback for a declared-but-unprovided user sampler. */
  whiteTex?: WebGLTexture;
}

/** Resolves a uniform name to its location (typically cached by the caller). */
export type LocFn = (name: string) => WebGLUniformLocation | null;

// GL sampler objects giving the fc/fw/pc/pw aliases their MilkDrop semantics
// (f=linear / p=nearest filtering, w=repeat / c=clamp addressing), cached per
// context.
const aliasSamplerCache = new WeakMap<
  WebGL2RenderingContext,
  Map<string, WebGLSampler>
>();

function aliasSamplersFor(
  gl: WebGL2RenderingContext,
): Map<string, WebGLSampler> {
  let m = aliasSamplerCache.get(gl);
  if (m) return m;
  m = new Map();
  const make = (filter: number, wrap: number): WebGLSampler => {
    const smp = gl.createSampler();
    gl.samplerParameteri(smp, gl.TEXTURE_MIN_FILTER, filter);
    gl.samplerParameteri(smp, gl.TEXTURE_MAG_FILTER, filter);
    gl.samplerParameteri(smp, gl.TEXTURE_WRAP_S, wrap);
    gl.samplerParameteri(smp, gl.TEXTURE_WRAP_T, wrap);
    return smp;
  };
  m.set("sampler_fw_main", make(gl.LINEAR, gl.REPEAT));
  m.set("sampler_fc_main", make(gl.LINEAR, gl.CLAMP_TO_EDGE));
  m.set("sampler_pw_main", make(gl.NEAREST, gl.REPEAT));
  m.set("sampler_pc_main", make(gl.NEAREST, gl.CLAMP_TO_EDGE));
  aliasSamplerCache.set(gl, m);
  return m;
}

/**
 * Bind the standard MilkDrop shader uniforms and samplers for one frame.
 *
 * @param gl - The WebGL2 context.
 * @param u - Uniform-location resolver for the active program.
 * @param s - This frame’s uniform values.
 */
export function bindShaderUniforms(
  gl: WebGL2RenderingContext,
  u: LocFn,
  s: ShaderFrameState,
): void {
  gl.uniform1f(u("time"), s.time);
  gl.uniform1f(u("fps"), s.fps);
  gl.uniform1f(u("frame"), s.frame);
  gl.uniform1f(u("progress"), s.progress);
  gl.uniform1f(u("bass"), s.bass);
  gl.uniform1f(u("mid"), s.mid);
  gl.uniform1f(u("treb"), s.treb);
  gl.uniform1f(u("bass_att"), s.bassAtt);
  gl.uniform1f(u("mid_att"), s.midAtt);
  gl.uniform1f(u("treb_att"), s.trebAtt);
  gl.uniform1f(u("decay"), s.decay);

  gl.uniform4f(u("texsize"), s.texW, s.texH, 1 / s.texW, 1 / s.texH);
  gl.uniform4f(u("aspect"), s.aspectX, s.aspectY, 1 / s.aspectX, 1 / s.aspectY);
  gl.uniform4f(u("rand_frame"), ...s.randFrame);
  gl.uniform4f(u("rand_preset"), ...s.randPreset);
  // hue_shader corner colours (comp pass only; warp leaves the array unused)
  const hueLoc = u("hue_shader_corners[0]");
  if (hueLoc) gl.uniform3fv(hueLoc, s.hueCorners);

  const t = s.time;
  gl.uniform4f(
    u("roam_cos"),
    0.5 + 0.5 * Math.cos(t * 0.329 + 1.2),
    0.5 + 0.5 * Math.cos(t * 1.293 + 3.9),
    0.5 + 0.5 * Math.cos(t * 5.07 + 2.5),
    0.5 + 0.5 * Math.cos(t * 20.051 + 5.4),
  );
  gl.uniform4f(
    u("roam_sin"),
    0.5 + 0.5 * Math.sin(t * 0.329 + 1.2),
    0.5 + 0.5 * Math.sin(t * 1.293 + 3.9),
    0.5 + 0.5 * Math.sin(t * 5.07 + 2.5),
    0.5 + 0.5 * Math.sin(t * 20.051 + 5.4),
  );
  gl.uniform4f(
    u("slow_roam_cos"),
    0.5 + 0.5 * Math.cos(t * 0.005 + 2.7),
    0.5 + 0.5 * Math.cos(t * 0.0085 + 5.3),
    0.5 + 0.5 * Math.cos(t * 0.0133 + 4.5),
    0.5 + 0.5 * Math.cos(t * 0.0217 + 3.8),
  );
  gl.uniform4f(
    u("slow_roam_sin"),
    0.5 + 0.5 * Math.sin(t * 0.005 + 2.7),
    0.5 + 0.5 * Math.sin(t * 0.0085 + 5.3),
    0.5 + 0.5 * Math.sin(t * 0.0133 + 4.5),
    0.5 + 0.5 * Math.sin(t * 0.0217 + 3.8),
  );

  for (let i = 0; i < 32; i++) gl.uniform1f(u(Q_UNIFORMS[i]!), s.q[i] ?? 0);

  // q1..q32 packed as float4s: _qa = q1..q4 … _qh = q29..q32
  for (let i = 0; i < 8; i++) {
    const name = `_q${String.fromCharCode(97 + i)}`;
    gl.uniform4f(
      u(name),
      s.q[i * 4] ?? 0,
      s.q[i * 4 + 1] ?? 0,
      s.q[i * 4 + 2] ?? 0,
      s.q[i * 4 + 3] ?? 0,
    );
  }

  const texFor = (name: string): WebGLTexture =>
    name === "sampler_blur1"
      ? s.blur1
      : name === "sampler_blur2"
        ? s.blur2
        : name === "sampler_blur3"
          ? s.blur3
          : s.mainTex;

  const aliasSamplers = aliasSamplersFor(gl);
  let unit = 0;
  for (const name of STD_SAMPLERS) {
    const loc = u(name);
    if (loc === null) continue;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texFor(name));
    // fc/fw/pc/pw share the main texture but carry their own filter/wrap
    // state via sampler objects; everything else uses the texture's own params
    gl.bindSampler(unit, aliasSamplers.get(name) ?? null);
    gl.uniform1i(loc, unit);
    unit++;
  }

  if (s.noise) {
    const n = s.noise;
    // 2D noise textures - each tier is a distinct feature scale
    const noise2D: [string, WebGLTexture][] = [
      ["sampler_noise_lq", n.noiseLQ],
      ["sampler_noise_mq", n.noiseMQ],
      ["sampler_noise_hq", n.noiseHQ],
      ["sampler_noise_lq_lite", n.noiseLQLite],
    ];
    for (const [name, tex] of noise2D) {
      const loc = u(name);
      if (loc === null) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindSampler(unit, null);
      gl.uniform1i(loc, unit++);
    }
    // 3D noise textures
    const noise3D: [string, WebGLTexture][] = [
      ["sampler_noisevol_lq", n.noiseVolLQ],
      ["sampler_noisevol_hq", n.noiseVolHQ],
    ];
    for (const [name, tex] of noise3D) {
      const loc = u(name);
      if (loc === null) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.bindSampler(unit, null);
      gl.uniform1i(loc, unit++);
    }

    // noise texsize uniforms: (size, size, 1/size, 1/size)
    gl.uniform4f(u("texsize_noise_lq"), 256, 256, 1 / 256, 1 / 256);
    gl.uniform4f(u("texsize_noise_mq"), 256, 256, 1 / 256, 1 / 256);
    gl.uniform4f(u("texsize_noise_hq"), 256, 256, 1 / 256, 1 / 256);
    gl.uniform4f(u("texsize_noise_lq_lite"), 32, 32, 1 / 32, 1 / 32);
    gl.uniform4f(u("texsize_noisevol_lq"), 32, 32, 1 / 32, 1 / 32);
    gl.uniform4f(u("texsize_noisevol_hq"), 32, 32, 1 / 32, 1 / 32);
  }

  // user (image) samplers: bind the dropped texture by name, else the neutral
  // white fallback so a declared-but-unprovided sampler reads white (1.0),
  // which is the identity for the common multiply usage rather than black.
  if (s.userSamplers) {
    for (const name of s.userSamplers) {
      const loc = u(name);
      if (loc === null) continue;
      const tex = s.userTextures?.get(userSamplerKey(name)) ?? s.whiteTex;
      if (!tex) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.bindSampler(unit, null);
      gl.uniform1i(loc, unit++);
    }
  }
}
