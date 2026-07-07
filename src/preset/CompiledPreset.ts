/**
 * Compiles a parsed PresetState's equation blocks into runnable EEL programs.
 *
 * The main preset blocks (per_frame_init / per_frame / per_pixel) share one
 * EelContext so variables flow between them (q1..q32, user vars). Each enabled
 * custom wave/shape gets its own context(s). Full frame orchestration - loading
 * var_pf_* inputs, the q/t handoff, running per_pixel per grid vertex - lives in
 * the renderer; this class is the compile-and-run substrate.
 */

import { EelContext, EelProgram, Globals } from "../eel/index.ts";
import type { CustomShape, CustomWave, PresetState } from "./types.ts";
import { constants } from "../config.ts";

const NUM_Q_VARS = constants.eel.numQVars;
const NUM_T_VARS = constants.eel.numTVars;

function compileOrNull(ctx: EelContext, code: string): EelProgram | null {
  return code.trim().length > 0 ? ctx.compile(code) : null;
}

function seedQ(dst: EelContext, q: Float64Array): void {
  for (let i = 0; i < NUM_Q_VARS; i++) dst.vars.set(`q${i + 1}`, q[i]!);
}
function seedT(dst: EelContext, t: Float64Array): void {
  for (let i = 0; i < NUM_T_VARS; i++) dst.vars.set(`t${i + 1}`, t[i]!);
}
function captureT(src: EelContext): Float64Array<ArrayBuffer> {
  const t = new Float64Array(NUM_T_VARS);
  for (let i = 0; i < NUM_T_VARS; i++) t[i] = src.vars.get(`t${i + 1}`);
  return t;
}
function setInputs(ctx: EelContext, inputs: Record<string, number>): void {
  for (const [k, v] of Object.entries(inputs)) ctx.vars.set(k, v);
}

/** Per-frame wave properties resolved before iterating its points. */
export interface WaveBaseProps {
  samples: number;
  r: number;
  g: number;
  b: number;
  a: number;
  spectrum: boolean;
  useDots: boolean;
  thick: boolean;
  additive: boolean;
  smoothing: number;
  scaling: number;
  sep: number;
}
/** Per-point wave outputs (position + colour) after `per_point` runs. */
export interface WavePointProps {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A compiled custom wave. `init` + `per_frame` share one context; `per_point`
 * has its own, with q-vars and t-vars bridged across each frame.
 */
export class CompiledWave {
  ctx: EelContext;
  ppCtx: EelContext;
  init: EelProgram | null;
  perFrame: EelProgram | null;
  perPoint: EelProgram | null;
  private tAfterInit = new Float64Array(NUM_T_VARS);

  constructor(
    public spec: CustomWave,
    globals: Globals,
  ) {
    this.ctx = new EelContext(globals);
    this.ppCtx = new EelContext(globals);
    this.init = compileOrNull(this.ctx, spec.initCode);
    this.perFrame = compileOrNull(this.ctx, spec.perFrameCode);
    this.perPoint = compileOrNull(this.ppCtx, spec.perPointCode);
  }

  /** Run this wave's init code once and snapshot its t-variables. */
  runInit(): void {
    this.init?.run();
    this.tAfterInit = captureT(this.ctx);
  }

  /** Run per_frame; returns the base draw props and bridges q/t to per_point. */
  runPerFrame(
    mainQ: Float64Array,
    inputs: Record<string, number>,
  ): WaveBaseProps {
    const s = this.spec;
    const v = this.ctx.vars;
    seedQ(this.ctx, mainQ);
    seedT(this.ctx, this.tAfterInit);
    v.set("r", s.r);
    v.set("g", s.g);
    v.set("b", s.b);
    v.set("a", s.a);
    v.set("samples", s.samples);
    setInputs(this.ctx, inputs);
    this.perFrame?.run();

    // bridge q (constant) + t to per_point context
    seedQ(this.ppCtx, mainQ);
    for (let i = 0; i < NUM_T_VARS; i++)
      this.ppCtx.vars.set(`t${i + 1}`, v.get(`t${i + 1}`));
    setInputs(this.ppCtx, inputs);

    return {
      samples: Math.min(512, Math.round(v.get("samples"))),
      r: v.get("r"),
      g: v.get("g"),
      b: v.get("b"),
      a: v.get("a"),
      spectrum: s.spectrum,
      useDots: s.useDots,
      thick: s.drawThick,
      additive: s.additive,
      smoothing: s.smoothing,
      scaling: s.scaling,
      sep: s.sep,
    };
  }

  /** Run per_point for one sample; sample/value1/value2 in, position+colour out. */
  runPerPoint(
    sample: number,
    value1: number,
    value2: number,
    base: WaveBaseProps,
  ): WavePointProps {
    const v = this.ppCtx.vars;
    v.set("sample", sample);
    v.set("value1", value1);
    v.set("value2", value2);
    v.set("x", 0.5 + value1);
    v.set("y", 0.5 + value2);
    v.set("r", base.r);
    v.set("g", base.g);
    v.set("b", base.b);
    v.set("a", base.a);
    this.perPoint?.run();
    return {
      x: v.get("x"),
      y: v.get("y"),
      r: v.get("r"),
      g: v.get("g"),
      b: v.get("b"),
      a: v.get("a"),
    };
  }
}

/** Resolved per-instance shape properties produced by `per_frame`. */
export interface ShapeDrawProps {
  x: number;
  y: number;
  rad: number;
  ang: number;
  sides: number;
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
  additive: boolean;
  thick: boolean;
  textured: boolean;
  texAng: number;
  texZoom: number;
}

/** A compiled custom shape. `init` + `per_frame` share a single context. */
export class CompiledShape {
  ctx: EelContext;
  init: EelProgram | null;
  perFrame: EelProgram | null;
  private tAfterInit = new Float64Array(NUM_T_VARS);

  constructor(
    public spec: CustomShape,
    globals: Globals,
  ) {
    this.ctx = new EelContext(globals);
    this.init = compileOrNull(this.ctx, spec.initCode);
    this.perFrame = compileOrNull(this.ctx, spec.perFrameCode);
  }

  /** Run this shape's init code once and snapshot its t-variables. */
  runInit(): void {
    this.init?.run();
    this.tAfterInit = captureT(this.ctx);
  }

  /** Run per_frame for one instance; returns the resolved draw properties. */
  runPerFrame(
    instance: number,
    mainQ: Float64Array,
    inputs: Record<string, number>,
  ): ShapeDrawProps {
    const s = this.spec;
    const v = this.ctx.vars;
    seedQ(this.ctx, mainQ);
    seedT(this.ctx, this.tAfterInit);
    v.set("x", s.x);
    v.set("y", s.y);
    v.set("rad", s.rad);
    v.set("ang", s.ang);
    v.set("tex_zoom", s.texZoom);
    v.set("tex_ang", s.texAng);
    v.set("sides", s.sides);
    v.set("additive", s.additive ? 1 : 0);
    v.set("textured", s.textured ? 1 : 0);
    v.set("instances", s.instances);
    v.set("instance", instance);
    v.set("thick", s.thickOutline ? 1 : 0);
    v.set("r", s.r);
    v.set("g", s.g);
    v.set("b", s.b);
    v.set("a", s.a);
    v.set("r2", s.r2);
    v.set("g2", s.g2);
    v.set("b2", s.b2);
    v.set("a2", s.a2);
    v.set("border_r", s.borderR);
    v.set("border_g", s.borderG);
    v.set("border_b", s.borderB);
    v.set("border_a", s.borderA);
    setInputs(this.ctx, inputs);
    this.perFrame?.run();

    return {
      x: v.get("x"),
      y: v.get("y"),
      rad: v.get("rad"),
      ang: v.get("ang"),
      sides: Math.max(3, Math.min(100, Math.round(v.get("sides")))),
      r: v.get("r"),
      g: v.get("g"),
      b: v.get("b"),
      a: v.get("a"),
      r2: v.get("r2"),
      g2: v.get("g2"),
      b2: v.get("b2"),
      a2: v.get("a2"),
      borderR: v.get("border_r"),
      borderG: v.get("border_g"),
      borderB: v.get("border_b"),
      borderA: v.get("border_a"),
      additive: v.get("additive") > 0.5,
      thick: v.get("thick") > 0.5,
      textured: v.get("textured") > 0.5,
      texAng: v.get("tex_ang"),
      texZoom: v.get("tex_zoom"),
    };
  }
}

/**
 * A preset compiled and ready to drive a frame: the main equation programs,
 * the compiled custom waves/shapes, and the q/t handoff bookkeeping.
 */
export class CompiledPreset {
  readonly state: PresetState;
  readonly globals: Globals;
  /** per_frame_init + per_frame share this context. */
  readonly ctx: EelContext;
  /** per_pixel has its own context (only q-vars + motion vars bridge in). */
  readonly ppCtx: EelContext;

  readonly perFrameInit: EelProgram | null;
  readonly perFrame: EelProgram | null;
  readonly perPixel: EelProgram | null;

  readonly waves: CompiledWave[];
  readonly shapes: CompiledShape[];

  /** q1..q32 captured at the end of per_frame_init, used to seed each frame. */
  private qAfterInit = new Float64Array(NUM_Q_VARS);
  private initialised = false;

  constructor(state: PresetState, globals: Globals = new Globals()) {
    this.state = state;
    this.globals = globals;
    this.ctx = new EelContext(globals);
    this.ppCtx = new EelContext(globals);

    // Compile errors are surfaced per-block so one bad block doesn't sink the
    // whole preset; the renderer can decide how to fall back.
    this.perFrameInit = compileOrNull(this.ctx, state.perFrameInitCode);
    this.perFrame = compileOrNull(this.ctx, state.perFrameCode);
    this.perPixel = compileOrNull(this.ppCtx, state.perPixelCode);

    this.waves = state.waves
      .filter((w) => w.enabled)
      .map((w) => new CompiledWave(w, globals));
    this.shapes = state.shapes
      .filter((s) => s.enabled)
      .map((s) => new CompiledShape(s, globals));
  }

  /** Seed the baseline scalar values (from the .milk file) into the var bag. */
  loadBaselineVars(extra: Record<string, number> = {}): void {
    const v = this.ctx.vars;
    for (const [k, val] of Object.entries(this.state.vals)) v.set(k, val);
    for (const [k, val] of Object.entries(extra)) v.set(k.toLowerCase(), val);
  }

  /** Run per_frame_init once and capture q1..q32 for later frames. */
  runInit(inputs: Record<string, number> = {}): void {
    this.loadBaselineVars(inputs);
    this.perFrameInit?.run();
    for (let i = 0; i < NUM_Q_VARS; i++) {
      this.qAfterInit[i] = this.ctx.vars.get(`q${i + 1}`);
    }
    for (const w of this.waves) w.runInit();
    for (const s of this.shapes) s.runInit();
    this.initialised = true;
  }

  /** Snapshot the main per_frame q1..q32 (input to custom waves/shapes). */
  mainQ(): Float64Array {
    const q = new Float64Array(NUM_Q_VARS);
    for (let i = 0; i < NUM_Q_VARS; i++) q[i] = this.ctx.vars.get(`q${i + 1}`);
    return q;
  }

  /**
   * Run per_frame for one frame. `inputs` are the read-only audio/time values
   * (bass, treb, time, frame, ...) the host supplies before each frame.
   * Returns the EelContext so the caller can read back zoom/rot/q-vars/etc.
   */
  runPerFrame(inputs: Record<string, number>): EelContext {
    if (!this.initialised) this.runInit(inputs);
    const v = this.ctx.vars;
    // Re-seed scalar baseline each frame (mirrors LoadPerFrameEvallibVars in C:
    // zoom/rot/decay/wave_r/etc. are reset to .milk values before per_frame so
    // per_frame always starts from the file baseline, not its own previous output).
    for (const [k, val] of Object.entries(this.state.vals)) v.set(k, val);
    // Re-seed q1..q32 from the post-init snapshot each frame (MilkDrop behaviour).
    for (let i = 0; i < NUM_Q_VARS; i++)
      v.set(`q${i + 1}`, this.qAfterInit[i]!);
    for (const [k, val] of Object.entries(inputs)) v.set(k.toLowerCase(), val);
    this.perFrame?.run();
    return this.ctx;
  }

  /**
   * Bridge per_frame outputs into the per_pixel context: copy q1..q32 (constant
   * for the frame) and the motion vars (per-vertex starting values). Call once
   * per frame after runPerFrame, before iterating grid vertices.
   */
  prepPerPixelFrame(): void {
    const pf = this.ctx.vars;
    const pp = this.ppCtx.vars;
    for (let i = 0; i < NUM_Q_VARS; i++)
      pp.set(`q${i + 1}`, pf.get(`q${i + 1}`));
  }

  /** Run per_pixel once for a single grid vertex (x,y,rad,ang preset by host). */
  runPerPixel(): void {
    this.perPixel?.run();
  }
}
