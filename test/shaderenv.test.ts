import { describe, it, expect } from "vitest";
import {
  userSamplerKey,
  userSamplersOf,
  BUILTIN_SAMPLERS,
} from "../src/shader/environment.ts";

describe("userSamplerKey", () => {
  it("strips the sampler_ prefix and lowercases", () => {
    expect(userSamplerKey("sampler_Pifano")).toBe("pifano");
  });

  it("strips a leading filter/wrap qualifier", () => {
    expect(userSamplerKey("sampler_fc_myImage")).toBe("myimage");
    expect(userSamplerKey("sampler_pw_tex")).toBe("tex");
  });
});

describe("userSamplersOf", () => {
  it("excludes engine built-ins, keeps user textures", () => {
    const samplers = new Set([
      "sampler_main",
      "sampler_blur1",
      "sampler_noise_hq",
      "sampler_pifano",
      "sampler_fc_logo",
    ]);
    const user = userSamplersOf(samplers).sort();
    expect(user).toEqual(["sampler_fc_logo", "sampler_pifano"]);
  });

  it("returns empty when only built-ins are used", () => {
    expect(userSamplersOf(["sampler_main", "sampler_noisevol_lq"])).toEqual([]);
  });

  it("BUILTIN_SAMPLERS covers main, blur, and all noise samplers", () => {
    for (const n of [
      "sampler_main",
      "sampler_blur3",
      "sampler_noise_lq",
      "sampler_noise_mq",
      "sampler_noise_hq",
      "sampler_noisevol_hq",
    ])
      expect(BUILTIN_SAMPLERS.has(n)).toBe(true);
  });
});
