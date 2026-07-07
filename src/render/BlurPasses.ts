/**
 * Three-level separable Gaussian blur (`blur1`/`blur2`/`blur3`), consumed by
 * preset composite/warp shaders via `GetBlur1/2/3`.
 *
 * @remarks
 * Ported in spirit from `BlurPasses` (milkdropfs.cpp:1584): the 16-tap weight
 * kernel `4, 3.8, 3.5, 2.9, 1.9, 1.2, 0.7, 0.3` applied as horizontal then
 * vertical passes, each level at half the previous resolution.
 *
 * The original compresses each level into `[blur_min, blur_max]` for 8-bit
 * storage and re-expands in `GetBlur`; the round trip is identity *except*
 * that storage saturation clamps the effective output to `[min, max]`. With
 * float targets we reproduce that by clamping directly at the end of each
 * level. Level 1 also applies the `blur1_edge_darken` fade
 * (milkdropfs.cpp:1740: factor `(1-ed) + ed·saturate(5·distToEdge)`).
 */

import { createFullscreenQuad, linkProgram } from "./gl.ts";
import { RenderTarget } from "./RenderTarget.ts";
import { constants } from "../config.ts";

/** Per-frame blur range/edge values (post-equation `blur*` variables). */
export interface BlurParams {
  mins: [number, number, number];
  maxs: [number, number, number];
  edgeDarken: number;
}

/**
 * Sanitise the per-level blur ranges like `GetSafeBlurMinMax`
 * (milkdropfs.cpp:1551): later levels' ranges can only narrow, and a
 * too-small gap is pushed back apart. (The original assigns `avg - dist/2`
 * to both ends - an evident typo that would zero the range; we use the
 * intended `avg ± dist/2`.)
 */
export function safeBlurMinMax(p: BlurParams): {
  mins: number[];
  maxs: number[];
} {
  const mins = [...p.mins];
  const maxs = [...p.maxs];
  const dist = constants.blur.minDistance;
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      maxs[i] = Math.min(maxs[i - 1]!, maxs[i]!);
      mins[i] = Math.max(mins[i - 1]!, mins[i]!);
    }
    if (maxs[i]! - mins[i]! < dist) {
      const avg = (mins[i]! + maxs[i]!) * 0.5;
      mins[i] = avg - dist * 0.5;
      maxs[i] = avg + dist * 0.5;
    }
  }
  return { mins, maxs };
}

const VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

/** Format a number as a GLSL float literal (always with a decimal point). */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

// symmetric 16-tap (8 each side) using MilkDrop's weights + edge-darken scale,
// both from config.constants.blur
const KERNEL = constants.blur.kernel.map(glslFloat);
const EDGE_SCALE = glslFloat(constants.blur.edgeDarkenScale);
const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uDir;   // texel step along blur axis
uniform vec2 uClamp; // (blur_min, blur_max) for this level
uniform vec2 uEdge;  // (1-edge_darken, edge_darken); (1,0) disables
const float w0=${KERNEL[0]},w1=${KERNEL[1]},w2=${KERNEL[2]},w3=${KERNEL[3]},w4=${KERNEL[4]},w5=${KERNEL[5]},w6=${KERNEL[6]},w7=${KERNEL[7]};
void main() {
  float wsum = w0 + 2.0*(w1+w2+w3+w4+w5+w6+w7);
  vec3 c = texture(uSrc, vUv).rgb * w0;
  c += (texture(uSrc, vUv + uDir*1.0).rgb + texture(uSrc, vUv - uDir*1.0).rgb) * w1;
  c += (texture(uSrc, vUv + uDir*2.0).rgb + texture(uSrc, vUv - uDir*2.0).rgb) * w2;
  c += (texture(uSrc, vUv + uDir*3.0).rgb + texture(uSrc, vUv - uDir*3.0).rgb) * w3;
  c += (texture(uSrc, vUv + uDir*4.0).rgb + texture(uSrc, vUv - uDir*4.0).rgb) * w4;
  c += (texture(uSrc, vUv + uDir*5.0).rgb + texture(uSrc, vUv - uDir*5.0).rgb) * w5;
  c += (texture(uSrc, vUv + uDir*6.0).rgb + texture(uSrc, vUv - uDir*6.0).rgb) * w6;
  c += (texture(uSrc, vUv + uDir*7.0).rgb + texture(uSrc, vUv - uDir*7.0).rgb) * w7;
  c /= wsum;
  // clamp to the level's [blur_min, blur_max] (the original's storage
  // saturation), then darken toward the texture edges on level 1
  c = clamp(c, vec3(uClamp.x), vec3(uClamp.y));
  float d = min(min(vUv.x, vUv.y), 1.0 - max(vUv.x, vUv.y));
  c *= uEdge.x + uEdge.y * clamp(d * ${EDGE_SCALE}, 0.0, 1.0);
  fragColor = vec4(c, 1.0);
}`;

/** The three-level separable blur chain feeding `GetBlur1/2/3`. */
export class BlurPasses {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uSrc: WebGLUniformLocation | null;
  private uDir: WebGLUniformLocation | null;
  private uClamp: WebGLUniformLocation | null;
  private uEdge: WebGLUniformLocation | null;

  /** The blur1/2/3 output targets (downsampled /2, /4, /8). */
  readonly levels: RenderTarget[];
  // per-level temp for the horizontal pass
  private temps: RenderTarget[];

  /** Allocate the three blur levels (and their temps) from a base size. */
  constructor(gl: WebGL2RenderingContext, baseW: number, baseH: number) {
    this.gl = gl;
    this.prog = linkProgram(gl, VS, FS);
    this.vao = createFullscreenQuad(gl);
    this.uSrc = gl.getUniformLocation(this.prog, "uSrc");
    this.uDir = gl.getUniformLocation(this.prog, "uDir");
    this.uClamp = gl.getUniformLocation(this.prog, "uClamp");
    this.uEdge = gl.getUniformLocation(this.prog, "uEdge");
    this.levels = [];
    this.temps = [];
    for (let i = 0; i < 3; i++) {
      const div = 2 << i; // /2, /4, /8
      this.levels.push(
        new RenderTarget(
          gl,
          Math.max(1, baseW / div),
          Math.max(1, baseH / div),
        ),
      );
      this.temps.push(
        new RenderTarget(
          gl,
          Math.max(1, baseW / div),
          Math.max(1, baseH / div),
        ),
      );
    }
  }

  /** Resize all three blur levels (and temps) to a new base size. */
  resize(baseW: number, baseH: number): void {
    for (let i = 0; i < 3; i++) {
      const div = 2 << i;
      this.levels[i]!.resize(
        Math.max(1, baseW / div),
        Math.max(1, baseH / div),
      );
      this.temps[i]!.resize(Math.max(1, baseW / div), Math.max(1, baseH / div));
    }
  }

  /** Generate blur1/2/3 from `source` (the warped feedback texture). */
  generate(source: WebGLTexture, params?: BlurParams): void {
    const gl = this.gl;
    const safe = params
      ? safeBlurMinMax(params)
      : { mins: [0, 0, 0], maxs: [1, 1, 1] };
    const ed = params?.edgeDarken ?? 0;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uSrc, 0);

    let src = source;
    for (let i = 0; i < 3; i++) {
      const lvl = this.levels[i]!;
      const tmp = this.temps[i]!;
      // horizontal: src → tmp (no clamp/edge mid-level)
      tmp.bind();
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform2f(this.uDir, 1 / lvl.width, 0);
      gl.uniform2f(this.uClamp, -1e6, 1e6);
      gl.uniform2f(this.uEdge, 1, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // vertical: tmp → lvl, with the level's range clamp; edge darken is
      // applied on level 1 only (milkdropfs.cpp:1740 - repeating it would
      // paint black bands into the heavier levels)
      lvl.bind();
      gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
      gl.uniform2f(this.uDir, 0, 1 / lvl.height);
      gl.uniform2f(this.uClamp, safe.mins[i]!, safe.maxs[i]!);
      if (i === 0) gl.uniform2f(this.uEdge, 1 - ed, ed);
      else gl.uniform2f(this.uEdge, 1, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      src = lvl.tex; // next level blurs the previous
    }
    gl.bindVertexArray(null);
  }
}
