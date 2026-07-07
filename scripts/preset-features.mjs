/**
 * Shared preset feature detector + the canonical feature universe.
 *
 * `detectFeatures` tags a parsed PresetState with the pipeline / EEL / render /
 * shader features it exercises. It is the single definition of "a feature",
 * used both by `make-mini-corpus.mjs` (set-cover over real presets) and
 * `gen-test-presets.mjs` (generate synthetic presets that cover everything).
 *
 * `FEATURE_UNIVERSE` is the authoritative list of every feature the generator
 * targets - keep it in sync with the detectors below.
 */

/** All EEL code blocks of a parsed preset, concatenated and lowercased. */
export function allCode(p) {
  const parts = [p.perFrameInitCode, p.perFrameCode, p.perPixelCode];
  for (const w of p.waves)
    parts.push(w.initCode, w.perFrameCode, w.perPointCode);
  for (const s of p.shapes) parts.push(s.initCode, s.perFrameCode);
  return parts.join("\n").toLowerCase();
}

/**
 * Extract the feature set one preset exercises.
 *
 * @param p - A parsed PresetState (from parseMilk).
 * @param raw - The raw `.milk` text (for backtick detection).
 * @returns A Set of feature tags.
 */
export function detectFeatures(p, raw) {
  const f = new Set();
  const v = p.vals;
  const code = allCode(p);
  const shaders = (p.warpShader + "\n" + p.compShader).toLowerCase();
  const pf = p.perFrameCode.toLowerCase();

  // --- pipeline paths -------------------------------------------------
  if (p.warpShader) f.add(`warp-shader-ps${p.warpPSVersion}`);
  else f.add("warp-noshader");
  if (p.compShader) f.add(`comp-shader-ps${p.compPSVersion}`);
  else f.add("comp-noshader");
  if (!!p.warpShader !== !!p.compShader) f.add("shader-mixed");
  if (p.perFrameInitCode) f.add("per-frame-init");
  if (p.perFrameCode) f.add("per-frame");
  if (p.perPixelCode) f.add("per-pixel");
  if (!code.trim()) f.add("no-eel-code");

  // --- EEL language features ------------------------------------------
  const eel = [
    ["megabuf", /\bmegabuf\s*\(/],
    ["gmegabuf", /\bgmegabuf\s*\(/],
    ["monitor", /\bmonitor\b/],
    ["loop-fn", /\bloop\s*\(/],
    ["while-fn", /\bwhile\s*\(/],
    ["if-fn", /\bif\s*\(/],
    ["rand-fn", /\brand\s*\(/],
    ["sigmoid", /\bsigmoid\s*\(/],
    ["bitwise", /[&|]/],
    ["modulo", /%/],
    ["atan2", /\batan2\s*\(/],
    ["pow-exp-log", /\b(pow|exp|log|log10)\s*\(/],
    ["equal-above-below", /\b(equal|above|below|bnot)\s*\(/],
    ["memset-memcpy", /\b(memset|memcpy|freembuf)\s*\(/],
    ["exec", /\bexec[23]\s*\(/],
  ];
  for (const [name, re] of eel) if (re.test(code)) f.add(`eel-${name}`);
  if (/\bq(1[7-9]|2\d|3[0-2])\b/.test(code)) f.add("eel-q-high");
  else if (/\bq\d+\b/.test(code)) f.add("eel-q-low");
  if (/\bt[1-8]\b/.test(code)) f.add("eel-t-vars");
  if (raw.includes("`")) f.add("backtick-escape");

  // per_frame writing animated param groups (static vals can't see these)
  const writes = [
    ["pf-writes-mv", /\bmv_(x|y|a|l|dx|dy|r|g|b)\s*=/],
    ["pf-writes-border", /\b[oi]b_(size|a|r|g|b)\s*=/],
    ["pf-writes-echo", /\becho_(alpha|zoom|orient)\s*=/],
    ["pf-writes-motion", /\b(zoom|rot|warp|dx|dy|cx|cy|sx|sy)\s*=/],
    ["pf-writes-wave", /\bwave_(x|y|r|g|b|a|mystery|mode)\s*=/],
    ["pf-writes-decay-gamma", /\b(decay|gamma)\s*=/],
  ];
  for (const [name, re] of writes) if (re.test(pf)) f.add(name);

  // --- render features (static values) ---------------------------------
  f.add(`wave-mode-${Math.floor(v.wave_mode ?? 0)}`);
  if (v.wave_additive) f.add("wave-additive");
  if (v.wave_usedots) f.add("wave-dots");
  if (v.wave_thick) f.add("wave-thick");
  if (v.wave_mod_alpha_by_volume) f.add("wave-mod-alpha");
  if ((v.echo_alpha ?? 0) > 0.001) {
    f.add("echo-on");
    f.add(`echo-orient-${Math.floor(v.echo_orient ?? 0)}`);
  }
  if (v.invert) f.add("invert");
  if (v.brighten) f.add("brighten");
  if (v.darken) f.add("darken");
  if (v.solarize) f.add("solarize");
  if (v.darken_center) f.add("darken-center");
  if (v.red_blue_stereo) f.add("red-blue-stereo");
  if (!v.wrap) f.add("texwrap-off");
  if ((v.ob_a ?? 0) > 0.001) f.add("outer-border");
  if ((v.ib_a ?? 0) > 0.001) f.add("inner-border");
  const mvX = v.mv_x ?? 12;
  const mvY = v.mv_y ?? 9;
  if ((v.mv_a ?? 1) > 0.001 && mvX >= 1 && mvY >= 1) {
    f.add("motion-vectors");
    if (mvX % 1 > 0.01 || mvY % 1 > 0.01) f.add("mv-fractional");
    if (Math.abs(v.mv_dx ?? 0) > 0.001 || Math.abs(v.mv_dy ?? 0) > 0.001)
      f.add("mv-offset");
  }
  if ((v.zoomexp ?? 1) !== 1) f.add("zoomexp");

  // --- custom waves / shapes -------------------------------------------
  const waves = p.waves.filter((w) => w.enabled);
  const shapes = p.shapes.filter((s) => s.enabled);
  if (waves.length) f.add("custom-wave");
  if (waves.length >= 2) f.add("custom-wave-multi");
  if (waves.some((w) => w.spectrum)) f.add("cwave-spectrum");
  if (waves.some((w) => w.useDots)) f.add("cwave-dots");
  if (waves.some((w) => w.drawThick)) f.add("cwave-thick");
  if (waves.some((w) => w.perPointCode)) f.add("cwave-per-point");
  if (shapes.length) f.add("custom-shape");
  if (shapes.length >= 2) f.add("custom-shape-multi");
  if (shapes.some((s) => s.textured)) f.add("cshape-textured");
  if (shapes.some((s) => s.instances > 1)) f.add("cshape-instanced");
  if (shapes.some((s) => s.sides > 30)) f.add("cshape-circle");
  if (shapes.some((s) => s.thickOutline)) f.add("cshape-thick-outline");
  if (shapes.some((s) => (s.borderA ?? 0) > 0.001)) f.add("cshape-border");

  // --- shader environment ----------------------------------------------
  if (p.warpShader || p.compShader) {
    const sh = [
      ["blur1", /(sampler_blur1|getblur1)/],
      ["blur2", /(sampler_blur2|getblur2)/],
      ["blur3", /(sampler_blur3|getblur3)/],
      ["noise-lq", /noise_lq/],
      ["noise-mq", /noise_mq/],
      ["noise-hq", /noise_hq/],
      ["noisevol", /noisevol/],
      ["sampler-fw-pw", /sampler_[fp]w_main/],
      ["sampler-fc-pc", /sampler_[fp]c_main/],
      ["rand-uniforms", /rand_(frame|preset)/],
      ["q-float4s", /_q[a-h]\b/],
      ["roam", /roam_(cos|sin)/],
      ["tex3d", /tex3d\s*\(/],
      ["texsize", /texsize\b/],
      ["fn-lum", /\blum\s*\(/],
      ["hue-uniform", /\bhue_shader\b/],
    ];
    for (const [name, re] of sh) if (re.test(shaders)) f.add(`shader-${name}`);
    // user-defined texture samplers (sampler_XXX outside the builtin set)
    const builtin =
      /sampler_(main|fw_main|pw_main|fc_main|pc_main|blur[123]|noise_lq|noise_lq_lite|noise_mq|noise_hq|noisevol_lq|noisevol_hq)\b/g;
    const all = shaders.match(/sampler_\w+/g) ?? [];
    if (all.some((s) => !s.match(builtin))) f.add("shader-user-sampler");
  }

  return f;
}

/**
 * Every feature the synthetic generator targets. Wave modes 0–8 and echo
 * orientations 0–3 are enumerated explicitly; everything else is one tag.
 */
export const FEATURE_UNIVERSE = [
  // pipeline
  "warp-shader-ps2",
  "warp-shader-ps3",
  "warp-noshader",
  "comp-shader-ps2",
  "comp-shader-ps3",
  "comp-noshader",
  "shader-mixed",
  "per-frame-init",
  "per-frame",
  "per-pixel",
  "no-eel-code",
  // EEL
  "eel-megabuf",
  "eel-gmegabuf",
  "eel-monitor",
  "eel-loop-fn",
  "eel-while-fn",
  "eel-if-fn",
  "eel-rand-fn",
  "eel-sigmoid",
  "eel-bitwise",
  "eel-modulo",
  "eel-atan2",
  "eel-pow-exp-log",
  "eel-equal-above-below",
  "eel-memset-memcpy",
  "eel-exec",
  "eel-q-high",
  "eel-q-low",
  "eel-t-vars",
  "backtick-escape",
  // per_frame writes
  "pf-writes-mv",
  "pf-writes-border",
  "pf-writes-echo",
  "pf-writes-motion",
  "pf-writes-wave",
  "pf-writes-decay-gamma",
  // render - wave modes
  "wave-mode-0",
  "wave-mode-1",
  "wave-mode-2",
  "wave-mode-3",
  "wave-mode-4",
  "wave-mode-5",
  "wave-mode-6",
  "wave-mode-7",
  "wave-mode-8",
  // render - wave style
  "wave-additive",
  "wave-dots",
  "wave-thick",
  "wave-mod-alpha",
  // render - echo
  "echo-on",
  "echo-orient-0",
  "echo-orient-1",
  "echo-orient-2",
  "echo-orient-3",
  // render - composite toggles
  "invert",
  "brighten",
  "darken",
  "solarize",
  "darken-center",
  "red-blue-stereo",
  "texwrap-off",
  // render - borders / motion vectors / zoom
  "outer-border",
  "inner-border",
  "motion-vectors",
  "mv-fractional",
  "mv-offset",
  "zoomexp",
  // custom waves / shapes
  "custom-wave",
  "custom-wave-multi",
  "cwave-spectrum",
  "cwave-dots",
  "cwave-thick",
  "cwave-per-point",
  "custom-shape",
  "custom-shape-multi",
  "cshape-textured",
  "cshape-instanced",
  "cshape-circle",
  "cshape-thick-outline",
  "cshape-border",
  // shader environment
  "shader-blur1",
  "shader-blur2",
  "shader-blur3",
  "shader-noise-lq",
  "shader-noise-mq",
  "shader-noise-hq",
  "shader-noisevol",
  "shader-sampler-fw-pw",
  "shader-sampler-fc-pc",
  "shader-rand-uniforms",
  "shader-q-float4s",
  "shader-roam",
  "shader-tex3d",
  "shader-texsize",
  "shader-fn-lum",
  "shader-hue-uniform",
  "shader-user-sampler",
];
