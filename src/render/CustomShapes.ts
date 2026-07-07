/**
 * Draws custom shapes: n-sided polygons with a centre→edge colour gradient,
 * optional feedback-texture fill, and an optional outline border. Ported from
 * DrawCustomShapes (milkdropfs.cpp:2298). Textured shapes sample the previous
 * frame (the original's `m_lpVS[0]`) with UVs spun by `tex_ang` and scaled by
 * `tex_zoom`; the UVs are D3D-oriented so the fragment shader applies the
 * usual feedback v-flip.
 */

import { ColorBatch, FLOATS_PER_VERT } from "./ColorBatch.ts";
import { linkProgram } from "./gl.ts";
import type { Aspect } from "./warp.ts";
import type { CompiledPreset } from "../preset/CompiledPreset.ts";
import { constants } from "../config.ts";

const TWO_PI = Math.PI * 2;
const QUARTER = Math.PI * 0.25;

const TEX_VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in vec4 aColor;
out vec2 vUv;
out vec4 vColor;
void main() {
  vUv = aUv;
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const TEX_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
out vec4 fragColor;
uniform sampler2D uTex;
void main() {
  // D3D-oriented UVs → flip v for the GL feedback texture
  vec3 t = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  fragColor = vec4(t * vColor.rgb, vColor.a);
}`;

const TEX_FLOATS = constants.layout.texFloatsPerVert; // [x, y, u, v, r, g, b, a]

/** Renders a preset's custom shapes into the feedback buffer. */
export class CustomShapes {
  private gl: WebGL2RenderingContext;
  private batch: ColorBatch;
  private texProg: WebGLProgram;
  private texVao: WebGLVertexArrayObject;
  private texVbo: WebGLBuffer;
  private texData: Float32Array;
  private uTex: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.batch = new ColorBatch(gl, 4096);
    this.texProg = linkProgram(gl, TEX_VS, TEX_FS);
    this.uTex = gl.getUniformLocation(this.texProg, "uTex");
    this.texData = new Float32Array(128 * TEX_FLOATS); // sides ≤ 100 + centre + close
    this.texVao = gl.createVertexArray()!;
    this.texVbo = gl.createBuffer()!;
    gl.bindVertexArray(this.texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.texData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.bindVertexArray(null);
  }

  /** Draw one textured fan: verts already in this.texData. */
  private drawTextured(
    vertCount: number,
    source: WebGLTexture,
    additive: boolean,
  ): void {
    const gl = this.gl;
    gl.useProgram(this.texProg);
    gl.bindVertexArray(this.texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texVbo);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.texData.subarray(0, vertCount * TEX_FLOATS),
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(this.uTex, 0);
    gl.enable(gl.BLEND);
    if (additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, vertCount);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /**
   * Run and draw every custom shape in `preset` into the currently-bound buffer.
   *
   * @param preset - Compiled preset supplying the per-frame shape code.
   * @param mainQ - The main per-frame q-variable values (q1..q32).
   * @param inputs - Named runtime inputs (time, bass, etc.) for the EEL code.
   * @param aspect - Aspect-ratio correction factors for the output.
   * @param texSizeX - Render target width in pixels.
   * @param texSizeY - Render target height in pixels.
   * @param sourceTex - Previous-frame texture sampled by textured shapes; when
   *   omitted, textured fills are skipped.
   */
  render(
    preset: CompiledPreset,
    mainQ: Float64Array,
    inputs: Record<string, number>,
    aspect: Aspect,
    texSizeX: number,
    texSizeY: number,
    sourceTex?: WebGLTexture,
  ): void {
    const buf = this.batch.buffer;

    for (const shape of preset.shapes) {
      const s = shape.spec;
      for (let inst = 0; inst < s.instances; inst++) {
        const p = shape.runPerFrame(inst, mainQ, inputs);
        if (p.a <= 0 && p.a2 <= 0 && p.borderA <= 0) continue;

        const sides = p.sides;
        const cx = p.x * 2 - 1;
        const cy = p.y * -2 + 1;
        const textured = p.textured && sourceTex !== undefined;

        // triangle fan: centre + sides perimeter verts + closing vert.
        // Perimeter UVs (textured fill) spin with tex_ang and zoom with
        // tex_zoom, exactly as in the original (milkdropfs.cpp:2403-2406).
        let v = 0;
        const put = (
          x: number,
          y: number,
          tu: number,
          tv: number,
          r: number,
          g: number,
          b: number,
          a: number,
        ) => {
          if (textured) {
            const o = v * TEX_FLOATS;
            this.texData[o] = x;
            this.texData[o + 1] = y;
            this.texData[o + 2] = tu;
            this.texData[o + 3] = tv;
            this.texData[o + 4] = r;
            this.texData[o + 5] = g;
            this.texData[o + 6] = b;
            this.texData[o + 7] = a;
          } else {
            const o = v * FLOATS_PER_VERT;
            buf[o] = x;
            buf[o + 1] = y;
            buf[o + 2] = r;
            buf[o + 3] = g;
            buf[o + 4] = b;
            buf[o + 5] = a;
          }
          v++;
        };
        const perim = (j: number) => {
          const t = (j % sides) / sides;
          const ang = t * TWO_PI + p.ang + QUARTER;
          const tex = t * TWO_PI + p.texAng + QUARTER;
          const zoom = p.texZoom || 1;
          put(
            cx + p.rad * Math.cos(ang) * aspect.aspectY,
            cy + p.rad * Math.sin(ang),
            0.5 + ((0.5 * Math.cos(tex)) / zoom) * aspect.aspectY,
            0.5 + (0.5 * Math.sin(tex)) / zoom,
            p.r2,
            p.g2,
            p.b2,
            p.a2,
          );
        };
        put(cx, cy, 0.5, 0.5, p.r, p.g, p.b, p.a);
        for (let j = 0; j <= sides; j++) perim(j); // wraps to close the fan
        if (textured) this.drawTextured(v, sourceTex, p.additive);
        else
          this.batch.draw(WebGL2RenderingContext.TRIANGLE_FAN, v, p.additive);

        // border outline
        if (p.borderA > 0) {
          const its = p.thick ? 4 : 1;
          const xInc = 2 / texSizeX;
          const yInc = 2 / texSizeY;
          for (let it = 0; it < its; it++) {
            const ox = it === 1 ? xInc : it === 3 ? -xInc : 0;
            const oy = it === 2 ? yInc : 0;
            let bv = 0;
            for (let j = 0; j <= sides; j++) {
              const t = (j % sides) / sides;
              const ang = t * TWO_PI + p.ang + QUARTER;
              const x = cx + p.rad * Math.cos(ang) * aspect.aspectY + ox;
              const y = cy + p.rad * Math.sin(ang) + oy;
              const o = bv * FLOATS_PER_VERT;
              buf[o] = x;
              buf[o + 1] = y;
              buf[o + 2] = p.borderR;
              buf[o + 3] = p.borderG;
              buf[o + 4] = p.borderB;
              buf[o + 5] = p.borderA;
              bv++;
            }
            this.batch.draw(WebGL2RenderingContext.LINE_STRIP, bv, p.additive);
          }
        }
      }
    }
  }
}
