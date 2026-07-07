/**
 * Check all preset shaders compile in WebGL2 (via ANGLE in headless Chrome).
 * Outputs failure count + first N error lines for each failing shader.
 *
 * Usage: node scripts/check-shaders.mjs [presets-dir]
 * (default: test/presets if present, else the committed test/presets-gen)
 */
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { resolvePresetsDir } from "./corpus.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

// Enable `.yaml` imports (src/ transitively imports ../config.yaml) before the
// dynamic imports below.
const { register } = await import("node:module");
register("./yaml-loader.mjs", import.meta.url);

// Build the transpiled GLSL for every shader at Node level, then send to browser.
// Dynamic import (tsx/vite transforms) works here.
const { parseMilk } = await import(`${root}/src/preset/MilkParser.ts`);
const { transpile } = await import(`${root}/src/shader/transpile.ts`);
const { buildFragmentShader } = await import(
  `${root}/src/shader/environment.ts`
);

const presetsDir = resolvePresetsDir(root, process.argv[2]);
const presetFiles = readdirSync(presetsDir).filter((f) => f.endsWith(".milk"));

const shaders = [];
for (const f of presetFiles) {
  const src = readFileSync(`${presetsDir}/${f}`, "utf8");
  const p = parseMilk(src);
  for (const [kind, code] of [
    ["warp", p.warpShader],
    ["comp", p.compShader],
  ]) {
    if (!code) continue;
    try {
      const r = transpile(code);
      const glsl = buildFragmentShader(r, kind);
      shaders.push({ id: `${f}:${kind}`, glsl });
    } catch (e) {
      shaders.push({ id: `${f}:${kind}`, error: String(e) });
    }
  }
}

console.log(`Transpiled ${shaders.length} shaders. Launching browser…`);

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

// Inject a minimal HTML page with a WebGL2 canvas
await page.setContent(`<canvas id="c"></canvas>`);

const results = await page.evaluate((shaders) => {
  const canvas = document.getElementById("c");
  const gl = canvas.getContext("webgl2");
  if (!gl) return [{ id: "SETUP", error: "WebGL2 unavailable" }];

  // Minimal vertex shader
  const VS_SRC = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0,1); }`;

  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, VS_SRC);
  gl.compileShader(vs);

  const out = [];
  for (const { id, glsl, error } of shaders) {
    if (error) {
      out.push({ id, error });
      continue;
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, glsl);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs) || "";
      out.push({ id, error: log.substring(0, 400) });
    }
    gl.deleteShader(fs);
  }
  return out;
}, shaders);

await browser.close();

const failures = results.filter((r) => r.error);
const total = shaders.length;
console.log(`\n${failures.length}/${total} failures`);

// Group by unique error pattern
const byError = {};
for (const { id, error } of failures) {
  const key = error.split("\n").slice(0, 2).join("|");
  if (!byError[key]) byError[key] = { error, ids: [] };
  byError[key].ids.push(id);
}

for (const { error, ids } of Object.values(byError).sort(
  (a, b) => b.ids.length - a.ids.length,
)) {
  const firstLine =
    error.split("\n").find((l) => l.includes("ERROR")) || error.split("\n")[0];
  console.log(`\n[${ids.length}x] ${firstLine.trim().substring(0, 100)}`);
  ids.slice(0, 2).forEach((id) => console.log(`  ${id}`));
}
