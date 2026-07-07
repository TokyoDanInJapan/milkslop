/**
 * Generate a synthetic, feature-covering test set of `.milk` presets.
 *
 * Unlike make-mini-corpus.mjs (which set-covers real, user-authored presets),
 * this emits presets from scratch - each deliberately crafted to exercise a
 * group of features - so the test set is self-contained and license-free. It
 * then self-verifies: every generated preset is parsed, compiled, and run for
 * one frame (must not throw), and the union of detected features is checked
 * against FEATURE_UNIVERSE. Exits non-zero if any target feature is uncovered.
 *
 * Output: test/presets-gen/*.milk + MANIFEST.md.
 * Usage: npx tsx scripts/gen-test-presets.mjs
 */
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
// Enable `.yaml` imports (src/ transitively imports ../config.yaml).
const { register } = await import("node:module");
register("./yaml-loader.mjs", import.meta.url);
const { parseMilk, CompiledPreset } = await import(
  `${root}/src/preset/index.ts`
);
const { detectFeatures, FEATURE_UNIVERSE } =
  await import("./preset-features.mjs");

const outDir = `${root}/test/presets-gen`;

/**
 * Assemble a `.milk` file from a structured spec. Numbered code blocks are
 * emitted as `{prefix}1=`, `{prefix}2=`, …; EEL lines must each be a complete
 * `;`-terminated statement (the parser concatenates them with no separator).
 * Shader blocks get a leading backtick (stripped by the parser).
 */
function milk(spec) {
  const {
    version = 201,
    psWarp = 0,
    psComp = 0,
    scalars = {},
    init = [],
    perFrame = [],
    perPixel = [],
    waves = [],
    shapes = [],
    warp = [],
    comp = [],
  } = spec;
  const L = ["[preset00]", `MILKDROP_PRESET_VERSION=${version}`];
  if (warp.length || comp.length) {
    L.push(`PSVERSION_WARP=${psWarp}`, `PSVERSION_COMP=${psComp}`);
  }
  for (const [k, val] of Object.entries(scalars)) L.push(`${k}=${val}`);
  init.forEach((l, i) => L.push(`per_frame_init_${i + 1}=${l}`));
  perFrame.forEach((l, i) => L.push(`per_frame_${i + 1}=${l}`));
  perPixel.forEach((l, i) => L.push(`per_pixel_${i + 1}=${l}`));
  waves.forEach((w, wi) => {
    for (const [k, val] of Object.entries(w.code ?? {}))
      L.push(`wavecode_${wi}_${k}=${val}`);
    (w.perPoint ?? []).forEach((l, i) =>
      L.push(`wave_${wi}_per_point${i + 1}=${l}`),
    );
    (w.perFrame ?? []).forEach((l, i) =>
      L.push(`wave_${wi}_per_frame${i + 1}=${l}`),
    );
  });
  shapes.forEach((s, si) => {
    for (const [k, val] of Object.entries(s.code ?? {}))
      L.push(`shapecode_${si}_${k}=${val}`);
    (s.perFrame ?? []).forEach((l, i) =>
      L.push(`shape_${si}_per_frame${i + 1}=${l}`),
    );
  });
  warp.forEach((l, i) => L.push(`warp_${i + 1}=\`${l}`));
  comp.forEach((l, i) => L.push(`comp_${i + 1}=\`${l}`));
  return L.join("\n") + "\n";
}

// A comp shader that touches every shader-environment feature the detector
// knows. Real math is neutralised (×0.001) so it stays a valid, compiling
// shader without needing meaningful texture content.
const KITCHEN_COMP = [
  "sampler sampler_mytex;",
  "shader_body",
  "{",
  "  float2 uv2 = uv;",
  "  ret = tex2D(sampler_main, uv2).xyz;",
  "  ret += GetBlur1(uv2)*0.001;",
  "  ret += GetBlur2(uv2)*0.001;",
  "  ret += GetBlur3(uv2)*0.001;",
  "  ret += tex2D(sampler_noise_lq, uv2*texsize.xy).xyz*0.001;",
  "  ret += tex2D(sampler_noise_mq, uv2).xyz*0.001;",
  "  ret += tex2D(sampler_noise_hq, uv2).xyz*0.001;",
  "  ret += tex3D(sampler_noisevol_lq, float3(uv2,0.5)).xyz*0.001;",
  "  ret += tex2D(sampler_fw_main, uv2).xyz*0.001;",
  "  ret += tex2D(sampler_pc_main, uv2).xyz*0.001;",
  "  ret += tex2D(sampler_mytex, uv2).xyz*0.001;",
  "  ret += (rand_frame.xyz + rand_preset.xyz)*0.001;",
  "  ret += _qa.xyz*0.001;",
  "  ret += roam_cos.xyz*0.001;",
  "  ret += lum(ret)*0.001;",
  "  ret *= hue_shader;",
  "}",
];
const SIMPLE_WARP = [
  "shader_body",
  "{",
  "  ret = tex2D(sampler_main, uv).xyz;",
  "}",
];
const SIMPLE_COMP = [
  "shader_body",
  "{",
  "  ret = tex2D(sampler_main, uv).xyz;",
  "}",
];

// One wave-mode preset per mode (0–8); spare single-value toggles are spread
// across them so each preset does double duty.
const waveModeExtras = [
  { fVideoEchoAlpha: 0.5, nVideoEchoOrientation: 0, bAdditiveWaves: 1 },
  { fVideoEchoAlpha: 0.5, nVideoEchoOrientation: 1, bWaveDots: 1 },
  { fVideoEchoAlpha: 0.5, nVideoEchoOrientation: 2, bWaveThick: 1 },
  { fVideoEchoAlpha: 0.5, nVideoEchoOrientation: 3, bModWaveAlphaByVolume: 1 },
  { bInvert: 1 },
  { bBrighten: 1 },
  { bDarken: 1 },
  { bSolarize: 1, bDarkenCenter: 1 },
  { bRedBlueStereo: 1, bTexWrap: 0 },
];

const presets = {};
for (let m = 0; m <= 8; m++) {
  presets[`gen-wave-mode-${m}`] = milk({
    scalars: { fRating: 3, nWaveMode: m, fWaveAlpha: 1, ...waveModeExtras[m] },
  });
}

presets["gen-eel-basic"] = milk({
  scalars: { fRating: 3 },
  perFrame: [
    "q1 = if(above(bass,0.5), sin(time), cos(time));",
    "q2 = equal(below(treb,2),1) + sigmoid(mid,1);",
    "q3 = atan2(q1,q2) + pow(2,3) + exp(0.1) + log(2);",
    "q4 = (3 % 2) + rand(4);",
    "q5 = (5 & 3) | 2;",
    "q6 = loop(2, q6 + 1);",
    "q7 = while(0);",
    "t1 = q1 + q2;",
    "monitor = t1;",
  ],
});

presets["gen-eel-mem"] = milk({
  scalars: { fRating: 3 },
  perFrame: [
    "q17 = megabuf(0) + gmegabuf(1);",
    "memset(0,1,4);",
    "memcpy(8,0,4);",
    "q18 = exec2(q17, q17 + 1);",
    "q19 = exec3(1,2,3);",
    "freembuf(0);",
  ],
});

presets["gen-perframe-writes"] = milk({
  scalars: { fRating: 3 },
  init: ["q1 = 0;"],
  perFrame: [
    "mv_a = 0.5;",
    "ob_a = 0.5;",
    "echo_alpha = 0.5;",
    "zoom = 1.01;",
    "wave_a = 0.5;",
    "decay = 0.98;",
    "gamma = 1.5;",
  ],
  perPixel: ["dx = dx + 0.001*rad;"],
});

presets["gen-borders-mv"] = milk({
  scalars: {
    fRating: 3,
    ob_a: 0.5, // outer border
    ib_a: 0.5, // inner border
    nMotionVectorsX: 12.5, // motion vectors + fractional grid
    mv_dx: 0.1, // motion-vector offset
    mv_a: 1,
    fZoomExponent: 2, // zoomexp
  },
});

presets["gen-custom-waves"] = milk({
  scalars: { fRating: 3 },
  waves: [
    {
      code: {
        enabled: 1,
        bSpectrum: 1,
        bUseDots: 1,
        bDrawThick: 1,
        bAdditive: 1,
      },
      perPoint: ["x = 0.5 + 0.4*sin(sample*6.28); y = 0.5;"],
    },
    { code: { enabled: 1 }, perPoint: ["x = sample; y = 0.5;"] },
  ],
});

presets["gen-custom-shapes"] = milk({
  scalars: { fRating: 3 },
  shapes: [
    {
      code: {
        enabled: 1,
        sides: 40, // circle (>30 sides)
        num_inst: 4, // instanced
        textured: 1, // textured fill
        thickOutline: 1, // thick outline
        border_a: 0.5, // border
        a: 1,
      },
    },
    { code: { enabled: 1, a: 1 } },
  ],
});

presets["gen-shader-ps2"] = milk({
  psWarp: 2,
  psComp: 2,
  scalars: { fRating: 3 },
  warp: SIMPLE_WARP,
  comp: KITCHEN_COMP,
});

presets["gen-shader-ps3"] = milk({
  psWarp: 3,
  psComp: 3,
  scalars: { fRating: 3 },
  warp: SIMPLE_WARP,
  comp: SIMPLE_COMP,
});

presets["gen-shader-mixed"] = milk({
  psComp: 2,
  scalars: { fRating: 3 },
  comp: SIMPLE_COMP, // comp shader present, no warp shader → mixed path
});

presets["gen-empty"] = milk({ scalars: { fRating: 3 } });

// ---- write, verify (parse + compile + run), detect features ----------
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const covered = new Set();
const perPreset = [];
let failures = 0;
for (const [name, text] of Object.entries(presets)) {
  const file = `${name}.milk`;
  writeFileSync(`${outDir}/${file}`, text);
  let feats;
  try {
    const parsed = parseMilk(text, name);
    const compiled = new CompiledPreset(parsed);
    compiled.runInit({ bass: 1, mid: 1, treb: 1, time: 0, frame: 0 });
    compiled.runPerFrame({ bass: 1, mid: 1, treb: 1, time: 1, frame: 1 });
    feats = detectFeatures(parsed, text);
  } catch (e) {
    console.error(`FAIL ${file}: ${e}`);
    failures++;
    continue;
  }
  for (const ft of feats) covered.add(ft);
  perPreset.push({ file, feats: [...feats].sort() });
}

const universe = new Set(FEATURE_UNIVERSE);
const missing = [...universe].filter((ft) => !covered.has(ft)).sort();
const extra = [...covered].filter((ft) => !universe.has(ft)).sort();

// ---- manifest --------------------------------------------------------
const lines = [
  "# Generated test preset set",
  "",
  `${perPreset.length} synthetic presets generated by \`scripts/gen-test-presets.mjs\`,`,
  `covering all ${universe.size} features in the canonical FEATURE_UNIVERSE`,
  "(see scripts/preset-features.mjs). Every preset parses, compiles, and runs",
  "one frame without throwing. Regenerate with `npx tsx scripts/gen-test-presets.mjs`.",
  "",
  "| Preset | Features |",
  "| ------ | -------- |",
];
for (const p of perPreset) lines.push(`| ${p.file} | ${p.feats.join(", ")} |`);
writeFileSync(`${outDir}/MANIFEST.md`, lines.join("\n") + "\n");

// ---- report ----------------------------------------------------------
console.log(
  `Generated ${perPreset.length} presets → ${outDir}\n` +
    `Coverage: ${covered.size}/${universe.size} universe features` +
    (failures ? `  (${failures} preset(s) FAILED to compile/run)` : ""),
);
if (extra.length)
  console.log(`\nFeatures beyond the universe: ${extra.join(", ")}`);
if (missing.length) {
  console.log(
    `\nMISSING ${missing.length} features:\n  ${missing.join("\n  ")}`,
  );
}
const ok = missing.length === 0 && failures === 0;
console.log(`\n${ok ? "FULL COVERAGE ✓" : "INCOMPLETE ✗"}`);
process.exit(ok ? 0 : 1);
