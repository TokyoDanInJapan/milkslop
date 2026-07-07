/**
 * Typed accessor for the root `config.yaml` - the single source of truth for
 * Milkslop's global values (tunable parameters and faithful-port engine
 * constants). The YAML is loaded at build time by the Vite yaml plugin (see
 * `vite.config.ts`), so these values are available synchronously at module
 * evaluation and usable from pure functions and unit tests alike.
 *
 * Modules across `src/` re-export their named constants from here rather than
 * hardcoding them; edit `config.yaml`, not the call sites.
 */

import raw from "../config.yaml";

/** User-facing tunables (analogues of MilkDrop's milk2.ini settings). */
export interface Tunables {
  timeBetweenPresets: number;
  fastModeInterval: number;
  blendDuration: number;
  shuffle: boolean;
  hardCutsEnabled: boolean;
  hardCutLoudness: number;
  hardCutHalflife: number;
  meshGridX: number;
  meshGridY: number;
}

/** Faithful-port engine constants and structural invariants. */
export interface Constants {
  eel: {
    closefact: number;
    maxLoop: number;
    megabufBlock: number;
    megabufMaxBlocks: number;
    numQVars: number;
    numTVars: number;
  };
  preset: {
    maxCustomWaves: number;
    maxCustomShapes: number;
    defaultRating: number;
  };
  audio: {
    waveSamples: number;
    bassEdge: number;
    midEdge: number;
    avgTimeConstant: number;
    attTimeConstant: number;
  };
  warp: {
    /** Per-coefficient `[base, amp, freq, phase]` rows (length 4). */
    coefficients: [number, number, number, number][];
  };
  blur: {
    /** 16-tap symmetric weights, centre first (length 8). */
    kernel: number[];
    minDistance: number;
    edgeDarkenScale: number;
  };
  waveform: { numSamples: number };
  motionVectors: { maxX: number; maxY: number };
  borders: {
    vertsPerBorder: number;
    darkenCenterHalfSize: number;
    darkenCenterAlpha: number;
  };
  noise: {
    size2D: number;
    sizeLite: number;
    size3D: number;
    zoom2D: number[];
    zoom3D: number[];
    rangeZoomed: number;
    rangePlain: number;
  };
  hardCut: { decayConstant: number };
  layout: { floatsPerVert: number; texFloatsPerVert: number };
}

/** The full parsed configuration. */
export interface Config {
  tunables: Tunables;
  constants: Constants;
}

/**
 * Leaf type expected at a config path: a primitive, an array of numbers, or
 * an array of `[base, amp, freq, phase]` rows.
 */
type LeafSpec = "number" | "boolean" | "number[]" | "vec4[]";
/** Expected shape of a config subtree: nested groups with typed leaves. */
interface GroupSpec {
  [key: string]: LeafSpec | GroupSpec;
}

/** Expected shape of the whole file - mirrors {@link Config}. */
const CONFIG_SPEC: GroupSpec = {
  tunables: {
    timeBetweenPresets: "number",
    fastModeInterval: "number",
    blendDuration: "number",
    shuffle: "boolean",
    hardCutsEnabled: "boolean",
    hardCutLoudness: "number",
    hardCutHalflife: "number",
    meshGridX: "number",
    meshGridY: "number",
  },
  constants: {
    eel: {
      closefact: "number",
      maxLoop: "number",
      megabufBlock: "number",
      megabufMaxBlocks: "number",
      numQVars: "number",
      numTVars: "number",
    },
    preset: {
      maxCustomWaves: "number",
      maxCustomShapes: "number",
      defaultRating: "number",
    },
    audio: {
      waveSamples: "number",
      bassEdge: "number",
      midEdge: "number",
      avgTimeConstant: "number",
      attTimeConstant: "number",
    },
    warp: { coefficients: "vec4[]" },
    blur: {
      kernel: "number[]",
      minDistance: "number",
      edgeDarkenScale: "number",
    },
    waveform: { numSamples: "number" },
    motionVectors: { maxX: "number", maxY: "number" },
    borders: {
      vertsPerBorder: "number",
      darkenCenterHalfSize: "number",
      darkenCenterAlpha: "number",
    },
    noise: {
      size2D: "number",
      sizeLite: "number",
      size3D: "number",
      zoom2D: "number[]",
      zoom3D: "number[]",
      rangeZoomed: "number",
      rangePlain: "number",
    },
    hardCut: { decayConstant: "number" },
    layout: { floatsPerVert: "number", texFloatsPerVert: "number" },
  },
};

/** Collect every mismatch between `value` and `spec` into `errors`. */
function checkShape(
  value: unknown,
  spec: LeafSpec | GroupSpec,
  path: string,
  errors: string[],
): void {
  if (spec === "number" || spec === "boolean") {
    if (typeof value !== spec) errors.push(`${path}: expected ${spec}`);
    return;
  }
  if (spec === "number[]") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "number"))
      errors.push(`${path}: expected an array of numbers`);
    return;
  }
  if (spec === "vec4[]") {
    if (
      !Array.isArray(value) ||
      value.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 4 ||
          row.some((v) => typeof v !== "number"),
      )
    )
      errors.push(`${path}: expected an array of [base, amp, freq, phase]`);
    return;
  }
  if (typeof value !== "object" || value === null) {
    errors.push(`${path}: expected a mapping`);
    return;
  }
  for (const [key, sub] of Object.entries(spec))
    checkShape(
      (value as Record<string, unknown>)[key],
      sub,
      path ? `${path}.${key}` : key,
      errors,
    );
}

/**
 * Validate the parsed YAML against the expected {@link Config} shape.
 * Throws (listing every missing or mistyped path) rather than letting a
 * malformed `config.yaml` surface as a confusing failure at some use-site.
 */
export function validateConfig(value: unknown): Config {
  const errors: string[] = [];
  checkShape(value, CONFIG_SPEC, "", errors);
  if (errors.length > 0)
    throw new Error(`Invalid config.yaml:\n  ${errors.join("\n  ")}`);
  return value as Config;
}

const config = validateConfig(raw);

/** Tunable parameters (see {@link Tunables}). */
export const tunables: Tunables = config.tunables;

/** Engine constants (see {@link Constants}). */
export const constants: Constants = config.constants;

export default config;
