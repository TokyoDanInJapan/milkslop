/**
 * Minimal WebGL2 helpers. The full render pipeline (Phases 3–6) builds on these.
 */

/**
 * Create the WebGL2 context used by the visualizer.
 *
 * @param canvas - The target canvas element.
 * @returns The configured WebGL2 context.
 * @throws Error if WebGL2 is unavailable.
 */
export function createGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 is not available in this browser.");
  // RGBA16F render targets (feedback buffers) need this in WebGL2.
  gl.getExtension("EXT_color_buffer_float");
  return gl;
}

/**
 * Compile a single shader stage.
 *
 * @param gl - The WebGL2 context.
 * @param type - `gl.VERTEX_SHADER` or `gl.FRAGMENT_SHADER`.
 * @param source - GLSL source.
 * @returns The compiled shader.
 * @throws Error with the info log on a compile failure.
 */
export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error:\n${log}\n---\n${source}`);
  }
  return sh;
}

/**
 * Compile and link a vertex + fragment program.
 *
 * @param gl - The WebGL2 context.
 * @param vsSource - Vertex-shader GLSL.
 * @param fsSource - Fragment-shader GLSL.
 * @returns The linked program.
 * @throws Error with the info log on a compile/link failure.
 */
export function linkProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error:\n${log}`);
  }
  return prog;
}

/** A unit quad covering the clip-space viewport, as a triangle strip. */
export function createFullscreenQuad(
  gl: WebGL2RenderingContext,
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("createVertexArray failed");
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // x, y
  const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
