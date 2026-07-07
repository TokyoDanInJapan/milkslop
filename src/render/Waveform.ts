/**
 * The basic waveform overlay - a faithful port of CPlugin::DrawWave
 * (milkdropfs.cpp:2765) with all 8 wave modes:
 *
 *   0 circular wave · 1 x-y spiral osc · 2 centered spiro · 3 centered spiro
 *   (volume alpha) · 4 horizontal script · 5 explosive complex-plane hash ·
 *   6 angle-adjustable line · 7 dual angle-adjustable lines
 *
 * (The original's case 8 - spectrum line - is unreachable: `wave_mode % 8`
 * can never produce 8.) Vertex building and the SmoothWave tessellation are
 * pure and unit-tested; the {@link Waveform} class draws the result as line
 * strips or points with the original's 4-pass thick-line fattening.
 */

import { linkProgram } from "./gl.ts";
import type { Aspect } from "./warp.ts";
import { constants } from "../config.ts";

/** Samples actually used per frame (defines.h:188; the buffer holds 576). */
export const NUM_WAVEFORM_SAMPLES = constants.waveform.numSamples;

/** Per-frame inputs for {@link buildWave} (post-equation `wave_*` values). */
export interface WaveBuildParams {
  mode: number; // wave_mode (the original applies % 8)
  alpha: number; // wave_a
  mystery: number; // wave_mystery
  x: number; // wave_x (0..1)
  y: number; // wave_y (0..1; MilkDrop's historically-flipped axis)
  scale: number; // wave_scale (applied to the samples)
  modByVolume: boolean;
  modAlphaStart: number;
  modAlphaEnd: number;
  vol: number; // (bass+mid+treb)/3, relative (≈1)
  treb: number; // treble, relative
  time: number;
  blending: boolean; // skips mode 0's loop-closing vertex, like the original
}

/** A built waveform: clip-space `[x, y]` pairs plus draw metadata. */
export interface BuiltWave {
  verts: Float32Array; // 2 floats per vertex
  nVerts: number;
  nBreak: number; // split index for mode 7's two lines (-1 = none)
  alpha: number; // final per-frame alpha
}

/** The original's texsize-bucketed alpha multipliers for modes 2/3/5. */
function texsizeAlphaMult(texSizeX: number): number {
  if (texSizeX <= 384) return 0.07;
  if (texSizeX <= 768) return 0.09;
  if (texSizeX <= 1536) return 0.11;
  return 0.13;
}

function texsizeAlphaBase(texSizeX: number): number {
  if (texSizeX <= 384) return 0.075;
  if (texSizeX <= 768) return 0.15;
  if (texSizeX <= 1536) return 0.22;
  return 0.33;
}

/**
 * Build one frame of waveform vertices - DrawWave's mode switch, 1:1.
 *
 * @param p - Per-frame wave parameters.
 * @param fL - Left-channel samples (-1..1), ≥ 576 entries.
 * @param fR - Right-channel samples.
 * @param a - Aspect correction.
 * @param texSizeX - Feedback width (alpha buckets, vertex caps).
 * @returns Vertices in clip space (y already flipped like the original).
 */
export function buildWave(
  p: WaveBuildParams,
  fL: Float32Array,
  fR: Float32Array,
  a: Aspect,
  texSizeX: number,
): BuiltWave {
  const wave = ((Math.floor(p.mode) % 8) + 8) % 8;
  const out = new Float32Array((576 + 1) * 2 * 2);
  let nVerts = NUM_WAVEFORM_SAMPLES;
  let nBreak = -1;
  let alpha = p.alpha;

  const L = (i: number): number => (fL[i] ?? 0) * p.scale;
  const R = (i: number): number => (fR[i] ?? 0) * p.scale;

  // fold wave_mystery into [-1, 1] for the modes that need it
  let mystery = p.mystery;
  if (
    (wave === 0 || wave === 1 || wave === 4) &&
    (mystery < -1 || mystery > 1)
  ) {
    mystery = mystery * 0.5 + 0.5;
    mystery -= Math.floor(mystery);
    mystery = Math.abs(mystery);
    mystery = mystery * 2 - 1;
  }

  const posX = p.x * 2 - 1;
  const posY = p.y * 2 - 1;

  const modAlpha = () => {
    if (p.modByVolume) {
      const range = p.modAlphaEnd - p.modAlphaStart;
      alpha *= (p.vol - p.modAlphaStart) / (range || 1e-6);
    }
    if (alpha < 0) alpha = 0;
    if (alpha > 1) alpha = 1;
  };

  const set = (i: number, x: number, y: number) => {
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  };

  switch (wave) {
    case 0: {
      // circular wave
      nVerts = Math.floor(nVerts / 2);
      const off = Math.floor((NUM_WAVEFORM_SAMPLES - nVerts) / 2);
      modAlpha();
      const inv = 1 / (nVerts - 1);
      for (let i = 0; i < nVerts; i++) {
        let rad = 0.5 + 0.4 * R(i + off) + mystery;
        const ang = i * inv * 6.28 + p.time * 0.2;
        if (i < nVerts / 10) {
          let mix = i / (nVerts * 0.1);
          mix = 0.5 - 0.5 * Math.cos(mix * 3.1416);
          const rad2 = 0.5 + 0.4 * R(i + nVerts + off) + mystery;
          rad = rad2 * (1 - mix) + rad * mix;
        }
        set(
          i,
          rad * Math.cos(ang) * a.aspectY + posX,
          rad * Math.sin(ang) * a.aspectX + posY,
        );
      }
      if (!p.blending) {
        // dupe the first vertex to close the loop
        set(nVerts, out[0]!, out[1]!);
        nVerts++;
      }
      break;
    }
    case 1: {
      // x-y osc that spirals around in time
      alpha *= 1.25;
      modAlpha();
      nVerts = Math.floor(nVerts / 2);
      for (let i = 0; i < nVerts; i++) {
        const rad = 0.53 + 0.43 * R(i) + mystery;
        const ang = L(i + 32) * 1.57 + p.time * 2.3;
        set(
          i,
          rad * Math.cos(ang) * a.aspectY + posX,
          rad * Math.sin(ang) * a.aspectX + posY,
        );
      }
      break;
    }
    case 2: {
      // centered spiro (constant alpha) - nebula-like
      alpha *= texsizeAlphaMult(texSizeX);
      modAlpha();
      for (let i = 0; i < nVerts; i++)
        set(i, R(i) * a.aspectY + posX, L(i + 32) * a.aspectX + posY);
      break;
    }
    case 3: {
      // centered spiro, alpha tied to volume
      alpha = texsizeAlphaBase(texSizeX);
      alpha *= 1.3;
      alpha *= Math.pow(p.treb, 2);
      modAlpha();
      for (let i = 0; i < nVerts; i++)
        set(i, R(i) * a.aspectY + posX, L(i + 32) * a.aspectX + posY);
      break;
    }
    case 4: {
      // horizontal "script", left channel
      if (nVerts > texSizeX / 3) nVerts = Math.floor(texSizeX / 3);
      const off = Math.floor((NUM_WAVEFORM_SAMPLES - nVerts) / 2);
      modAlpha();
      const w1 = 0.45 + 0.5 * (mystery * 0.5 + 0.5);
      const w2 = 1 - w1;
      const inv = 1 / nVerts;
      for (let i = 0; i < nVerts; i++) {
        let x = -1 + 2 * (i * inv) + posX + R(i + 25 + off) * 0.44;
        let y = L(i + off) * 0.47 + posY;
        if (i > 1) {
          x = x * w2 + w1 * (out[(i - 1) * 2]! * 2 - out[(i - 2) * 2]!);
          y = y * w2 + w1 * (out[(i - 1) * 2 + 1]! * 2 - out[(i - 2) * 2 + 1]!);
        }
        set(i, x, y);
      }
      break;
    }
    case 5: {
      // weird explosive complex-number thingy
      alpha *= texsizeAlphaMult(texSizeX);
      modAlpha();
      const cosR = Math.cos(p.time * 0.3);
      const sinR = Math.sin(p.time * 0.3);
      for (let i = 0; i < nVerts; i++) {
        const x0 = R(i) * L(i + 32) + L(i) * R(i + 32);
        const y0 = R(i) * R(i) - L(i + 32) * L(i + 32);
        set(
          i,
          (x0 * cosR - y0 * sinR) * a.aspectY + posX,
          (x0 * sinR + y0 * cosR) * a.aspectX + posY,
        );
      }
      break;
    }
    default: {
      // 6: angle-adjustable line; 7: dual lines separated by wave_y
      nVerts = Math.floor(nVerts / 2);
      if (nVerts > texSizeX / 3) nVerts = Math.floor(texSizeX / 3);
      const off = Math.floor((NUM_WAVEFORM_SAMPLES - nVerts) / 2);
      modAlpha();

      const ang = 1.57 * mystery;
      let dx = Math.cos(ang);
      let dy = Math.sin(ang);
      const ex = [
        posX * Math.cos(ang + 1.57) - dx * 3,
        posX * Math.cos(ang + 1.57) + dx * 3,
      ];
      const ey = [
        posX * Math.sin(ang + 1.57) - dy * 3,
        posX * Math.sin(ang + 1.57) + dy * 3,
      ];
      // clip both endpoints against the (slightly enlarged) screen rect
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 4; j++) {
          let t = 0;
          let clip = false;
          if (j === 0 && ex[i]! > 1.1) {
            t = (1.1 - ex[1 - i]!) / (ex[i]! - ex[1 - i]!);
            clip = true;
          } else if (j === 1 && ex[i]! < -1.1) {
            t = (-1.1 - ex[1 - i]!) / (ex[i]! - ex[1 - i]!);
            clip = true;
          } else if (j === 2 && ey[i]! > 1.1) {
            t = (1.1 - ey[1 - i]!) / (ey[i]! - ey[1 - i]!);
            clip = true;
          } else if (j === 3 && ey[i]! < -1.1) {
            t = (-1.1 - ey[1 - i]!) / (ey[i]! - ey[1 - i]!);
            clip = true;
          }
          if (clip) {
            const ddx = ex[i]! - ex[1 - i]!;
            const ddy = ey[i]! - ey[1 - i]!;
            ex[i] = ex[1 - i]! + ddx * t;
            ey[i] = ey[1 - i]! + ddy * t;
          }
        }
      }
      dx = (ex[1]! - ex[0]!) / nVerts;
      dy = (ey[1]! - ey[0]!) / nVerts;
      const ang2 = Math.atan2(dy, dx);
      const px = Math.cos(ang2 + 1.57);
      const py = Math.sin(ang2 + 1.57);

      if (wave === 6) {
        for (let i = 0; i < nVerts; i++)
          set(
            i,
            ex[0]! + dx * i + px * 0.25 * L(i + off),
            ey[0]! + dy * i + py * 0.25 * L(i + off),
          );
      } else {
        const sep = Math.pow(posY * 0.5 + 0.5, 2);
        for (let i = 0; i < nVerts; i++)
          set(
            i,
            ex[0]! + dx * i + px * (0.25 * L(i + off) + sep),
            ey[0]! + dy * i + py * (0.25 * L(i + off) + sep),
          );
        for (let i = 0; i < nVerts; i++)
          set(
            i + nVerts,
            ex[0]! + dx * i + px * (0.25 * R(i + off) - sep),
            ey[0]! + dy * i + py * (0.25 * R(i + off) - sep),
          );
        nBreak = nVerts;
        nVerts *= 2;
      }
      break;
    }
  }

  // flip y, "to stay consistent with the pre-VMS milkdrop" (milkdropfs.cpp:3312)
  for (let i = 0; i < nVerts; i++) out[i * 2 + 1] = -out[i * 2 + 1]!;

  return { verts: out, nVerts, nBreak, alpha };
}

/**
 * SmoothWave (milkdropfs.cpp:2549): insert one midpoint between each vertex
 * pair using a 4-tap `[-0.15, 1.15, 1.15, -0.15]` kernel. Returns the new
 * vertex count (≈ 2n-1) written into `vo`.
 */
export function smoothWave(
  vi: Float32Array,
  nVertsIn: number,
  vo: Float32Array,
  voOffset = 0,
): number {
  const c1 = -0.15;
  const c2 = 1.15;
  const c3 = 1.15;
  const c4 = -0.15;
  const invSum = 1 / (c1 + c2 + c3 + c4);
  let j = voOffset;
  let below = 0;
  let above2 = 1;
  for (let i = 0; i < nVertsIn - 1; i++) {
    const above = above2;
    above2 = Math.min(nVertsIn - 1, i + 2);
    vo[j * 2] = vi[i * 2]!;
    vo[j * 2 + 1] = vi[i * 2 + 1]!;
    vo[(j + 1) * 2] =
      (c1 * vi[below * 2]! +
        c2 * vi[i * 2]! +
        c3 * vi[above * 2]! +
        c4 * vi[above2 * 2]!) *
      invSum;
    vo[(j + 1) * 2 + 1] =
      (c1 * vi[below * 2 + 1]! +
        c2 * vi[i * 2 + 1]! +
        c3 * vi[above * 2 + 1]! +
        c4 * vi[above2 * 2 + 1]!) *
      invSum;
    below = i;
    j += 2;
  }
  vo[j * 2] = vi[(nVertsIn - 1) * 2]!;
  vo[j * 2 + 1] = vi[(nVertsIn - 1) * 2 + 1]!;
  return j + 1 - voOffset;
}

/** Appearance parameters for {@link Waveform.render}. */
export interface WaveDrawParams extends WaveBuildParams {
  r: number;
  g: number;
  b: number;
  brighten: boolean; // wave_brighten (maximize color)
  additive: boolean;
  dots: boolean;
  thick: boolean;
}

const VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_PointSize = 1.0; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec4 uColor;
void main() { fragColor = uColor; }`;

/** Draws the basic waveform overlay into the feedback buffer. */
export class Waveform {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private uColor: WebGLUniformLocation | null;
  private tess = new Float32Array((576 + 3) * 2 * 2);

  /** Compile the waveform shader and set up its GL resources. */
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = linkProgram(gl, VS, FS);
    this.uColor = gl.getUniformLocation(this.prog, "uColor");
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.tess.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Build + draw this frame's waveform. */
  render(
    fL: Float32Array,
    fR: Float32Array,
    p: WaveDrawParams,
    aspect: Aspect,
    texW: number,
    texH: number,
  ): void {
    const gl = this.gl;
    const built = buildWave(p, fL, fR, aspect, texW);
    if (built.alpha < 0.004 || built.nVerts < 2) return;

    // maximize color (wave_brighten)
    let { r, g, b } = p;
    r = Math.min(1, Math.max(0, r));
    g = Math.min(1, Math.max(0, g));
    b = Math.min(1, Math.max(0, b));
    if (p.brighten) {
      const mx = Math.max(r, g, b);
      if (mx > 0.01) {
        r /= mx;
        g /= mx;
        b /= mx;
      }
    }

    // tessellate (SmoothWave), keeping mode 7's two segments separate
    let nVerts: number;
    let nBreak: number;
    if (built.nBreak === -1) {
      nVerts = smoothWave(built.verts, built.nVerts, this.tess);
      nBreak = -1;
    } else {
      nBreak = smoothWave(built.verts, built.nBreak, this.tess);
      nVerts =
        smoothWave(
          built.verts.subarray(built.nBreak * 2),
          built.nVerts - built.nBreak,
          this.tess,
          nBreak,
        ) + nBreak;
    }

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.uniform4f(this.uColor, r, g, b, built.alpha);
    gl.enable(gl.BLEND);
    if (p.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const mode = p.dots ? gl.POINTS : gl.LINE_STRIP;
    const passes = (p.thick || p.dots) && texW >= 512 ? 4 : 1;
    const xInc = 2 / texW;
    const yInc = 2 / texH;
    for (let it = 0; it < passes; it++) {
      if (it === 1)
        for (let j = 0; j < nVerts; j++)
          this.tess[j * 2] = this.tess[j * 2]! + xInc;
      else if (it === 2)
        for (let j = 0; j < nVerts; j++)
          this.tess[j * 2 + 1] = this.tess[j * 2 + 1]! + yInc;
      else if (it === 3)
        for (let j = 0; j < nVerts; j++)
          this.tess[j * 2] = this.tess[j * 2]! - xInc;
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.tess.subarray(0, nVerts * 2));
      if (nBreak === -1) {
        gl.drawArrays(mode, 0, nVerts);
      } else {
        gl.drawArrays(mode, 0, nBreak);
        gl.drawArrays(mode, nBreak, nVerts - nBreak);
      }
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
