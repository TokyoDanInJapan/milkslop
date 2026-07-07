import { describe, it, expect } from "vitest";
import { parseMilk, CompiledPreset } from "../src/preset/index.ts";

const preset = `
[preset00]
MILKDROP_PRESET_VERSION=201
shapecode_0_enabled=1
shapecode_0_sides=5
shapecode_0_num_inst=2
shapecode_0_rad=0.1
shapecode_0_r=1.0
shape_0_init1=t1 = 0.25;
shape_0_per_frame1=rad = 0.1 + 0.05*bass;
shape_0_per_frame2=sides = 3 + instance;
shape_0_per_frame3=g = t1;
wavecode_0_enabled=1
wavecode_0_samples=64
wavecode_0_r=1.0
wave_0_init1=t1 = 1.0;
wave_0_per_frame1=myc = t1;
wave_0_per_point1=x = sample;
wave_0_per_point2=y = 0.5 + value1;
`;

describe("custom shapes compiled run", () => {
  it("runs per_frame per instance, applying equations and t/q bridge", () => {
    const p = new CompiledPreset(parseMilk(preset));
    p.runInit({ bass: 0, time: 0 });
    const ctx = p.runPerFrame({ bass: 1.0, time: 0 });
    const mq = p.mainQ();
    expect(p.shapes).toHaveLength(1);

    const inst0 = p.shapes[0]!.runPerFrame(0, mq, { bass: 1.0, time: 0 });
    expect(inst0.rad).toBeCloseTo(0.15, 5); // 0.1 + 0.05*1
    expect(inst0.sides).toBe(3); // 3 + instance(0)
    expect(inst0.g).toBeCloseTo(0.25, 5); // from t1 set in init

    const inst1 = p.shapes[0]!.runPerFrame(1, mq, { bass: 1.0, time: 0 });
    expect(inst1.sides).toBe(4); // 3 + instance(1)

    void ctx;
  });
});

describe("custom waves compiled run", () => {
  it("runs per_frame then per_point, mapping sample/value to position", () => {
    const p = new CompiledPreset(parseMilk(preset));
    p.runInit({ bass: 0, time: 0 });
    p.runPerFrame({ bass: 0.5, time: 0 });
    const mq = p.mainQ();

    expect(p.waves).toHaveLength(1);
    const w = p.waves[0]!;
    const base = w.runPerFrame(mq, { bass: 0.5, time: 0 });
    expect(base.samples).toBe(64);
    expect(base.r).toBeCloseTo(1.0, 5);

    // per_point: x = sample (t), y = 0.5 + value1
    const pt = w.runPerPoint(0.3, 0.2, -0.1, base);
    expect(pt.x).toBeCloseTo(0.3, 5);
    expect(pt.y).toBeCloseTo(0.7, 5); // 0.5 + 0.2
  });
});
