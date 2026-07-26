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

/** `["q1", … "q32"]`, built once so the hot paths never format a name. */
const Q_NAMES: readonly string[] = Array.from(
  { length: NUM_Q_VARS },
  (_, i) => `q${i + 1}`,
);
/** `["t1", … "t8"]`, built once. */
const T_NAMES: readonly string[] = Array.from(
  { length: NUM_T_VARS },
  (_, i) => `t${i + 1}`,
);

/**
 * The q/t slot indices of one {@link EelContext}, resolved once on first use.
 *
 * @remarks
 * `seedQ`/`seedT` run once per custom wave and once per *shape instance* every
 * frame; resolving 40 names each time (and formatting the name strings) was
 * pure overhead, since the indices never change for a given pool.
 */
class QtSlots {
  readonly q: Int32Array;
  readonly t: Int32Array;
  constructor(ctx: EelContext) {
    this.q = ctx.vars.indices(Q_NAMES);
    this.t = ctx.vars.indices(T_NAMES);
  }
}

function compileOrNull(ctx: EelContext, code: string): EelProgram | null {
  return code.trim().length > 0 ? ctx.compile(code) : null;
}

function seedQ(dst: EelContext, slots: QtSlots, q: Float64Array): void {
  const buf = dst.vars.buf;
  for (let i = 0; i < NUM_Q_VARS; i++) buf[slots.q[i]!] = q[i]!;
}
function seedT(dst: EelContext, slots: QtSlots, t: Float64Array): void {
  const buf = dst.vars.buf;
  for (let i = 0; i < NUM_T_VARS; i++) buf[slots.t[i]!] = t[i]!;
}
function captureT(src: EelContext, slots: QtSlots): Float64Array<ArrayBuffer> {
  const out = new Float64Array(NUM_T_VARS);
  const buf = src.vars.buf;
  for (let i = 0; i < NUM_T_VARS; i++) out[i] = buf[slots.t[i]!]!;
  return out;
}
function setInputs(ctx: EelContext, inputs: Record<string, number>): void {
  for (const [k, v] of Object.entries(inputs)) ctx.vars.set(k, v);
}

/**
 * Variables exchanged with a custom wave's `per_point` block, in slot order:
 * 0-2 are inputs only, 3-8 are seeded then read back.
 * {@link CompiledWave.runPerPoint} indexes these positionally.
 */
const PP_POINT_VARS = [
  "sample",
  "value1",
  "value2",
  "x",
  "y",
  "r",
  "g",
  "b",
  "a",
] as const;

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
  private slots: QtSlots;
  private ppSlots: QtSlots;
  // per_point inputs (0-5) and outputs (2-7); see PP_POINT_VARS
  private ppPointSlots: Int32Array;
  // reused per-point result: filled and consumed within one loop iteration
  private point: WavePointProps = { x: 0, y: 0, r: 0, g: 0, b: 0, a: 0 };

  constructor(
    public spec: CustomWave,
    globals: Globals,
  ) {
    this.ctx = new EelContext(globals);
    this.ppCtx = new EelContext(globals);
    this.init = compileOrNull(this.ctx, spec.initCode);
    this.perFrame = compileOrNull(this.ctx, spec.perFrameCode);
    this.perPoint = compileOrNull(this.ppCtx, spec.perPointCode);
    this.slots = new QtSlots(this.ctx);
    this.ppSlots = new QtSlots(this.ppCtx);
    this.ppPointSlots = this.ppCtx.vars.indices(PP_POINT_VARS);
  }

  /** Run this wave's init code once and snapshot its t-variables. */
  runInit(): void {
    this.init?.run();
    this.tAfterInit = captureT(this.ctx, this.slots);
  }

  /** Run per_frame; returns the base draw props and bridges q/t to per_point. */
  runPerFrame(
    mainQ: Float64Array,
    inputs: Record<string, number>,
  ): WaveBaseProps {
    const s = this.spec;
    const v = this.ctx.vars;
    seedQ(this.ctx, this.slots, mainQ);
    seedT(this.ctx, this.slots, this.tAfterInit);
    v.set("r", s.r);
    v.set("g", s.g);
    v.set("b", s.b);
    v.set("a", s.a);
    v.set("samples", s.samples);
    setInputs(this.ctx, inputs);
    this.perFrame?.run();

    // bridge q (constant) + t to per_point context
    seedQ(this.ppCtx, this.ppSlots, mainQ);
    const src = v.buf;
    const dst = this.ppCtx.vars.buf;
    for (let i = 0; i < NUM_T_VARS; i++)
      dst[this.ppSlots.t[i]!] = src[this.slots.t[i]!]!;
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

  /**
   * Run per_point for one sample; sample/value1/value2 in, position+colour out.
   *
   * @remarks
   * Runs up to 512 times per wave per frame, so it touches the variable pool by
   * cached slot index and returns a **reused** object. Read the fields (or copy
   * them) before the next call - the caller in `CustomWaves` writes them
   * straight into its vertex buffer.
   *
   * @param sample - Normalised position along the wave, 0..1.
   * @param value1 - First channel's sample at this point.
   * @param value2 - Second channel's sample at this point.
   * @param base - The per-frame base properties from {@link runPerFrame}.
   * @returns The point's position and colour (reused between calls).
   */
  runPerPoint(
    sample: number,
    value1: number,
    value2: number,
    base: WaveBaseProps,
  ): WavePointProps {
    const s = this.ppPointSlots;
    const buf = this.ppCtx.vars.buf;
    buf[s[0]!] = sample;
    buf[s[1]!] = value1;
    buf[s[2]!] = value2;
    buf[s[3]!] = 0.5 + value1;
    buf[s[4]!] = 0.5 + value2;
    buf[s[5]!] = base.r;
    buf[s[6]!] = base.g;
    buf[s[7]!] = base.b;
    buf[s[8]!] = base.a;

    this.perPoint?.run();

    // re-read: per_point code touching a new variable grows (and reassigns) buf
    const after = this.ppCtx.vars.buf;
    const out = this.point;
    out.x = after[s[3]!]!;
    out.y = after[s[4]!]!;
    out.r = after[s[5]!]!;
    out.g = after[s[6]!]!;
    out.b = after[s[7]!]!;
    out.a = after[s[8]!]!;
    return out;
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
  private slots: QtSlots;

  constructor(
    public spec: CustomShape,
    globals: Globals,
  ) {
    this.ctx = new EelContext(globals);
    this.init = compileOrNull(this.ctx, spec.initCode);
    this.perFrame = compileOrNull(this.ctx, spec.perFrameCode);
    this.slots = new QtSlots(this.ctx);
  }

  /** Run this shape's init code once and snapshot its t-variables. */
  runInit(): void {
    this.init?.run();
    this.tAfterInit = captureT(this.ctx, this.slots);
  }

  /** Run per_frame for one instance; returns the resolved draw properties. */
  runPerFrame(
    instance: number,
    mainQ: Float64Array,
    inputs: Record<string, number>,
  ): ShapeDrawProps {
    const s = this.spec;
    const v = this.ctx.vars;
    seedQ(this.ctx, this.slots, mainQ);
    seedT(this.ctx, this.slots, this.tAfterInit);
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
  private slots: QtSlots;
  private ppSlots: QtSlots;
  // The .milk scalar baseline, flattened to (slot, value) pairs once at compile
  // time - runPerFrame re-seeds all of it every frame, and walking
  // Object.entries of an ~80-key object per frame was pure overhead.
  private baselineSlots: Int32Array;
  private baselineValues: Float64Array;
  // reused snapshot returned by mainQ()
  private qSnapshot = new Float64Array(NUM_Q_VARS);

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

    this.slots = new QtSlots(this.ctx);
    this.ppSlots = new QtSlots(this.ppCtx);

    const entries = Object.entries(state.vals);
    this.baselineSlots = this.ctx.vars.indices(entries.map(([k]) => k));
    this.baselineValues = Float64Array.from(entries, ([, val]) => val);

    this.waves = state.waves
      .filter((w) => w.enabled)
      .map((w) => new CompiledWave(w, globals));
    this.shapes = state.shapes
      .filter((s) => s.enabled)
      .map((s) => new CompiledShape(s, globals));
  }

  /** Seed the baseline scalar values (from the .milk file) into the var bag. */
  loadBaselineVars(extra: Record<string, number> = {}): void {
    this.seedBaseline();
    const v = this.ctx.vars;
    for (const [k, val] of Object.entries(extra)) v.set(k.toLowerCase(), val);
  }

  /** Write the .milk scalar baseline into the per_frame pool by slot. */
  private seedBaseline(): void {
    const buf = this.ctx.vars.buf;
    const slots = this.baselineSlots;
    const values = this.baselineValues;
    for (let i = 0; i < slots.length; i++) buf[slots[i]!] = values[i]!;
  }

  /** Run per_frame_init once and capture q1..q32 for later frames. */
  runInit(inputs: Record<string, number> = {}): void {
    this.loadBaselineVars(inputs);
    this.perFrameInit?.run();
    const buf = this.ctx.vars.buf;
    for (let i = 0; i < NUM_Q_VARS; i++)
      this.qAfterInit[i] = buf[this.slots.q[i]!]!;
    for (const w of this.waves) w.runInit();
    for (const s of this.shapes) s.runInit();
    this.initialised = true;
  }

  /**
   * Snapshot the main per_frame q1..q32 (input to custom waves/shapes).
   *
   * @remarks
   * Returns a **reused** array, refreshed on each call - the per-frame callers
   * (custom shapes and waves) read it within the same frame. Copy it if you
   * need it to outlive the next call.
   *
   * @returns q1..q32 as of the last `per_frame` run.
   */
  mainQ(): Float64Array {
    const q = this.qSnapshot;
    const buf = this.ctx.vars.buf;
    for (let i = 0; i < NUM_Q_VARS; i++) q[i] = buf[this.slots.q[i]!]!;
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
    this.seedBaseline();
    // Re-seed q1..q32 from the post-init snapshot each frame (MilkDrop behaviour).
    const buf = v.buf;
    for (let i = 0; i < NUM_Q_VARS; i++)
      buf[this.slots.q[i]!] = this.qAfterInit[i]!;
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
    const src = this.ctx.vars.buf;
    const dst = this.ppCtx.vars.buf;
    for (let i = 0; i < NUM_Q_VARS; i++)
      dst[this.ppSlots.q[i]!] = src[this.slots.q[i]!]!;
  }

  /** Run per_pixel once for a single grid vertex (x,y,rad,ang preset by host). */
  runPerPixel(): void {
    this.perPixel?.run();
  }
}
