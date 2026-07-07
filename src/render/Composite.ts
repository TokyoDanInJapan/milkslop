/**
 * The composite pass (ShowToUser_NoShaders): present the feedback texture to
 * the screen, applying video echo, gamma, and the invert/brighten/darken/
 * solarize colour filters.
 *
 * In the original these are multiple additive draws; here they fold into one
 * fragment shader. Gamma multiplies brightness (gamma 2 ≈ the additive double
 * draw). Echo blends the main image with a zoomed/oriented copy.
 */

import { createFullscreenQuad, linkProgram } from "./gl.ts";

const VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform float uGamma;
uniform float uEchoZoom;
uniform float uEchoAlpha;
uniform int uEchoOrient;
uniform int uBrighten;
uniform int uDarken;
uniform int uSolarize;
uniform int uInvert;

void main() {
  vec3 m = texture(uTex, vUv).rgb;

  vec3 c = m;
  if (uEchoAlpha > 0.001) {
    vec2 euv = (vUv - 0.5) / uEchoZoom + 0.5;
    if ((uEchoOrient & 1) == 1) euv.x = 1.0 - euv.x;
    if (uEchoOrient >= 2) euv.y = 1.0 - euv.y;
    vec3 e = texture(uTex, euv).rgb;
    c = mix(m, e, uEchoAlpha);
  }

  c *= uGamma;

  if (uSolarize == 1) c = clamp(4.0 * c * (1.0 - c), 0.0, 1.0);
  if (uBrighten == 1) c = sqrt(clamp(c, 0.0, 1.0));
  if (uDarken == 1) c = c * c;
  if (uInvert == 1) c = 1.0 - c;

  fragColor = vec4(c, 1.0);
}`;

/** Parameters for the no-shader composite pass (gamma/echo/colour filters). */
export interface CompositeParams {
  gamma: number;
  echoZoom: number;
  echoAlpha: number;
  echoOrient: number;
  brighten: boolean;
  darken: boolean;
  solarize: boolean;
  invert: boolean;
}

/** The no-shader composite pass (gamma, video echo, colour filters). */
export class Composite {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private u: Record<string, WebGLUniformLocation | null>;

  /** Compile the composite shader and set up its GL resources. */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = linkProgram(gl, VS, FS);
    this.vao = createFullscreenQuad(gl);
    this.u = {};
    for (const name of [
      "uTex",
      "uGamma",
      "uEchoZoom",
      "uEchoAlpha",
      "uEchoOrient",
      "uBrighten",
      "uDarken",
      "uSolarize",
      "uInvert",
    ]) {
      this.u[name] = gl.getUniformLocation(this.prog, name);
    }
  }

  /** Draw `tex` to the currently-bound framebuffer (the screen). */
  render(tex: WebGLTexture, p: CompositeParams): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u.uTex!, 0);
    gl.uniform1f(this.u.uGamma!, p.gamma);
    gl.uniform1f(this.u.uEchoZoom!, p.echoZoom || 1);
    gl.uniform1f(this.u.uEchoAlpha!, p.echoAlpha);
    gl.uniform1i(this.u.uEchoOrient!, p.echoOrient & 3);
    gl.uniform1i(this.u.uBrighten!, p.brighten ? 1 : 0);
    gl.uniform1i(this.u.uDarken!, p.darken ? 1 : 0);
    gl.uniform1i(this.u.uSolarize!, p.solarize ? 1 : 0);
    gl.uniform1i(this.u.uInvert!, p.invert ? 1 : 0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
