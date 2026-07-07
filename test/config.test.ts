import { describe, it, expect } from "vitest";
import config, { validateConfig, tunables, constants } from "../src/config.ts";

describe("config.yaml validation", () => {
  it("accepts the committed config.yaml", () => {
    expect(validateConfig(config)).toBe(config);
    expect(tunables.meshGridX).toBeGreaterThan(0);
    expect(constants.eel.numQVars).toBeGreaterThan(0);
  });

  it("rejects a non-mapping root", () => {
    expect(() => validateConfig(null)).toThrow(/expected a mapping/);
    expect(() => validateConfig("nope")).toThrow(/Invalid config\.yaml/);
  });

  it("reports every missing or mistyped path with its location", () => {
    const broken = structuredClone(config) as unknown as {
      tunables: { shuffle: unknown; meshGridX: unknown };
      constants: { warp: { coefficients: unknown } };
    };
    broken.tunables.shuffle = "yes";
    broken.tunables.meshGridX = undefined;
    broken.constants.warp.coefficients = [[1, 2, 3]]; // row too short
    let message = "";
    try {
      validateConfig(broken);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("tunables.shuffle: expected boolean");
    expect(message).toContain("tunables.meshGridX: expected number");
    expect(message).toContain(
      "constants.warp.coefficients: expected an array of [base, amp, freq, phase]",
    );
  });
});
