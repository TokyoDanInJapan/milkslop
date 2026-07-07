/**
 * A small reusable drawer for coloured primitives (triangle fans, line strips,
 * points) in clip space. Used by custom shapes and custom waves. Vertices are
 * interleaved [x, y, r, g, b, a].
 */

import { linkProgram } from "./gl.ts";
import { constants } from "../config.ts";

const VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColor;
out vec4 vColor;
uniform float uPointSize;
void main() {
  vColor = aColor;
  gl_PointSize = uPointSize;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 fragColor;
void main() { fragColor = vColor; }`;

/** Floats per vertex in a {@link ColorBatch} buffer: `[x, y, r, g, b, a]`. */
export const FLOATS_PER_VERT = constants.layout.floatsPerVert;

/** Reusable drawer for coloured primitives (fans, line strips, points). */
export class ColorBatch {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private uPointSize: WebGLUniformLocation | null;
  private data: Float32Array;

  /** Compile the batch shader and allocate a vertex buffer for `maxVerts`. */
  constructor(gl: WebGL2RenderingContext, maxVerts = 4096) {
    this.gl = gl;
    this.prog = linkProgram(gl, VS, FS);
    this.uPointSize = gl.getUniformLocation(this.prog, "uPointSize");
    this.data = new Float32Array(maxVerts * FLOATS_PER_VERT);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
  }

  /** Mutable view of the vertex buffer for the caller to fill. */
  get buffer(): Float32Array {
    return this.data;
  }

  /** Upload `vertCount` verts and draw them as `mode`, with blending. */
  draw(
    mode: number,
    vertCount: number,
    additive: boolean,
    pointSize = 1,
  ): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.data.subarray(0, vertCount * FLOATS_PER_VERT),
    );
    gl.uniform1f(this.uPointSize, pointSize);
    gl.enable(gl.BLEND);
    if (additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(mode, 0, vertCount);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
