/**
 * Final present to the screen: blits a single preset output, or crossfades two
 * preset outputs during a blend (mix by a cosine-eased progress, matching
 * MilkDrop's CosineInterp blend curve).
 */

import { createFullscreenQuad, linkProgram } from "./gl.ts";

const VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uA;   // new preset
uniform sampler2D uB;   // old preset
uniform float uMix;     // 0 = all old (B), 1 = all new (A)
void main() {
  vec3 a = texture(uA, vUv).rgb;
  vec3 b = texture(uB, vUv).rgb;
  fragColor = vec4(mix(b, a, uMix), 1.0);
}`;

/**
 * MilkDrop's cosine blend easing (`CosineInterp`): a smooth 0→1 S-curve.
 *
 * @param x - Linear progress (clamped to [0, 1]).
 * @returns The eased progress.
 */
export function cosineInterp(x: number): number {
  return 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, x)) * Math.PI);
}

/** Final present to the screen: blit one preset output, or crossfade two. */
export class Present {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uA: WebGLUniformLocation | null;
  private uB: WebGLUniformLocation | null;
  private uMix: WebGLUniformLocation | null;

  /** Compile the present/crossfade shader and set up its GL resources. */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = linkProgram(gl, VS, FS);
    this.vao = createFullscreenQuad(gl);
    this.uA = gl.getUniformLocation(this.prog, "uA");
    this.uB = gl.getUniformLocation(this.prog, "uB");
    this.uMix = gl.getUniformLocation(this.prog, "uMix");
  }

  /** Present `aTex`, optionally crossfading from `bTex` by eased `progress`. */
  toScreen(
    aTex: WebGLTexture,
    bTex: WebGLTexture | null,
    progress: number,
    w: number,
    h: number,
  ): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.viewport(0, 0, w, h);
    this.blit(aTex, bTex, progress);
  }

  /**
   * Same crossfade as {@link toScreen}, but rendered into an off-screen target
   * (its framebuffer + viewport). Used to snapshot the live composite so a blend
   * can be interrupted and restarted from exactly what's on screen, pop-free.
   */
  toTarget(
    aTex: WebGLTexture,
    bTex: WebGLTexture | null,
    progress: number,
    target: { fbo: WebGLFramebuffer; width: number; height: number },
  ): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.fbo);
    this.gl.viewport(0, 0, target.width, target.height);
    this.blit(aTex, bTex, progress);
  }

  /** Draw the crossfade quad into whatever framebuffer/viewport is bound. */
  private blit(
    aTex: WebGLTexture,
    bTex: WebGLTexture | null,
    progress: number,
  ): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, aTex);
    gl.uniform1i(this.uA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bTex ?? aTex);
    gl.uniform1i(this.uB, 1);
    gl.uniform1f(this.uMix, bTex ? cosineInterp(progress) : 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
