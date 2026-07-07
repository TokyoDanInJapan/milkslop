/**
 * Draws custom waves: per-point waveforms driven by per_frame + per_point code.
 * Ported from DrawCustomWaves (milkdropfs.cpp:2579), including the forward/
 * backward smoothing pass and the SmoothWave point-doubling.
 */

import { ColorBatch, FLOATS_PER_VERT } from "./ColorBatch.ts";
import type { Aspect } from "./warp.ts";
import type {
  CompiledPreset,
  WaveBaseProps,
} from "../preset/CompiledPreset.ts";
import { constants } from "../config.ts";

const NUM_WAVEFORM_SAMPLES = constants.waveform.numSamples;

/** Per-channel waveform + spectrum data consumed by custom waves. */
export interface ChannelAudio {
  waveL: Float32Array;
  waveR: Float32Array;
  specL: Float32Array;
  specR: Float32Array;
}

/** Renders a preset's custom (per-point) waves into the feedback buffer. */
export class CustomWaves {
  private batch: ColorBatch;
  private tmp0 = new Float32Array(512);
  private tmp1 = new Float32Array(512);
  // raw per-point verts before optional SmoothWave: [x,y,r,g,b,a]
  private raw = new Float32Array(512 * FLOATS_PER_VERT);

  constructor(gl: WebGL2RenderingContext) {
    this.batch = new ColorBatch(gl, 4096);
  }

  /**
   * Run and draw every custom wave in `preset` into the currently-bound buffer.
   *
   * @param preset - Compiled preset supplying the per-frame/per-point code.
   * @param mainQ - The main per-frame q-variable values (q1..q32).
   * @param inputs - Named runtime inputs (time, bass, etc.) for the EEL code.
   * @param audio - Per-channel waveform and spectrum sample data.
   * @param waveScale - Global waveform amplitude scale (the preset's `wave_scale`).
   * @param aspect - Aspect-ratio correction factors for the output.
   * @param texSizeX - Render target width in pixels (drives line thickness/offsets).
   * @param texSizeY - Render target height in pixels.
   */
  render(
    preset: CompiledPreset,
    mainQ: Float64Array,
    inputs: Record<string, number>,
    audio: ChannelAudio,
    waveScale: number,
    aspect: Aspect,
    texSizeX: number,
    texSizeY: number,
  ): void {
    for (const wave of preset.waves) {
      const base = wave.runPerFrame(mainQ, inputs);
      let nSamples = base.samples;
      const maxSamples = base.spectrum ? 512 : NUM_WAVEFORM_SAMPLES;
      if (nSamples > maxSamples) nSamples = maxSamples;
      if (nSamples < (base.useDots ? 1 : 2)) continue;

      this.sampleAndSmooth(base, audio, nSamples, maxSamples, waveScale);

      // per-point code → raw verts
      const jMult = 1 / (nSamples - 1);
      let rv = 0;
      for (let j = 0; j < nSamples; j++) {
        const t = j * jMult;
        const pt = wave.runPerPoint(t, this.tmp0[j]!, this.tmp1[j]!, base);
        const o = rv * FLOATS_PER_VERT;
        this.raw[o] = (pt.x * 2 - 1) * aspect.invAspectX;
        this.raw[o + 1] = (pt.y * -2 + 1) * aspect.invAspectY;
        this.raw[o + 2] = pt.r;
        this.raw[o + 3] = pt.g;
        this.raw[o + 4] = pt.b;
        this.raw[o + 5] = pt.a;
        rv++;
      }

      // SmoothWave (point doubling) unless dots
      const out = this.batch.buffer;
      let count: number;
      if (base.useDots) {
        out.set(this.raw.subarray(0, rv * FLOATS_PER_VERT));
        count = rv;
      } else {
        count = smoothWave(this.raw, rv, out);
      }

      // draw, with optional thick (4 offset passes)
      const its = base.thick && !base.useDots ? 4 : 1;
      const xInc = 2 / texSizeX;
      const yInc = 2 / texSizeY;
      const mode = base.useDots
        ? WebGL2RenderingContext.POINTS
        : WebGL2RenderingContext.LINE_STRIP;
      const ptSize = (texSizeX >= 1024 ? 2 : 1) + (base.thick ? 1 : 0);
      for (let it = 0; it < its; it++) {
        if (it > 0) {
          const ox = it === 1 ? xInc : it === 3 ? -xInc : 0;
          const oy = it === 2 ? yInc : 0;
          for (let k = 0; k < count; k++) {
            out[k * FLOATS_PER_VERT] = out[k * FLOATS_PER_VERT]! + ox;
            out[k * FLOATS_PER_VERT + 1] = out[k * FLOATS_PER_VERT + 1]! + oy;
          }
        }
        this.batch.draw(mode, count, base.additive, ptSize);
      }
    }
  }

  private sampleAndSmooth(
    base: WaveBaseProps,
    audio: ChannelAudio,
    nSamples: number,
    maxSamples: number,
    waveScale: number,
  ): void {
    const mult = (base.spectrum ? 0.15 : 0.004) * base.scaling * waveScale;
    const d1 = base.spectrum ? audio.specL : audio.waveL;
    const d2 = base.spectrum ? audio.specR : audio.waveR;

    const j0 = base.spectrum
      ? 0
      : ((maxSamples - nSamples) / 2 - base.sep / 2) | 0;
    const j1 = base.spectrum
      ? 0
      : ((maxSamples - nSamples) / 2 + base.sep / 2) | 0;
    const t = base.spectrum ? (maxSamples - base.sep) / nSamples : 1;
    const mix1 = Math.pow(base.smoothing * 0.98, 0.5);
    const mix2 = 1 - mix1;

    this.tmp0[0] = d1[j0] ?? 0;
    this.tmp1[0] = d2[j1] ?? 0;
    for (let j = 1; j < nSamples; j++) {
      this.tmp0[j] =
        (d1[((j * t) | 0) + j0] ?? 0) * mix2 + this.tmp0[j - 1]! * mix1;
      this.tmp1[j] =
        (d2[((j * t) | 0) + j1] ?? 0) * mix2 + this.tmp1[j - 1]! * mix1;
    }
    for (let j = nSamples - 2; j >= 0; j--) {
      this.tmp0[j] = this.tmp0[j]! * mix2 + this.tmp0[j + 1]! * mix1;
      this.tmp1[j] = this.tmp1[j]! * mix2 + this.tmp1[j + 1]! * mix1;
    }
    for (let j = 0; j < nSamples; j++) {
      this.tmp0[j] = this.tmp0[j]! * mult;
      this.tmp1[j] = this.tmp1[j]! * mult;
    }
  }
}

/**
 * Better-than-linear smooth that roughly doubles the point count (`SmoothWave`,
 * milkdropfs.cpp:2549). In/out are interleaved `[x, y, r, g, b, a]`.
 */
function smoothWave(vin: Float32Array, n: number, vout: Float32Array): number {
  const c1 = -0.15,
    c2 = 1.15,
    c3 = 1.15,
    c4 = -0.15;
  const invSum = 1 / (c1 + c2 + c3 + c4);
  const F = FLOATS_PER_VERT;
  let j = 0;
  let iBelow = 0;
  let iAbove2 = 1;
  for (let i = 0; i < n - 1; i++) {
    const iAbove = iAbove2;
    iAbove2 = Math.min(n - 1, i + 2);
    // copy vin[i] → vout[j]
    for (let k = 0; k < F; k++) vout[j * F + k] = vin[i * F + k]!;
    // interpolated midpoint at vout[j+1]
    const xo = (j + 1) * F;
    vout[xo] =
      (c1 * vin[iBelow * F]! +
        c2 * vin[i * F]! +
        c3 * vin[iAbove * F]! +
        c4 * vin[iAbove2 * F]!) *
      invSum;
    vout[xo + 1] =
      (c1 * vin[iBelow * F + 1]! +
        c2 * vin[i * F + 1]! +
        c3 * vin[iAbove * F + 1]! +
        c4 * vin[iAbove2 * F + 1]!) *
      invSum;
    for (let k = 2; k < F; k++) vout[xo + k] = vin[i * F + k]!; // carry colour
    iBelow = i;
    j += 2;
  }
  for (let k = 0; k < F; k++) vout[j * F + k] = vin[(n - 1) * F + k]!;
  return j + 1;
}
