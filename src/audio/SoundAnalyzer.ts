/**
 * Reduces the raw spectrum to bass/mid/treb at two timescales, normalised so
 * each hovers around 1.0 (cf. AnalyzeNewSound in pluginshell.cpp). This is what
 * drives the bass / bass_att / mid / treb / ... variables in preset equations.
 *
 * A faithful multi-timescale port (imm/avg/med_avg/long_avg) is a later refinement;
 * this gives the immediate value and an attenuated (smoothed) value per band.
 */

import { constants } from "../config.ts";

/** Bass/mid/treb at immediate and attenuated (smoothed) timescales. */
export interface Bands {
  bass: number;
  mid: number;
  treb: number;
  bassAtt: number;
  midAtt: number;
  trebAtt: number;
}

/** Reduces a spectrum to normalized bass/mid/treb bands at two timescales. */
export class SoundAnalyzer {
  // long-term averages used to normalise (so imm_rel ≈ 1)
  private avg = [1, 1, 1];
  private att = [1, 1, 1];
  private readonly imm = [0, 0, 0];

  /** Update from a mono/averaged spectrum (magnitudes 0..1). */
  update(spectrum: Float32Array, dt: number): Bands {
    const n = spectrum.length;
    // band edges roughly matching MilkDrop's bass/mid/treb split
    const b1 = Math.max(1, Math.floor(n * constants.audio.bassEdge));
    const b2 = Math.max(b1 + 1, Math.floor(n * constants.audio.midEdge));

    let bass = 0;
    let mid = 0;
    let treb = 0;
    for (let i = 0; i < b1; i++) bass += spectrum[i] ?? 0;
    for (let i = b1; i < b2; i++) mid += spectrum[i] ?? 0;
    for (let i = b2; i < n; i++) treb += spectrum[i] ?? 0;
    this.imm[0] = bass / b1;
    this.imm[1] = mid / (b2 - b1);
    this.imm[2] = treb / (n - b2);

    // adapt the long-term average toward the immediate value (slow)
    const avgK = 1 - Math.exp(-dt / constants.audio.avgTimeConstant);
    const attK = 1 - Math.exp(-dt / constants.audio.attTimeConstant);
    const out: number[] = [0, 0, 0];
    const attOut: number[] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      this.avg[i] = this.avg[i]! + (this.imm[i]! - this.avg[i]!) * avgK;
      const norm = this.avg[i]! > 1e-4 ? this.imm[i]! / this.avg[i]! : 0;
      out[i] = norm;
      this.att[i] = this.att[i]! + (norm - this.att[i]!) * attK;
      attOut[i] = this.att[i]!;
    }

    return {
      bass: out[0]!,
      mid: out[1]!,
      treb: out[2]!,
      bassAtt: attOut[0]!,
      midAtt: attOut[1]!,
      trebAtt: attOut[2]!,
    };
  }
}
