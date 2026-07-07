/**
 * Composite shader pass: a fullscreen quad running a transpiled MilkDrop comp
 * shader. Per-frame uniforms come from the shared binder. (The warp shader pass
 * lives in WarpMesh, which owns the per-vertex geometry.)
 */

import { linkProgram } from "../render/gl.ts";
import { bindShaderUniforms, type ShaderFrameState } from "./bindUniforms.ts";

export type { ShaderFrameState } from "./bindUniforms.ts";

const FULLSCREEN_VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

/** A fullscreen composite shader pass running a transpiled preset comp shader. */
export class ShaderPass {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private loc = new Map<string, WebGLUniformLocation | null>();

  /**
   * Link the comp shader program.
   *
   * @param gl - The WebGL2 context.
   * @param fragmentSrc - The transpiled fragment shader source.
   * @param vao - A fullscreen-quad VAO to draw with (shared, not owned).
   */
  constructor(
    gl: WebGL2RenderingContext,
    fragmentSrc: string,
    vao: WebGLVertexArrayObject,
  ) {
    this.gl = gl;
    this.prog = linkProgram(gl, FULLSCREEN_VS, fragmentSrc);
    this.vao = vao;
  }

  private u = (name: string): WebGLUniformLocation | null => {
    let l = this.loc.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.loc.set(name, l);
    }
    return l;
  };

  /** Activate the program and upload the per-frame uniforms from `s`. */
  bindUniforms(s: ShaderFrameState): void {
    this.gl.useProgram(this.prog);
    bindShaderUniforms(this.gl, this.u, s);
  }

  /** Draw the fullscreen quad (call after {@link bindUniforms}). */
  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
