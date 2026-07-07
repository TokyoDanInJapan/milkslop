/**
 * Parsed representation of a `.milk` preset.
 *
 * @remarks
 * Scalar parameters are stored in {@link PresetState.vals}, keyed by the
 * per-frame variable name they seed (e.g. `"zoom"`, `"decay"`, `"wave_r"`) so
 * the renderer can load them into the EEL variable bag each frame (cf.
 * `LoadPerFrameEvallibVars`). A handful of state-only scalars that are not
 * exposed to equations use descriptive keys.
 */

import { constants } from "../config.ts";

/** Maximum number of custom waves a preset may define. */
export const MAX_CUSTOM_WAVES = constants.preset.maxCustomWaves;
/** Maximum number of custom shapes a preset may define. */
export const MAX_CUSTOM_SHAPES = constants.preset.maxCustomShapes;

/** One custom wave: a per-point waveform with its own equation blocks. */
export interface CustomWave {
  index: number;
  enabled: boolean;
  samples: number;
  sep: number;
  spectrum: boolean;
  useDots: boolean;
  drawThick: boolean;
  additive: boolean;
  scaling: number;
  smoothing: number;
  r: number;
  g: number;
  b: number;
  a: number;
  initCode: string;
  perFrameCode: string;
  perPointCode: string;
}

/** One custom shape: an n-sided polygon driven by a per-frame equation block. */
export interface CustomShape {
  index: number;
  enabled: boolean;
  sides: number;
  additive: boolean;
  thickOutline: boolean;
  textured: boolean;
  instances: number;
  x: number;
  y: number;
  rad: number;
  ang: number;
  texAng: number;
  texZoom: number;
  r: number;
  g: number;
  b: number;
  a: number;
  r2: number;
  g2: number;
  b2: number;
  a2: number;
  borderR: number;
  borderG: number;
  borderB: number;
  borderA: number;
  initCode: string;
  perFrameCode: string;
}

/** The fully parsed preset: render flags, scalar baselines, code, and geometry. */
export interface PresetState {
  name: string;
  rating: number;
  presetVersion: number;

  /** Pixel-shader versions: 0 = none (MilkDrop 1 era), 2 = ps_2_0, 3 = ps_3_0. */
  warpPSVersion: number;
  compPSVersion: number;

  /** Scalar baseline values, keyed by per-frame variable name. */
  vals: Record<string, number>;

  perFrameInitCode: string;
  perFrameCode: string;
  perPixelCode: string;

  warpShader: string; // raw HLSL (transpiled by src/shader)
  compShader: string;

  waves: CustomWave[];
  shapes: CustomShape[];
}

/**
 * Scalar parameter table: `[ iniKey, valsKey, default ]`, covering every scalar
 * MilkDrop writes/reads. Booleans are stored as 0/1. Defaults come from
 * `CState::Default` (state.cpp).
 */
export const SCALAR_PARAMS: ReadonlyArray<readonly [string, string, number]> = [
  // general
  ["fRating", "rating", 3.0],
  ["fGammaAdj", "gamma", 2.0],
  ["fDecay", "decay", 0.98],
  ["fVideoEchoZoom", "echo_zoom", 2.0],
  ["fVideoEchoAlpha", "echo_alpha", 0.0],
  ["nVideoEchoOrientation", "echo_orient", 0],
  ["nWaveMode", "wave_mode", 0],
  ["bAdditiveWaves", "wave_additive", 0],
  ["bWaveDots", "wave_usedots", 0],
  ["bWaveThick", "wave_thick", 0],
  ["bModWaveAlphaByVolume", "wave_mod_alpha_by_volume", 0],
  ["bMaximizeWaveColor", "wave_brighten", 1],
  ["bTexWrap", "wrap", 1],
  ["bDarkenCenter", "darken_center", 0],
  ["bRedBlueStereo", "red_blue_stereo", 0],
  ["bBrighten", "brighten", 0],
  ["bDarken", "darken", 0],
  ["bSolarize", "solarize", 0],
  ["bInvert", "invert", 0],
  // wave
  ["fWaveAlpha", "wave_a", 0.8],
  ["fWaveScale", "wave_scale", 1.0],
  ["fWaveSmoothing", "wave_smoothing", 0.75],
  ["fWaveParam", "wave_mystery", 0.0],
  ["fModWaveAlphaStart", "wave_mod_alpha_start", 0.75],
  ["fModWaveAlphaEnd", "wave_mod_alpha_end", 0.95],
  ["fWarpAnimSpeed", "warp_anim_speed", 1.0],
  ["fWarpScale", "warp_scale", 1.0],
  ["fZoomExponent", "zoomexp", 1.0],
  ["fShader", "fshader", 0.0],
  // motion
  ["zoom", "zoom", 1.0],
  ["rot", "rot", 0.0],
  ["cx", "cx", 0.5],
  ["cy", "cy", 0.5],
  ["dx", "dx", 0.0],
  ["dy", "dy", 0.0],
  ["warp", "warp", 1.0],
  ["sx", "sx", 1.0],
  ["sy", "sy", 1.0],
  // wave colour/position
  ["wave_r", "wave_r", 1.0],
  ["wave_g", "wave_g", 1.0],
  ["wave_b", "wave_b", 1.0],
  ["wave_x", "wave_x", 0.5],
  ["wave_y", "wave_y", 0.5],
  // borders
  ["ob_size", "ob_size", 0.01],
  ["ob_r", "ob_r", 0.0],
  ["ob_g", "ob_g", 0.0],
  ["ob_b", "ob_b", 0.0],
  ["ob_a", "ob_a", 0.0],
  ["ib_size", "ib_size", 0.01],
  ["ib_r", "ib_r", 0.25],
  ["ib_g", "ib_g", 0.25],
  ["ib_b", "ib_b", 0.25],
  ["ib_a", "ib_a", 0.0],
  // motion vectors
  ["nMotionVectorsX", "mv_x", 12.0],
  ["nMotionVectorsY", "mv_y", 9.0],
  ["mv_dx", "mv_dx", 0.0],
  ["mv_dy", "mv_dy", 0.0],
  ["mv_l", "mv_l", 0.9],
  ["mv_r", "mv_r", 1.0],
  ["mv_g", "mv_g", 1.0],
  ["mv_b", "mv_b", 1.0],
  ["mv_a", "mv_a", 1.0],
  // blur
  ["b1n", "blur1_min", 0.0],
  ["b2n", "blur2_min", 0.0],
  ["b3n", "blur3_min", 0.0],
  ["b1x", "blur1_max", 1.0],
  ["b2x", "blur2_max", 1.0],
  ["b3x", "blur3_max", 1.0],
  ["b1ed", "blur1_edge_darken", 0.25],
];

/**
 * Build a fresh `vals` record populated with every parameter's default.
 *
 * @returns A name → value map seeded from {@link SCALAR_PARAMS}.
 */
export function defaultVals(): Record<string, number> {
  const vals: Record<string, number> = {};
  for (const [, key, def] of SCALAR_PARAMS) vals[key] = def;
  return vals;
}
