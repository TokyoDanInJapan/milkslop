/**
 * Builds a complete GLSL ES 3.00 fragment shader from a transpiled MilkDrop
 * shader body, supplying the uniforms, samplers, and helper functions the body
 * expects (the MilkDrop pixel-shader environment).
 */

import type { TranspileResult } from "./transpile.ts";

// Samplers always available to a preset shader. fc/fw/pc/pw are filter/wrap
// (fc/fw/pc/pw are filter/wrap variants of the main texture; they share the
// main texture but get their own GL sampler objects - f=linear/p=nearest,
// w=repeat/c=clamp - bound in bindUniforms.)
/** Samplers always declared for a preset shader. */
export const STD_SAMPLERS = [
  "sampler_main",
  "sampler_fc_main",
  "sampler_fw_main",
  "sampler_pc_main",
  "sampler_pw_main",
  "sampler_blur1",
  "sampler_blur2",
  "sampler_blur3",
];

/** The built-in noise samplers (their textures come from {@link NoiseTextures}). */
export const NOISE_SAMPLERS = [
  "sampler_noise_lq",
  "sampler_noise_mq",
  "sampler_noise_hq",
  "sampler_noise_lq_lite",
  "sampler_noisevol_lq",
  "sampler_noisevol_hq",
];

/** Every engine-provided sampler - anything else is a user (image) texture. */
export const BUILTIN_SAMPLERS = new Set([...STD_SAMPLERS, ...NOISE_SAMPLERS]);

/**
 * Registry key for a user sampler: strip the `sampler_` prefix and any leading
 * filter/wrap qualifier (`fc_`/`fw_`/`pc_`/`pw_`), lowercased. So
 * `sampler_fc_Pifano` and `sampler_pifano` both resolve to the dropped image
 * `pifano.<ext>`.
 *
 * @param samplerName - A full `sampler_<…>` identifier.
 * @returns The lowercased lookup key.
 */
export function userSamplerKey(samplerName: string): string {
  return samplerName
    .replace(/^sampler_/, "")
    .replace(/^(?:fc|fw|pc|pw)_/, "")
    .toLowerCase();
}

/**
 * The user (image) samplers a transpiled shader references - those declared in
 * its source that are not engine built-ins.
 *
 * @param samplers - The sampler set from a {@link TranspileResult}.
 * @returns The user sampler names (full `sampler_<…>` identifiers).
 */
export function userSamplersOf(samplers: Iterable<string>): string[] {
  return [...samplers].filter((s) => !BUILTIN_SAMPLERS.has(s));
}

const PROLOGUE = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

in vec2 vUv;
out vec4 fragColor;

// --- auto-bound scalar/vector uniforms ---
uniform float time, fps, frame, progress;
uniform float bass, mid, treb, bass_att, mid_att, treb_att;
uniform vec4 texsize;   // (w, h, 1/w, 1/h)
uniform vec4 aspect;    // (ax, ay, 1/ax, 1/ay)
uniform vec4 rand_frame, rand_preset;
uniform vec4 roam_cos, roam_sin, slow_roam_cos, slow_roam_sin;
// hue_shader: four animated corner colours (MilkDrop 2 milkdropfs.cpp:4129-4131),
// bilinearly interpolated across the screen in main(). Comp-pass only; the warp
// pass uses white (1,1,1).
uniform vec3 hue_shader_corners[4];
uniform float decay;
uniform float q1,q2,q3,q4,q5,q6,q7,q8,q9,q10,q11,q12,q13,q14,q15,q16;
uniform float q17,q18,q19,q20,q21,q22,q23,q24,q25,q26,q27,q28,q29,q30,q31,q32;

// q1..q32 packed as float4s (_qa = q1..q4, … _qh = q29..q32)
uniform vec4 _qa, _qb, _qc, _qd, _qe, _qf, _qg, _qh;

// noise texture size uniforms (xy=size, zw=1/size)
uniform vec4 texsize_noise_lq;
uniform vec4 texsize_noise_mq;
uniform vec4 texsize_noise_hq;
uniform vec4 texsize_noise_lq_lite;
uniform vec4 texsize_noisevol_lq;
uniform vec4 texsize_noisevol_hq;

// --- helper functions ---
float saturate(float x){ return clamp(x,0.0,1.0); }
vec2  saturate(vec2 x){ return clamp(x,0.0,1.0); }
vec3  saturate(vec3 x){ return clamp(x,0.0,1.0); }
vec4  saturate(vec4 x){ return clamp(x,0.0,1.0); }

// HLSL mul() - provide common matrix/vector orderings
vec2 mul(mat2 m, vec2 v){ return m*v; }
vec2 mul(vec2 v, mat2 m){ return v*m; }
vec3 mul(mat3 m, vec3 v){ return m*v; }
vec3 mul(vec3 v, mat3 m){ return v*m; }
vec4 mul(mat4 m, vec4 v){ return m*v; }
vec4 mul(vec4 v, mat4 m){ return v*m; }
float mul(float a, float b){ return a*b; }
// HLSL mul(vector, vector) is a dot product
float mul(vec2 a, vec2 b){ return dot(a,b); }
float mul(vec3 a, vec3 b){ return dot(a,b); }
float mul(vec4 a, vec4 b){ return dot(a,b); }
// Non-square matrix/vector products (HLSL floatRxC mul)
vec2 mul(mat3x2 m, vec3 v){ return m*v; }
vec3 mul(mat2x3 m, vec2 v){ return m*v; }
vec2 mul(mat4x2 m, vec4 v){ return m*v; }
vec4 mul(mat2x4 m, vec2 v){ return m*v; }
vec3 mul(mat4x3 m, vec4 v){ return m*v; }
vec4 mul(mat3x4 m, vec3 v){ return m*v; }

float lum(float c){ return c; }
float lum(vec2 c){ return dot(c, vec2(0.32,0.49)); }
float lum(vec3 c){ return dot(c, vec3(0.32,0.49,0.29)); }
float lum(vec4 c){ return dot(c.rgb, vec3(0.32,0.49,0.29)); }

// DX9-faithful sqrt/log/rsqrt: HLSL docs say these return NaN for negative
// arguments, but DX9 shader-model-3 hardware takes the absolute value instead -
// many MilkDrop presets rely on that (e.g. sqrt(x) of an x that goes negative
// across the screen). The same convention is documented in the MIT-licensed
// hlslparser (GLSLGenerator.cpp), as a faithful model of the DX9 hardware.
// Renamed (not overloaded onto the built-ins, which ANGLE rejects) and wrapped
// in abs().
float _sqrt(float x){ return sqrt(abs(x)); }
vec2  _sqrt(vec2  x){ return sqrt(abs(x)); }
vec3  _sqrt(vec3  x){ return sqrt(abs(x)); }
vec4  _sqrt(vec4  x){ return sqrt(abs(x)); }
float _rsqrt(float x){ return inversesqrt(abs(x)); }
vec2  _rsqrt(vec2  x){ return inversesqrt(abs(x)); }
vec3  _rsqrt(vec3  x){ return inversesqrt(abs(x)); }
vec4  _rsqrt(vec4  x){ return inversesqrt(abs(x)); }
float _logf(float x){ return log(abs(x)); }
vec2  _logf(vec2  x){ return log(abs(x)); }
vec3  _logf(vec3  x){ return log(abs(x)); }
vec4  _logf(vec4  x){ return log(abs(x)); }
float _log2f(float x){ return log2(abs(x)); }
vec2  _log2f(vec2  x){ return log2(abs(x)); }
vec3  _log2f(vec3  x){ return log2(abs(x)); }
vec4  _log2f(vec4  x){ return log2(abs(x)); }

// _powf: pow() renamed to avoid ANGLE's rejection of user overloads of built-in pow.
// Covers all genType x scalar-exponent combinations plus matching-type pairs.
// The base is wrapped in abs() for the same DX9-faithful reason as _sqrt (GLSL
// pow() is NaN for a negative base; DX9 hardware takes the magnitude).
float _powf(float v, float e){ return pow(abs(v), e); }
vec2  _powf(vec2  v, float e){ return pow(abs(v), vec2(e)); }
vec3  _powf(vec3  v, float e){ return pow(abs(v), vec3(e)); }
vec4  _powf(vec4  v, float e){ return pow(abs(v), vec4(e)); }
vec2  _powf(vec2  v, vec2  e){ return pow(abs(v), e); }
vec3  _powf(vec3  v, vec3  e){ return pow(abs(v), e); }
vec4  _powf(vec4  v, vec4  e){ return pow(abs(v), e); }

// _mix: lerp() renamed so we can overload for HLSL broadcast semantics.
// GLSL mix() can't be user-overloaded (ANGLE rejects it), so lerp→_mix.
float _mix(float a, float b, float t){ return mix(a, b, t); }
vec2  _mix(vec2  a, vec2  b, float t){ return mix(a, b, t); }
vec3  _mix(vec3  a, vec3  b, float t){ return mix(a, b, t); }
vec4  _mix(vec4  a, vec4  b, float t){ return mix(a, b, t); }
vec2  _mix(vec2  a, vec2  b, vec2  t){ return mix(a, b, t); }
vec3  _mix(vec3  a, vec3  b, vec3  t){ return mix(a, b, t); }
vec4  _mix(vec4  a, vec4  b, vec4  t){ return mix(a, b, t); }
// HLSL lerp broadcasts scalar second/third args to match the first arg's type
vec3  _mix(vec3 a, float b, float t){ return mix(a, vec3(b), t); }
vec3  _mix(vec3 a, float b, vec3  t){ return mix(a, vec3(b), t); }
vec3  _mix(float a, vec3 b, float t){ return mix(vec3(a), b, t); }
vec3  _mix(float a, vec3 b, vec3  t){ return mix(vec3(a), b, t); }
vec2  _mix(vec2 a, float b, float t){ return mix(a, vec2(b), t); }
vec2  _mix(float a, vec2 b, float t){ return mix(vec2(a), b, t); }
vec4  _mix(vec4 a, float b, float t){ return mix(a, vec4(b), t); }

// tex2D / tex3D as named functions so HLSL source compiles without tex→texture rename.
// tex2D returns vec3 (rgb), matching the most common HLSL float3 = tex2D(...) pattern.
vec3 tex2D(sampler2D s, vec2 uv){ return texture(s, uv).rgb; }
// vec3/vec4 UV overloads: some shaders pass a wider vector as UV (HLSL truncates to .xy).
vec3 tex2D(sampler2D s, vec3 uv){ return texture(s, uv.xy).rgb; }
vec3 tex2D(sampler2D s, vec4 uv){ return texture(s, uv.xy).rgb; }
// float UV overload: HLSL D3D9 broadcasts a scalar to float2 for tex2D.
vec3 tex2D(sampler2D s, float u){ return texture(s, vec2(u, u)).rgb; }
vec4 tex3D(sampler3D s, vec3 uvw){ return texture(s, uvw); }

// Common HLSL math constants
const float M_PI       = 3.14159265358979323846;
const float M_PI_2     = 1.57079632679489661923;
const float M_PI_4     = 0.78539816339744830962;
const float M_1_PI     = 0.31830988618379067154;
const float M_2_PI     = 0.63661977236758134308;
const float M_INV_PI_2 = 0.63661977236758134308;
`;

function declareSamplers(result: TranspileResult): string {
  const names = new Set<string>(STD_SAMPLERS);
  for (const s of result.samplers) names.add(s);
  return [...names]
    .map(
      (n) =>
        `uniform ${result.samplers3D.has(n) ? "sampler3D" : "sampler2D"} ${n};`,
    )
    .join("\n");
}

function blurHelpers(): string {
  return /* glsl */ `
vec3 GetMain(vec2 uv){ return texture(sampler_main, uv).rgb; }
vec3 GetPixel(vec2 uv){ return texture(sampler_main, uv).rgb; }
vec3 GetBlur0(vec2 uv){ return texture(sampler_main, uv).rgb; }
vec3 GetBlur1(vec2 uv){ return texture(sampler_blur1, uv).rgb; }
vec3 GetBlur2(vec2 uv){ return texture(sampler_blur2, uv).rgb; }
vec3 GetBlur3(vec2 uv){ return texture(sampler_blur3, uv).rgb; }
// vec3-UV overloads: some shaders pass a vec3 as UV (HLSL truncates to .xy).
vec3 GetMain(vec3 uv){ return texture(sampler_main, uv.xy).rgb; }
vec3 GetPixel(vec3 uv){ return texture(sampler_main, uv.xy).rgb; }
vec3 GetBlur0(vec3 uv){ return texture(sampler_main, uv.xy).rgb; }
vec3 GetBlur1(vec3 uv){ return texture(sampler_blur1, uv.xy).rgb; }
vec3 GetBlur2(vec3 uv){ return texture(sampler_blur2, uv.xy).rgb; }
vec3 GetBlur3(vec3 uv){ return texture(sampler_blur3, uv.xy).rgb; }
// float-UV overloads: HLSL broadcasts a scalar to float2 (GetPixel(0.5)).
vec3 GetMain(float u){ return texture(sampler_main, vec2(u)).rgb; }
vec3 GetPixel(float u){ return texture(sampler_main, vec2(u)).rgb; }
vec3 GetBlur0(float u){ return texture(sampler_main, vec2(u)).rgb; }
vec3 GetBlur1(float u){ return texture(sampler_blur1, vec2(u)).rgb; }
vec3 GetBlur2(float u){ return texture(sampler_blur2, vec2(u)).rgb; }
vec3 GetBlur3(float u){ return texture(sampler_blur3, vec2(u)).rgb; }
`;
}

/** Which kind of preset shader is being assembled. */
export type ShaderKind = "warp" | "comp";

/**
 * Assemble the full fragment shader. For a warp shader `uv` is the per-vertex
 * warped coordinate (interpolated from the mesh); for a comp shader it is the
 * screen coordinate.
 *
 * @param result - The transpiled shader body plus its declared samplers/uniforms.
 * @param kind - Whether this is a `"warp"` or `"comp"` shader.
 * @returns The complete GLSL ES fragment shader source.
 */
export function buildFragmentShader(
  result: TranspileResult,
  kind: ShaderKind,
): string {
  // hue_shader: bilinear blend of the four animated corner colours across the
  // screen (comp pass only - see ApplyHueShaderColors); the warp pass gets white.
  const hueExpr =
    kind === "comp"
      ? `hue_shader_corners[0]*uv_orig.x*uv_orig.y` +
        ` + hue_shader_corners[1]*(1.0-uv_orig.x)*uv_orig.y` +
        ` + hue_shader_corners[2]*uv_orig.x*(1.0-uv_orig.y)` +
        ` + hue_shader_corners[3]*(1.0-uv_orig.x)*(1.0-uv_orig.y)`
      : `vec3(1.0)`;
  const main = /* glsl */ `
void main() {
  vec2 uv = vUv;
  vec2 uv_orig = vUv;
  vec3 ret = vec3(0.0);
  vec2 _d = (uv - 0.5);
  float rad = length(_d * 2.0 * aspect.xy);
  float ang = atan(_d.y, _d.x);
  vec4 _return_value = vec4(0.0);
  // Local shadows of q-uniforms so shaders can write to q-variables
  float q1=q1,q2=q2,q3=q3,q4=q4,q5=q5,q6=q6,q7=q7,q8=q8;
  float q9=q9,q10=q10,q11=q11,q12=q12,q13=q13,q14=q14,q15=q15,q16=q16;
  float q17=q17,q18=q18,q19=q19,q20=q20,q21=q21,q22=q22,q23=q23,q24=q24;
  float q25=q25,q26=q26,q27=q27,q28=q28,q29=q29,q30=q30,q31=q31,q32=q32;
  // Shadows for other writeable uniforms some shaders assign to
  vec4 rand_preset=rand_preset;
  vec3 hue_shader=${hueExpr};
${indent(result.body)}
  // Sanitise the output to match MilkDrop 2's 8-bit (RGBA8) feedback,
  // which Milkslop emulates on its RGBA16F buffer (16F keeps the smoother decay
  // gradients but, unlike RGBA8, also faithfully *stores* NaN/Inf and any value
  // outside [0,1]). Two consequences a preset's shader math can trigger:
  //   • NaN (e.g. sqrt(negative), normalize(0)) - RGBA8 flushes it to 0 on write;
  //     16F keeps it, and bilinear feedback sampling then spreads it until the
  //     whole frame goes black. Scrub NaN → 0 to match.
  //   • values > 1 - RGBA8 clamps every feedback write to [0,1]; 16F lets them
  //     accumulate, which turns sharpening-style feedback (out += noise*detail)
  //     into runaway RGB static. Clamp to [0,1] to match.
  ret = mix(ret, vec3(0.0), notEqual(ret, ret)); // NaN → 0
  ret = clamp(ret, vec3(0.0), vec3(1.0)); // match RGBA8's [0,1] feedback range
  fragColor = vec4(ret, ${kind === "warp" ? "1.0" : "1.0"});
}
`;
  return [
    PROLOGUE,
    declareSamplers(result),
    blurHelpers(),
    result.preamble,
    main,
  ].join("\n");
}

function indent(code: string): string {
  return code
    .split("\n")
    .map((l) => (l.trim() ? "  " + l : l))
    .join("\n");
}

/** Names of the per-q uniforms (`q1`..`q32`), used for binding. */
export const Q_UNIFORMS = Array.from({ length: 32 }, (_, i) => `q${i + 1}`);
