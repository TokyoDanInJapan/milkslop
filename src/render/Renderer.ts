/**
 * Renders one preset's frame into an output texture (the Visualizer blits or
 * crossfades that to the screen). Mirrors the order in CPlugin::RenderFrame
 * (milkdropfs.cpp:752):
 *
 *   per_frame equations → motion vectors (into the pre-warp source)
 *   → warp blit (warp shader or decay feedback)
 *   → blur passes → custom shapes → custom waves → basic waveform → borders
 *   → composite (comp shader, or no-shader gamma/echo/invert) → swap buffers
 *
 * A preset may supply warp and/or composite shaders; absent (or on a compile
 * failure) the corresponding no-shader path is used.
 */

import { computeAspect, type Aspect, type WarpParams } from "./warp.ts";
import { createFullscreenQuad } from "./gl.ts";
import { FrameBuffers } from "./FrameBuffers.ts";
import { WarpMesh } from "./WarpMesh.ts";
import { Waveform } from "./Waveform.ts";
import { Borders } from "./Borders.ts";
import { MotionVectors } from "./MotionVectors.ts";
import { Composite } from "./Composite.ts";
import { CustomShapes } from "./CustomShapes.ts";
import { CustomWaves } from "./CustomWaves.ts";
import { BlurPasses } from "./BlurPasses.ts";
import { RenderTarget } from "./RenderTarget.ts";
import { SoundAnalyzer } from "../audio/SoundAnalyzer.ts";
import { createNoiseTextures, type NoiseTextures } from "./NoiseTextures.ts";
import { transpile } from "../shader/transpile.ts";
import { buildFragmentShader, userSamplersOf } from "../shader/environment.ts";
import { ShaderPass, type ShaderFrameState } from "../shader/ShaderPass.ts";
import type { CompiledPreset } from "../preset/CompiledPreset.ts";

/** A preset shader that failed to transpile/compile, with the fallback engaged. */
export interface ShaderCompileError {
  /** which shader stage failed */
  stage: "warp" | "comp";
  /** the underlying transpile/compile error message */
  message: string;
}

/** One frame of analysed audio supplied to {@link Renderer.frame}. */
export interface AudioFrame {
  /** averaged mono spectrum (0..1) */
  spectrum: Float32Array;
  /** mono waveform (-1..1) */
  waveform: Float32Array;
  /** per-channel waveform (-1..1) for custom waves */
  waveL: Float32Array;
  waveR: Float32Array;
  /** per-channel spectrum (0..1) for custom waves */
  specL: Float32Array;
  specR: Float32Array;
}

/** Renders one preset's frame into an output texture (see the module overview). */
export class Renderer {
  private gl: WebGL2RenderingContext;
  private fb: FrameBuffers;
  private mesh: WarpMesh;
  private wave: Waveform;
  private borders: Borders;
  private motionVectors: MotionVectors;
  private composite: Composite;
  private shapes: CustomShapes;
  private customWaves: CustomWaves;
  private blur: BlurPasses;
  private quad: WebGLVertexArrayObject;
  private output: RenderTarget;
  private analyzer = new SoundAnalyzer();

  private noise: NoiseTextures;
  private userTextures: Map<string, WebGLTexture>;
  private whiteTex: WebGLTexture;
  private preset: CompiledPreset | null = null;
  private _shaderErrors: ShaderCompileError[] = [];
  private compShader: ShaderPass | null = null;
  // user (image) samplers declared by the current preset's comp / warp shaders
  private compUserSamplers: string[] = [];
  private warpUserSamplers: string[] = [];
  private randPreset: [number, number, number, number] = [0, 0, 0, 0];
  // per-preset random phase offsets for the animated hue_shader corner colours
  private hueOffsets: [number, number, number, number] = [0, 0, 0, 0];
  private aspect: Aspect;
  private texW: number;
  private texH: number;
  private frameNo = 0;
  private time = 0;
  private presetStart = 0;
  private presetDuration = 30;

  /**
   * Build the full render pipeline at `texW`×`texH` internal resolution.
   *
   * @param gl - The WebGL2 context to render with.
   * @param texW - Internal render-target width in pixels.
   * @param texH - Internal render-target height in pixels.
   * @param userTextures - Preloaded image samplers keyed by name, for presets
   *   that reference user textures.
   */
  constructor(
    gl: WebGL2RenderingContext,
    texW: number,
    texH: number,
    userTextures: Map<string, WebGLTexture> = new Map(),
  ) {
    this.gl = gl;
    this.userTextures = userTextures;
    this.texW = texW;
    this.texH = texH;
    this.aspect = computeAspect(texW, texH);
    this.fb = new FrameBuffers(gl, texW, texH);
    this.fb.clear();
    this.mesh = new WarpMesh(gl);
    this.mesh.rebuild(this.aspect);
    this.wave = new Waveform(gl);
    this.borders = new Borders(gl);
    this.motionVectors = new MotionVectors(gl);
    this.composite = new Composite(gl);
    this.shapes = new CustomShapes(gl);
    this.customWaves = new CustomWaves(gl);
    this.blur = new BlurPasses(gl, texW, texH);
    this.quad = createFullscreenQuad(gl);
    this.output = new RenderTarget(gl, texW, texH);
    this.noise = createNoiseTextures(gl);

    // neutral 1×1 white fallback for declared-but-unprovided user samplers
    this.whiteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** The composited frame (the Visualizer blits/crossfades this to screen). */
  get outputTexture(): WebGLTexture {
    return this.output.tex;
  }

  /**
   * Shader stages of the current preset that failed to compile (and so fell back
   * to a no-shader path). Empty when the preset's shaders all compiled. Refreshed
   * by every {@link loadPreset} call.
   */
  get shaderErrors(): readonly ShaderCompileError[] {
    return this._shaderErrors;
  }

  /**
   * Switch to a new compiled preset: compile its shaders, reset random/hue
   * state, refresh {@link shaderErrors}, and run its `per_frame_init` code.
   *
   * @param preset - The compiled preset to render.
   * @param duration - Intended on-screen lifetime in seconds (drives `progress`).
   */
  loadPreset(preset: CompiledPreset, duration = 30): void {
    this.preset = preset;
    this._shaderErrors = [];
    this.frameNo = 0;
    this.presetStart = this.time;
    this.presetDuration = duration;
    this.randPreset = [
      Math.random(),
      Math.random(),
      Math.random(),
      Math.random(),
    ];
    // Per-preset random phase offsets for the animated hue_shader corner colours,
    // 1:1 with MilkDrop 2 (plugin.cpp:7410-7413: m_fRandStart[i] =
    // (warand() % {64841,53751,42661,31571}) * 0.01). [0] is generated for parity
    // but unused by the corner formulas (MilkDrop seeds corners from [3],[1],[2]).
    this.hueOffsets = [
      Math.floor(Math.random() * 64841) * 0.01,
      Math.floor(Math.random() * 53751) * 0.01,
      Math.floor(Math.random() * 42661) * 0.01,
      Math.floor(Math.random() * 31571) * 0.01,
    ];

    // build the composite shader if the preset uses one (else no-shader path)
    this.compShader = null;
    this.compUserSamplers = [];
    if (preset.state.compPSVersion > 0 && preset.state.compShader.trim()) {
      try {
        const r = transpile(preset.state.compShader);
        this.compShader = new ShaderPass(
          this.gl,
          buildFragmentShader(r, "comp"),
          this.quad,
        );
        this.compUserSamplers = userSamplersOf(r.samplers);
      } catch (err) {
        console.warn(
          "comp shader transpile/compile failed; using no-shader path:",
          err,
        );
        this.compShader = null;
        this._shaderErrors.push({ stage: "comp", message: String(err) });
      }
    }

    // build the warp shader if the preset uses one (else no-shader warp blit)
    this.mesh.setWarpShader(null);
    this.warpUserSamplers = [];
    if (preset.state.warpPSVersion > 0 && preset.state.warpShader.trim()) {
      try {
        const r = transpile(preset.state.warpShader);
        this.mesh.setWarpShader(buildFragmentShader(r, "warp"));
        this.warpUserSamplers = userSamplersOf(r.samplers);
      } catch (err) {
        console.warn(
          "warp shader transpile/compile failed; using no-shader warp:",
          err,
        );
        this.mesh.setWarpShader(null);
        this._shaderErrors.push({ stage: "warp", message: String(err) });
      }
    }

    preset.runInit(this.baseInputs(0));
  }

  /** Resize the internal render targets and rebuild the warp mesh; no-op if unchanged. */
  resize(texW: number, texH: number): void {
    if (texW === this.texW && texH === this.texH) return;
    this.texW = texW;
    this.texH = texH;
    this.aspect = computeAspect(texW, texH);
    this.fb.resize(texW, texH);
    this.mesh.rebuild(this.aspect);
    this.blur.resize(texW, texH);
    this.output.resize(texW, texH);
  }

  private baseInputs(bands = 0): Record<string, number> {
    const elapsed = this.time - this.presetStart;
    return {
      time: elapsed,
      frame: this.frameNo,
      fps: 60,
      progress:
        this.presetDuration > 0
          ? Math.min(1, elapsed / this.presetDuration)
          : 0,
      meshx: this.mesh.gridX,
      meshy: this.mesh.gridY,
      pixelsx: this.texW,
      pixelsy: this.texH,
      aspectx: this.aspect.invAspectX,
      aspecty: this.aspect.invAspectY,
      bass: bands,
      mid: bands,
      treb: bands,
      bass_att: bands,
      mid_att: bands,
      treb_att: bands,
    };
  }

  /** Render one frame. `dt` in seconds. */
  frame(audio: AudioFrame, dt: number): void {
    const gl = this.gl;
    this.time += dt;
    if (!this.preset) {
      this.output.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    const b = this.analyzer.update(audio.spectrum, dt || 1 / 60);
    const inputs: Record<string, number> = {
      ...this.baseInputs(),
      bass: b.bass,
      mid: b.mid,
      treb: b.treb,
      bass_att: b.bassAtt,
      mid_att: b.midAtt,
      treb_att: b.trebAtt,
    };

    // 1. per_frame equations
    const ctx = this.preset.runPerFrame(inputs);
    const v = ctx.vars;

    // mirror the read-only inputs into the per_pixel context, then bridge q-vars
    const pp = this.preset.ppCtx.vars;
    for (const [k, val] of Object.entries(inputs)) pp.set(k, val);
    this.preset.prepPerPixelFrame();

    const motion: WarpParams = {
      zoom: v.get("zoom"),
      zoomExp: v.get("zoomexp"),
      rot: v.get("rot"),
      warp: v.get("warp"),
      cx: v.get("cx"),
      cy: v.get("cy"),
      dx: v.get("dx"),
      dy: v.get("dy"),
      sx: v.get("sx"),
      sy: v.get("sy"),
    };
    const decay = clamp(v.get("decay"), 0, 1);
    const mainQ = this.preset.mainQ();

    // motion vectors into the previous frame (the original's
    // DrawMotionVectors → VS0), traced through last frame's warp UVs so the
    // warp below picks them up immediately
    if (v.get("mv_a") >= 0.001) {
      this.fb.bindSource();
      this.motionVectors.render(
        {
          mvX: v.get("mv_x"),
          mvY: v.get("mv_y"),
          mvDx: v.get("mv_dx"),
          mvDy: v.get("mv_dy"),
          mvL: v.get("mv_l"),
          r: clamp(v.get("mv_r"), 0, 1),
          g: clamp(v.get("mv_g"), 0, 1),
          b: clamp(v.get("mv_b"), 0, 1),
          a: clamp(v.get("mv_a"), 0, 1),
        },
        this.mesh.gridX,
        this.mesh.gridY,
        this.mesh.vertexData,
        this.texW,
      );
    }

    // 2. warp blit: sample previous frame → write to target. A warp shader (if
    //    present) samples the previous frame + its one-frame-old blur textures.
    this.fb.bindTarget();
    const warpState = this.mesh.hasWarpShader
      ? this.makeShaderState(
          this.fb.sourceTexture,
          b,
          mainQ,
          decay,
          this.warpUserSamplers,
        )
      : undefined;
    this.mesh.render(
      this.preset,
      motion,
      {
        time: this.time - this.presetStart,
        warpAnimSpeed: this.preset.state.vals.warp_anim_speed ?? 1,
        warpScale: this.preset.state.vals.warp_scale ?? 1,
        texSizeX: this.texW,
        texSizeY: this.texH,
      },
      this.aspect,
      this.fb.sourceTexture,
      decay,
      warpState,
    );

    // 3. blur passes from the warped frame (before shapes/waves), so comp/warp
    //    shaders can sample GetBlur1/2/3.
    this.blur.generate(this.fb.targetTexture, {
      mins: [v.get("blur1_min"), v.get("blur2_min"), v.get("blur3_min")],
      maxs: [v.get("blur1_max"), v.get("blur2_max"), v.get("blur3_max")],
      edgeDarken: clamp(v.get("blur1_edge_darken"), 0, 1),
    });
    this.fb.bindTarget();

    // 4. custom shapes (first, so waves draw over them), then custom waves
    this.shapes.render(
      this.preset,
      mainQ,
      inputs,
      this.aspect,
      this.texW,
      this.texH,
      this.fb.sourceTexture, // textured shapes sample the previous frame (VS0)
    );
    this.customWaves.render(
      this.preset,
      mainQ,
      inputs,
      {
        waveL: audio.waveL,
        waveR: audio.waveR,
        specL: audio.specL,
        specR: audio.specR,
      },
      this.preset.state.vals.wave_scale ?? 1,
      this.aspect,
      this.texW,
      this.texH,
    );

    // 4. basic waveform overlay (into the same target) - full DrawWave port
    this.wave.render(
      audio.waveL,
      audio.waveR,
      {
        mode: v.get("wave_mode"),
        alpha: v.get("wave_a"),
        mystery: v.get("wave_mystery"),
        x: v.get("wave_x"),
        y: v.get("wave_y"),
        r: v.get("wave_r"),
        g: v.get("wave_g"),
        b: v.get("wave_b"),
        scale: this.preset.state.vals.wave_scale ?? 1,
        modByVolume:
          (this.preset.state.vals.wave_mod_alpha_by_volume ?? 0) > 0.5,
        modAlphaStart: this.preset.state.vals.wave_mod_alpha_start ?? 0.75,
        modAlphaEnd: this.preset.state.vals.wave_mod_alpha_end ?? 0.95,
        vol: (inputs.bass! + inputs.mid! + inputs.treb!) / 3,
        treb: inputs.treb!,
        time: this.time,
        blending: false,
        brighten: (v.get("wave_brighten") ?? 0) > 0.5,
        additive: (v.get("wave_additive") ?? 0) > 0.5,
        dots: (v.get("wave_usedots") ?? 0) > 0.5,
        thick: (v.get("wave_thick") ?? 0) > 0.5,
      },
      this.aspect,
      this.texW,
      this.texH,
    );

    // darken-center fan + borders (outer then inner) into the same target -
    // the tail of DrawSprites in the original, so they feed back through the warp
    if ((this.preset.state.vals.darken_center ?? 0) > 0.5)
      this.borders.renderDarkenCenter(this.aspect.aspectY);
    this.borders.render({
      obSize: v.get("ob_size"),
      obR: clamp(v.get("ob_r"), 0, 1),
      obG: clamp(v.get("ob_g"), 0, 1),
      obB: clamp(v.get("ob_b"), 0, 1),
      obA: clamp(v.get("ob_a"), 0, 1),
      ibSize: v.get("ib_size"),
      ibR: clamp(v.get("ib_r"), 0, 1),
      ibG: clamp(v.get("ib_g"), 0, 1),
      ibB: clamp(v.get("ib_b"), 0, 1),
      ibA: clamp(v.get("ib_a"), 0, 1),
    });

    // 5. composite into the output texture - shader path if the preset has one
    this.output.bind();
    if (this.compShader) {
      this.compShader.bindUniforms(
        this.makeShaderState(
          this.fb.targetTexture,
          b,
          mainQ,
          decay,
          this.compUserSamplers,
        ),
      );
      this.compShader.draw();
    } else {
      this.composite.render(this.fb.targetTexture, {
        gamma: clamp(v.get("gamma"), 0, 8),
        echoZoom: v.get("echo_zoom"),
        echoAlpha: clamp(v.get("echo_alpha"), 0, 1),
        echoOrient: Math.round(v.get("echo_orient")) & 3,
        brighten: (v.get("brighten") ?? 0) > 0.5,
        darken: (v.get("darken") ?? 0) > 0.5,
        solarize: (v.get("solarize") ?? 0) > 0.5,
        invert: (v.get("invert") ?? 0) > 0.5,
      });
    }

    // 5. swap feedback buffers
    this.fb.swap();
    this.frameNo++;
  }

  private makeShaderState(
    mainTex: WebGLTexture,
    b: {
      bass: number;
      mid: number;
      treb: number;
      bassAtt: number;
      midAtt: number;
      trebAtt: number;
    },
    q: Float64Array,
    decay: number,
    userSamplers: string[] = [],
  ): ShaderFrameState {
    const elapsed = this.time - this.presetStart;
    return {
      time: elapsed,
      hueCorners: this.hueCorners(elapsed),
      fps: 60,
      frame: this.frameNo,
      progress:
        this.presetDuration > 0
          ? Math.min(1, elapsed / this.presetDuration)
          : 0,
      bass: b.bass,
      mid: b.mid,
      treb: b.treb,
      bassAtt: b.bassAtt,
      midAtt: b.midAtt,
      trebAtt: b.trebAtt,
      texW: this.texW,
      texH: this.texH,
      aspectX: this.aspect.invAspectX,
      aspectY: this.aspect.invAspectY,
      decay,
      randFrame: [Math.random(), Math.random(), Math.random(), Math.random()],
      randPreset: this.randPreset,
      q,
      mainTex,
      blur1: this.blur.levels[0]!.tex,
      blur2: this.blur.levels[1]!.tex,
      blur3: this.blur.levels[2]!.tex,
      noise: this.noise,
      userSamplers,
      userTextures: this.userTextures,
      whiteTex: this.whiteTex,
    };
  }

  /**
   * The four animated corner colours for the composite `hue_shader`, 1:1 with
   * MilkDrop 2 (`milkdropfs.cpp:4129-4131`, the `shade[i]` per-frame calc): each
   * corner is a triple of slow sinusoids - phase-seeded by the per-preset {@link hueOffsets}
   * - normalised by its max channel then lifted into `[0.5, 1]`. Returned flat as
   * four RGB triples (length 12) for the `hue_shader_corners[4]` uniform; the comp
   * shader bilinearly interpolates them across the screen.
   *
   * @param time - Seconds since the preset loaded.
   * @returns 12 floats: corner0 rgb, corner1 rgb, corner2 rgb, corner3 rgb.
   */
  private hueCorners(time: number): number[] {
    const o = this.hueOffsets;
    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      let r = 0.6 + 0.3 * Math.sin(time * 30 * 0.0143 + 3 + i * 21 + o[3]);
      let g = 0.6 + 0.3 * Math.sin(time * 30 * 0.0107 + 1 + i * 13 + o[1]);
      let b = 0.6 + 0.3 * Math.sin(time * 30 * 0.0129 + 6 + i * 9 + o[2]);
      const mx = Math.max(r, g, b);
      r = 0.5 + 0.5 * (r / mx);
      g = 0.5 + 0.5 * (g / mx);
      b = 0.5 + 0.5 * (b / mx);
      out.push(r, g, b);
    }
    return out;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
