import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseMilk } from "../src/preset/MilkParser.ts";
import { transpile } from "../src/shader/transpile.ts";

// Characterization ("golden") tests: lock in the exact transpiler output for
// every shader in the committed corpus so refactors of transpile.ts can be
// verified to be behavior-preserving. Update with `vitest run -u` only when
// an output change is intended.
const corpusDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "presets-gen",
);

describe("transpile golden output (test/presets-gen corpus)", () => {
  const files = readdirSync(corpusDir)
    .filter((f) => f.endsWith(".milk"))
    .sort();

  it("finds the committed corpus", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const preset = parseMilk(readFileSync(`${corpusDir}/${file}`, "utf8"));
    for (const [kind, code] of [
      ["warp", preset.warpShader],
      ["comp", preset.compShader],
    ] as const) {
      if (!code) continue;
      it(`${file} ${kind} shader transpiles to a stable result`, async () => {
        const r = transpile(code);
        const rendered = [
          `// samplers: ${[...r.samplers].sort().join(", ")}`,
          `// samplers3D: ${[...r.samplers3D].sort().join(", ")}`,
          `// hasBody: ${r.hasBody}`,
          "// ---- preamble ----",
          r.preamble,
          "// ---- body ----",
          r.body,
        ].join("\n");
        await expect(rendered).toMatchFileSnapshot(
          `__snapshots__/transpile-golden/${file}.${kind}.glsl`,
        );
      });
    }
  }
});
