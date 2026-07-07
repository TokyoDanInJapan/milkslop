/**
 * Parses MilkDrop .milk preset text into a PresetState.
 *
 * Format (see state.cpp Import/Export): an INI-like list of key=value lines.
 * Scalars are single keys; equation/shader blocks are split across numbered
 * keys (e.g. per_frame_1=, per_frame_2=, warp_1=, wave_0_per_point_1=). Reading
 * a block stops at the first missing index. A leading backtick on a code line
 * is a literal-escape and is stripped.
 */

import {
  defaultVals,
  MAX_CUSTOM_SHAPES,
  MAX_CUSTOM_WAVES,
  SCALAR_PARAMS,
  type CustomShape,
  type CustomWave,
  type PresetState,
} from "./types.ts";
import { constants } from "../config.ts";

/**
 * Parse MilkDrop `.milk` preset text into a {@link PresetState}.
 *
 * @param text - The raw `.milk` file contents.
 * @param name - Display name for the preset.
 * @returns The parsed preset state.
 */
export function parseMilk(text: string, name = "untitled"): PresetState {
  const kv = parseIni(text);
  const num = (key: string, def: number): number => {
    const v = kv.get(key.toLowerCase());
    if (v === undefined) return def;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : def;
  };

  const vals = defaultVals();
  for (const [iniKey, valsKey, def] of SCALAR_PARAMS) {
    vals[valsKey] = num(iniKey, def);
  }

  const presetVersion = Math.round(num("MILKDROP_PRESET_VERSION", 100));
  let warpPSVersion: number;
  let compPSVersion: number;
  if (presetVersion < 200) {
    warpPSVersion = 0;
    compPSVersion = 0;
  } else if (presetVersion === 200) {
    warpPSVersion = compPSVersion = Math.round(num("PSVERSION", 2));
  } else {
    warpPSVersion = Math.round(num("PSVERSION_WARP", 2));
    compPSVersion = Math.round(num("PSVERSION_COMP", 2));
  }

  const warpShader = readBlock(kv, "warp_");
  const compShader = readBlock(kv, "comp_");
  // If no shader text is present, treat as version 0 (no-shader path).
  if (!warpShader.trim()) warpPSVersion = 0;
  if (!compShader.trim()) compPSVersion = 0;

  const waves: CustomWave[] = [];
  for (let i = 0; i < MAX_CUSTOM_WAVES; i++) waves.push(readWave(kv, i, num));
  const shapes: CustomShape[] = [];
  for (let i = 0; i < MAX_CUSTOM_SHAPES; i++)
    shapes.push(readShape(kv, i, num));

  return {
    name,
    rating: vals.rating ?? constants.preset.defaultRating,
    presetVersion,
    warpPSVersion,
    compPSVersion,
    vals,
    perFrameInitCode: readBlock(kv, "per_frame_init_", "eel"),
    perFrameCode: readBlock(kv, "per_frame_", "eel"),
    perPixelCode: readBlock(kv, "per_pixel_", "eel"),
    warpShader,
    compShader,
    waves,
    shapes,
  };
}

/** Parse `key=value` lines into a Map (lower-cased keys; values verbatim). */
function parseIni(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine;
    if (line.length === 0) continue;
    const c = line[0]!;
    if (c === "[" || c === ";") continue; // section header / comment
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1);
    if (key) map.set(key, value);
  }
  return map;
}

/**
 * Assemble a numbered code block: `{prefix}1`, `{prefix}2`, ... stopping at the
 * first missing index. A leading backtick is stripped.
 *
 * EEL equation blocks (`mode: "eel"`) follow MilkDrop semantics: per-line `//`
 * comments are stripped, then lines are concatenated with NO separator -
 * presets rely on this to split long statements (even identifiers) across
 * lines. Shader blocks keep newlines so HLSL comments stay line-scoped.
 */
function readBlock(
  kv: Map<string, string>,
  prefix: string,
  mode: "code" | "eel" = "code",
): string {
  const lines: string[] = [];
  for (let i = 1; ; i++) {
    const v = kv.get(`${prefix}${i}`.toLowerCase());
    if (v === undefined) break;
    lines.push(v[0] === "`" ? v.slice(1) : v);
  }
  if (mode === "eel")
    return lines.map((l) => l.replace(/\/\/.*$/, "")).join("");
  return lines.join("\n");
}

type NumFn = (key: string, def: number) => number;

/** Read custom wave `i`'s flags, colours, and EEL code blocks from the parsed ini. */
function readWave(kv: Map<string, string>, i: number, num: NumFn): CustomWave {
  const p = `wavecode_${i}_`;
  const flag = (k: string, d: number) => Math.round(num(p + k, d)) !== 0;
  return {
    index: i,
    enabled: flag("enabled", 0),
    samples: Math.round(num(p + "samples", 512)),
    sep: Math.round(num(p + "sep", 0)),
    spectrum: flag("bSpectrum", 0),
    useDots: flag("bUseDots", 0),
    drawThick: flag("bDrawThick", 0),
    additive: flag("bAdditive", 0),
    scaling: num(p + "scaling", 1.0),
    smoothing: num(p + "smoothing", 0.5),
    r: num(p + "r", 1.0),
    g: num(p + "g", 1.0),
    b: num(p + "b", 1.0),
    a: num(p + "a", 1.0),
    initCode: readBlock(kv, `wave_${i}_init`, "eel"),
    perFrameCode: readBlock(kv, `wave_${i}_per_frame`, "eel"),
    perPointCode: readBlock(kv, `wave_${i}_per_point`, "eel"),
  };
}

/** Read custom shape `i`'s flags, colours, and EEL code blocks from the parsed ini. */
function readShape(
  kv: Map<string, string>,
  i: number,
  num: NumFn,
): CustomShape {
  const p = `shapecode_${i}_`;
  const flag = (k: string, d: number) => Math.round(num(p + k, d)) !== 0;
  return {
    index: i,
    enabled: flag("enabled", 0),
    sides: Math.round(num(p + "sides", 4)),
    additive: flag("additive", 0),
    thickOutline: flag("thickOutline", 0),
    textured: flag("textured", 0),
    instances: Math.round(num(p + "num_inst", 1)),
    x: num(p + "x", 0.5),
    y: num(p + "y", 0.5),
    rad: num(p + "rad", 0.1),
    ang: num(p + "ang", 0.0),
    texAng: num(p + "tex_ang", 0.0),
    texZoom: num(p + "tex_zoom", 1.0),
    r: num(p + "r", 1.0),
    g: num(p + "g", 0.0),
    b: num(p + "b", 0.0),
    a: num(p + "a", 1.0),
    r2: num(p + "r2", 0.0),
    g2: num(p + "g2", 1.0),
    b2: num(p + "b2", 0.0),
    a2: num(p + "a2", 0.0),
    borderR: num(p + "border_r", 1.0),
    borderG: num(p + "border_g", 1.0),
    borderB: num(p + "border_b", 1.0),
    borderA: num(p + "border_a", 0.1),
    initCode: readBlock(kv, `shape_${i}_init`, "eel"),
    perFrameCode: readBlock(kv, `shape_${i}_per_frame`, "eel"),
  };
}
