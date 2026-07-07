/**
 * Dump the transpiled GLSL of one preset shader with the compile error context.
 * Usage: npx tsx scripts/debug-shader.mjs "<preset name substring>" <warp|comp> [contextLines] [presets-dir]
 * (corpus default: test/presets if present, else the committed test/presets-gen)
 */
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { resolvePresetsDir } from "./corpus.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

// Enable `.yaml` imports (src/ transitively imports ../config.yaml).
const { register } = await import("node:module");
register("./yaml-loader.mjs", import.meta.url);

const { parseMilk } = await import(`${root}/src/preset/MilkParser.ts`);
const { transpile } = await import(`${root}/src/shader/transpile.ts`);
const { buildFragmentShader } = await import(
  `${root}/src/shader/environment.ts`
);

const [needle, kind = "comp", ctx = "6", dirArg] = process.argv.slice(2);
const presetsDir = resolvePresetsDir(root, dirArg);
const file = readdirSync(presetsDir).find(
  (f) => f.endsWith(".milk") && f.toLowerCase().includes(needle.toLowerCase()),
);
if (!file) {
  console.error("No preset matching:", needle);
  process.exit(1);
}
console.log("Preset:", file, "| kind:", kind);

const p = parseMilk(readFileSync(`${presetsDir}/${file}`, "utf8"));
const code = kind === "warp" ? p.warpShader : p.compShader;
if (!code) {
  console.error("No", kind, "shader in preset");
  process.exit(1);
}
const r = transpile(code);
const glsl = buildFragmentShader(r, kind);

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage();
await page.setContent(`<canvas id="c"></canvas>`);
const log = await page.evaluate((glsl) => {
  const gl = document.getElementById("c").getContext("webgl2");
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, glsl);
  gl.compileShader(fs);
  return gl.getShaderParameter(fs, gl.COMPILE_STATUS)
    ? ""
    : gl.getShaderInfoLog(fs) || "";
}, glsl);
await browser.close();

if (!log) {
  console.log("COMPILES OK");
  process.exit(0);
}
console.log("--- error log ---");
console.log(log.substring(0, 1200));

const lines = glsl.split("\n");
const n = parseInt(ctx, 10);
const seen = new Set();
for (const m of log.matchAll(/ERROR: 0:(\d+)/g)) {
  const ln = parseInt(m[1], 10);
  if (seen.has(ln)) continue;
  seen.add(ln);
  console.log(`--- context around line ${ln} ---`);
  for (
    let i = Math.max(0, ln - n - 1);
    i < Math.min(lines.length, ln + n);
    i++
  ) {
    console.log(`${i + 1}${i + 1 === ln ? ">" : " "}\t${lines[i]}`);
  }
  if (seen.size >= 3) break;
}
