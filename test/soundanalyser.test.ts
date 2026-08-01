import { describe, it, expect } from "vitest";
import { SoundAnalyser } from "../src/audio/SoundAnalyser.ts";

const dt = 1 / 60;

function run(a: SoundAnalyser, spectrum: Float32Array, frames: number) {
  let last = a.update(spectrum, dt);
  for (let i = 1; i < frames; i++) last = a.update(spectrum, dt);
  return last;
}

describe("SoundAnalyser", () => {
  it("normalises a steady signal so each band tends towards ~1", () => {
    const spec = new Float32Array(512).fill(0.5);
    const a = new SoundAnalyser();
    const out = run(a, spec, 600); // ~10s
    expect(out.bass).toBeCloseTo(1, 1);
    expect(out.mid).toBeCloseTo(1, 1);
    expect(out.treb).toBeCloseTo(1, 1);
  });

  it("reports stronger bass than treble for a bass-heavy spectrum", () => {
    const spec = new Float32Array(512);
    for (let i = 0; i < spec.length; i++) spec[i] = i < 30 ? 0.9 : 0.02;
    const a = new SoundAnalyser();
    // first frame: averages still 1, so imm/avg ≈ imm reflects band energy
    const out = a.update(spec, dt);
    expect(out.bass).toBeGreaterThan(out.treb);
  });

  it("never produces NaN/Infinity, even for silence", () => {
    const a = new SoundAnalyser();
    const out = run(a, new Float32Array(512), 120);
    for (const v of Object.values(out)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("attenuated bands lag the immediate ones (smoothing)", () => {
    const a = new SoundAnalyser();
    // settle on silence, then a sudden loud frame
    run(a, new Float32Array(512), 60);
    const loud = new Float32Array(512).fill(0.8);
    const out = a.update(loud, dt);
    // the immediate band jumps faster than the attenuated (smoothed) one
    expect(out.bass).toBeGreaterThan(out.bassAtt);
  });
});
