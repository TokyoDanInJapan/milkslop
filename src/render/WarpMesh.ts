/**
 * The warp blit: draws a gridX×gridY mesh that samples the previous frame at
 * per-vertex warped UVs (computeWarpUV) and multiplies by decay. This is the
 * "WarpedBlit_NoShaders" pass - the feedback warp that defines a preset's motion.
 *
 * Coordinate note: warp.ts produces D3D-oriented UVs (v=0 at top). GL textures
 * have v=0 at the bottom, so the fragment shader samples (u, 1-v) to keep the
 * feedback self-consistent. The composite then needs no flip.
 */

import { linkProgram } from "./gl.ts";
import {
  computeWarpUV,
  vertexRadAng,
  warpCoefficients,
  type Aspect,
  type WarpFrame,
  type WarpParams,
} from "./warp.ts";
import {
  bindShaderUniforms,
  type ShaderFrameState,
} from "../shader/bindUniforms.ts";
import type { CompiledPreset } from "../preset/CompiledPreset.ts";
import { tunables } from "../config.ts";

const VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// VS for the warp-shader path: pre-flips v so the transpiled shader's
// texture(sampler_main, uv) stays consistent with the GL feedback orientation.
const WARP_SHADER_VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = vec2(aUv.x, 1.0 - aUv.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPrev;
uniform float uDecay;
void main() {
  vec3 c = texture(uPrev, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  // MilkDrop's feedback surfaces are fixed-point and clamp at 1.0 each frame;
  // our RGBA16F buffer must clamp explicitly or additive energy blows out.
  fragColor = vec4(clamp(c * uDecay, 0.0, 1.0), 1.0);
}`;

/** The warp-feedback mesh; optionally driven by a transpiled warp shader. */
export class WarpMesh {
  private gl: WebGL2RenderingContext;
  /** Mesh cell count along X (vertices = gridX + 1). */
  readonly gridX: number;
  /** Mesh cell count along Y (vertices = gridY + 1). */
  readonly gridY: number;

  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private indexCount: number;

  // interleaved [nx, ny, u, v] per vertex
  private data: Float32Array;
  private nx: Float32Array;
  private ny: Float32Array;
  private rad: Float32Array;

  private uPrev: WebGLUniformLocation | null;
  private uDecay: WebGLUniformLocation | null;

  // optional warp shader (transpiled preset warp shader)
  private warpProg: WebGLProgram | null = null;
  private warpLoc = new Map<string, WebGLUniformLocation | null>();

  /**
   * Build the warp mesh and its GL buffers. Grid density defaults to
   * `config.tunables` (original default 48×36, plugin.cpp:952).
   */
  constructor(
    gl: WebGL2RenderingContext,
    gridX = tunables.meshGridX,
    gridY = tunables.meshGridY,
  ) {
    this.gl = gl;
    this.gridX = gridX;
    this.gridY = gridY;

    const vcount = (gridX + 1) * (gridY + 1);
    this.data = new Float32Array(vcount * 4);
    this.nx = new Float32Array(vcount);
    this.ny = new Float32Array(vcount);
    this.rad = new Float32Array(vcount);

    this.prog = linkProgram(gl, VS, FS);
    this.uPrev = gl.getUniformLocation(this.prog, "uPrev");
    this.uDecay = gl.getUniformLocation(this.prog, "uDecay");

    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    const indices = this.buildIndices();
    this.indexCount = indices.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /** Install a transpiled warp shader (or clear it with null). */
  setWarpShader(fragmentSrc: string | null): void {
    const gl = this.gl;
    if (this.warpProg) {
      gl.deleteProgram(this.warpProg);
      this.warpProg = null;
    }
    this.warpLoc.clear();
    if (fragmentSrc)
      this.warpProg = linkProgram(gl, WARP_SHADER_VS, fragmentSrc);
  }

  /** Whether a transpiled warp shader is currently installed. */
  get hasWarpShader(): boolean {
    return this.warpProg !== null;
  }

  private warpU = (name: string): WebGLUniformLocation | null => {
    let l = this.warpLoc.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.warpProg!, name);
      this.warpLoc.set(name, l);
    }
    return l;
  };

  /**
   * Interleaved per-vertex data `[nx, ny, u, v]`, rows of `gridX + 1` vertices
   * with row 0 at clip y = -1. The UVs are the warp sample coordinates from the
   * most recent {@link render} - what the motion vectors reverse-propagate
   * through (the original reads `m_verts` the same one-frame-stale way).
   */
  get vertexData(): Float32Array {
    return this.data;
  }

  /** Recompute static base positions / rad for the current aspect. */
  rebuild(aspect: Aspect): void {
    let n = 0;
    for (let y = 0; y <= this.gridY; y++) {
      for (let x = 0; x <= this.gridX; x++) {
        const nx = (x / this.gridX) * 2 - 1;
        const ny = (y / this.gridY) * 2 - 1;
        this.nx[n] = nx;
        this.ny[n] = ny;
        this.rad[n] = vertexRadAng(nx, ny, aspect).rad;
        this.data[n * 4] = nx;
        this.data[n * 4 + 1] = ny;
        // identity warp UVs (D3D-oriented, like computeWarpUV output) so the
        // motion vectors see a sane field before the first warp pass runs
        this.data[n * 4 + 2] = (nx + 1) / 2;
        this.data[n * 4 + 3] = (1 - ny) / 2;
        n++;
      }
    }
  }

  /**
   * Run per_pixel per vertex, compute warped UVs, and draw into the bound FBO,
   * sampling `sourceTex` (the previous frame) scaled by `decay`.
   */
  render(
    preset: CompiledPreset,
    motion: WarpParams,
    warpFrameInputs: {
      time: number;
      warpAnimSpeed: number;
      warpScale: number;
      texSizeX: number;
      texSizeY: number;
    },
    aspect: Aspect,
    sourceTex: WebGLTexture,
    decay: number,
    shaderState?: ShaderFrameState,
  ): void {
    const gl = this.gl;
    this.computeGeometry(preset, motion, warpFrameInputs, aspect);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data);
    gl.disable(gl.BLEND);

    if (this.warpProg && shaderState) {
      gl.useProgram(this.warpProg);
      bindShaderUniforms(gl, this.warpU, shaderState);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    } else {
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.uniform1i(this.uPrev, 0);
      gl.uniform1f(this.uDecay, decay);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  private computeGeometry(
    preset: CompiledPreset,
    motion: WarpParams,
    warpFrameInputs: {
      time: number;
      warpAnimSpeed: number;
      warpScale: number;
      texSizeX: number;
      texSizeY: number;
    },
    aspect: Aspect,
  ): void {
    const warpTime = warpFrameInputs.time * warpFrameInputs.warpAnimSpeed;
    const frame: WarpFrame = {
      warpTime,
      warpScaleInv: 1 / (warpFrameInputs.warpScale || 1),
      f: warpCoefficients(warpTime),
      texelOffsetX: 0.5 / warpFrameInputs.texSizeX,
      texelOffsetY: 0.5 / warpFrameInputs.texSizeY,
    };

    const hasPerPixel = preset.perPixel !== null;
    const ppVars = preset.ppCtx.vars;
    const vcount = this.nx.length;

    for (let i = 0; i < vcount; i++) {
      const nx = this.nx[i]!;
      const ny = this.ny[i]!;
      const rad = this.rad[i]!;
      let p: WarpParams = motion;

      if (hasPerPixel) {
        // seed per-vertex inputs (D3D math-space x,y in 0..1)
        ppVars.set("x", nx * 0.5 * aspect.aspectX + 0.5);
        ppVars.set("y", ny * -0.5 * aspect.aspectY + 0.5);
        ppVars.set("rad", rad);
        ppVars.set(
          "ang",
          Math.atan2(-ny * aspect.aspectY, nx * aspect.aspectX),
        );
        ppVars.set("zoom", motion.zoom);
        ppVars.set("zoomexp", motion.zoomExp);
        ppVars.set("rot", motion.rot);
        ppVars.set("warp", motion.warp);
        ppVars.set("cx", motion.cx);
        ppVars.set("cy", motion.cy);
        ppVars.set("dx", motion.dx);
        ppVars.set("dy", motion.dy);
        ppVars.set("sx", motion.sx);
        ppVars.set("sy", motion.sy);
        preset.runPerPixel();
        p = {
          zoom: ppVars.get("zoom"),
          zoomExp: ppVars.get("zoomexp"),
          rot: ppVars.get("rot"),
          warp: ppVars.get("warp"),
          cx: ppVars.get("cx"),
          cy: ppVars.get("cy"),
          dx: ppVars.get("dx"),
          dy: ppVars.get("dy"),
          sx: ppVars.get("sx"),
          sy: ppVars.get("sy"),
        };
      }

      const { u, v } = computeWarpUV(nx, ny, rad, p, frame, aspect);
      this.data[i * 4 + 2] = u;
      this.data[i * 4 + 3] = v;
    }
  }

  private buildIndices(): Uint32Array {
    const idx: number[] = [];
    const stride = this.gridX + 1;
    for (let y = 0; y < this.gridY; y++) {
      for (let x = 0; x < this.gridX; x++) {
        const a = y * stride + x;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    return new Uint32Array(idx);
  }
}
