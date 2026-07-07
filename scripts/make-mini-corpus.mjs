/**
 * Build a minimal feature-covering subset of test/presets.
 *
 * Parses every preset with the real MilkParser, tags it with the pipeline /
 * EEL / render / shader features it exercises, then greedily solves set-cover
 * to pick the smallest subset that still covers every feature present in the
 * corpus. Copies the winners to test/presets-mini/ and writes a MANIFEST.md
 * mapping each preset to the features it was chosen for.
 *
 * Usage: npx tsx scripts/make-mini-corpus.mjs [presets-dir]
 * (default source: test/presets — a local, gitignored full corpus)
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
// Enable `.yaml` imports (src/ transitively imports ../config.yaml).
const { register } = await import("node:module");
register("./yaml-loader.mjs", import.meta.url);
const { parseMilk } = await import(`${root}/src/preset/MilkParser.ts`);
const { detectFeatures } = await import("./preset-features.mjs");

const presetsDir = process.argv[2]
  ? resolve(process.argv[2])
  : `${root}/test/presets`;
if (!existsSync(presetsDir)) {
  console.error(
    `Presets directory not found: ${presetsDir}\n` +
      "This script distills a full user corpus; place one at test/presets " +
      "or pass a directory of .milk files as the first argument.",
  );
  process.exit(1);
}
const outDir = `${root}/test/presets-mini`;
const files = readdirSync(presetsDir).filter((f) => f.endsWith(".milk"));

// ---- extract ----------------------------------------------------------
const presets = [];
for (const file of files) {
  const raw = readFileSync(`${presetsDir}/${file}`, "latin1");
  try {
    const p = parseMilk(raw);
    presets.push({ file, feats: detectFeatures(p, raw) });
  } catch (e) {
    console.error(`PARSE FAIL ${file}: ${e}`);
  }
}

const universe = new Set();
for (const p of presets) for (const ft of p.feats) universe.add(ft);
console.log(`${presets.length} presets, ${universe.size} distinct features`);

// ---- greedy set cover -------------------------------------------------
const uncovered = new Set(universe);
const chosen = [];
while (uncovered.size > 0) {
  let best = null;
  let bestGain = 0;
  for (const p of presets) {
    let gain = 0;
    for (const ft of p.feats) if (uncovered.has(ft)) gain++;
    // ties: prefer alphabetically-first for determinism
    if (
      gain > bestGain ||
      (gain === bestGain && best && gain > 0 && p.file < best.file)
    ) {
      best = p;
      bestGain = gain;
    }
  }
  if (!best || bestGain === 0) break;
  const newly = [...best.feats].filter((ft) => uncovered.has(ft)).sort();
  chosen.push({ ...best, newly });
  for (const ft of best.feats) uncovered.delete(ft);
}

// ---- emit ---------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const lines = [
  "# Mini preset corpus",
  "",
  `${chosen.length} presets selected from ${presets.length} to cover all`,
  `${universe.size} features detected in the full corpus (greedy set-cover).`,
  "Regenerate with `npx tsx scripts/make-mini-corpus.mjs`.",
  "",
  "| Preset | Newly-covered features |",
  "| ------ | ---------------------- |",
];
for (const c of chosen) {
  copyFileSync(`${presetsDir}/${c.file}`, `${outDir}/${c.file}`);
  lines.push(`| ${c.file} | ${c.newly.join(", ")} |`);
}
writeFileSync(`${outDir}/MANIFEST.md`, lines.join("\n") + "\n");

console.log(`\nChose ${chosen.length} presets → ${outDir}`);
for (const c of chosen)
  console.log(
    `  ${c.file}  (+${c.newly.length}: ${c.newly.slice(0, 6).join(", ")}${c.newly.length > 6 ? ", …" : ""})`,
  );
if (uncovered.size)
  console.log(`\nWARNING: uncoverable features: ${[...uncovered].join(", ")}`);
