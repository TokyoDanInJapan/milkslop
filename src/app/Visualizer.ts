/**
 * Top-level visualizer: manages a preset playlist, timed auto-cycling, optional
 * beat-driven hard cuts, and crossfade blending between two presets.
 *
 * Each preset renders in its own Renderer slot (its own feedback buffer), so a
 * blend keeps both presets fully alive - a dual-state transition like MilkDrop's,
 * presented via a cosine-eased crossfade.
 */

import {
  Renderer,
  type AudioFrame,
  type ShaderCompileError,
} from "../render/Renderer.ts";
import { Present } from "../render/Present.ts";
import { RenderTarget } from "../render/RenderTarget.ts";
import { parseMilk, CompiledPreset } from "../preset/index.ts";
import { SoundAnalyzer } from "../audio/SoundAnalyzer.ts";
import { tunables, constants } from "../config.ts";

/** A named preset source in the playlist. */
export interface PresetEntry {
  name: string;
  source: string;
}

/**
 * One frame of the hard-cut loudness test (milkdropfs.cpp:907), as a pure
 * function. The threshold jumps ×2 on a trigger (a self-limiting refractory)
 * and otherwise decays toward `base` with the original's per-frame multiplier
 * `exp(-ln(4) / (halflife·fps))` - i.e. the excess falls to a quarter over
 * `halflife` seconds. Below 1 fps the test is skipped.
 *
 * @param thresh - Current threshold.
 * @param loudness - Sum of imm_rel bass+mid+treb (each ≈ 1).
 * @param base - Resting loudness threshold (`hardCutLoudness`).
 * @param halflife - Decay time constant in seconds.
 * @param fps - Current frames per second.
 * @returns The next threshold and whether a cut fires this frame.
 */
export function stepHardCut(
  thresh: number,
  loudness: number,
  base: number,
  halflife: number,
  fps: number,
): { thresh: number; trigger: boolean } {
  if (fps <= 1) return { thresh, trigger: false };
  if (loudness > thresh * 3) return { thresh: thresh * 2, trigger: true };
  const mult = Math.exp(constants.hardCut.decayConstant / (halflife * fps));
  return { thresh: (thresh - base) * mult + base, trigger: false };
}

/** Options controlling auto-cycling, blending, and hard cuts. */
export interface VisualizerOptions {
  /** seconds a preset shows before auto-cycling (excludes blend time) */
  timeBetweenPresets?: number;
  /** crossfade duration in seconds */
  blendDuration?: number;
  /** randomise playlist order on each cycle */
  shuffle?: boolean;
  /** enable beat-driven hard cuts */
  hardCuts?: boolean;
  /** loudness threshold for hard cuts (original default 2.5) */
  hardCutLoudness?: number;
  /** hard-cut threshold decay time constant in seconds (original default 60) */
  hardCutHalflife?: number;
  /**
   * Callback for shader-compile failures (see {@link Visualizer.onShaderError}).
   * Passing it here (rather than assigning the property afterwards) lets the
   * constructor report failures in the initial preset too.
   */
  onShaderError?: (name: string, errors: readonly ShaderCompileError[]) => void;
}

/** Top-level visualizer: playlist, cycling, hard cuts, and crossfade blending. */
export class Visualizer {
  private gl: WebGL2RenderingContext;
  private slotA: Renderer;
  private slotB: Renderer;
  private present: Present;

  // user textures (dropped images), keyed by lowercased base filename, shared
  // by both renderer slots so a sampler_<name> resolves regardless of slot
  private userTextures = new Map<string, WebGLTexture>();

  private playlist: PresetEntry[];
  private index = 0;
  // index held by the `previous` slot during a live (non-capture) blend, so a
  // re-selection of it can reverse the crossfade instead of restarting one
  private prevIndex = 0;

  private current: Renderer;
  private previous: Renderer | null = null;

  private timeBetweenPresets: number;
  private blendDuration: number;
  private shuffle: boolean;
  hardCutsEnabled: boolean;

  private sinceSwitch = 0;
  private blending = false;
  private blendProgress = 0;
  private blendDur = 0;
  // When a blend is interrupted by an explicit jump, the live composite is
  // snapshotted into a capture target and the new crossfade runs from it
  // (pop-free) rather than from a live slot. Two targets are ping-ponged so an
  // interrupt of an already-capture-based blend can read the current source
  // while writing the next snapshot. `fromCapture` selects that source while
  // set; `captureSrc` is the target currently feeding the blend.
  private captureA: RenderTarget | null = null;
  private captureB: RenderTarget | null = null;
  private captureSrc: RenderTarget | null = null;
  private fromCapture = false;

  private w: number;
  private h: number;

  // hard-cut detection (faithful port of RenderFrame's loudness logic):
  // its own analyzer for imm_rel bands + a self-raising/decaying threshold
  private hardCutAnalyzer = new SoundAnalyzer();
  private hardCutLoudness: number;
  private hardCutHalflife: number;
  private hardCutThresh: number;

  // parsed fRating per playlist entry (for weighted shuffle)
  private ratings = new WeakMap<PresetEntry, number>();

  /**
   * Create the two render slots and load the first preset.
   *
   * @param gl - The WebGL2 context to render with.
   * @param w - Internal render width in pixels.
   * @param h - Internal render height in pixels.
   * @param playlist - Initial preset playlist (falls back to a blank preset if empty).
   * @param opts - Optional timing/shuffle/hard-cut overrides (default to config).
   */
  constructor(
    gl: WebGL2RenderingContext,
    w: number,
    h: number,
    playlist: PresetEntry[],
    opts: VisualizerOptions = {},
  ) {
    this.w = w;
    this.h = h;
    this.playlist = playlist.length
      ? playlist
      : [{ name: "blank", source: "[preset00]\n" }];
    this.timeBetweenPresets =
      opts.timeBetweenPresets ?? tunables.timeBetweenPresets;
    this.blendDuration = opts.blendDuration ?? tunables.blendDuration;
    this.shuffle = opts.shuffle ?? tunables.shuffle;
    this.hardCutsEnabled = opts.hardCuts ?? tunables.hardCutsEnabled;
    this.hardCutLoudness = opts.hardCutLoudness ?? tunables.hardCutLoudness;
    this.hardCutHalflife = opts.hardCutHalflife ?? tunables.hardCutHalflife;
    this.hardCutThresh = this.hardCutLoudness * 2;

    this.gl = gl;
    this.slotA = new Renderer(gl, w, h, this.userTextures);
    this.slotB = new Renderer(gl, w, h, this.userTextures);
    this.present = new Present(gl);
    this.captureA = new RenderTarget(gl, w, h);
    this.captureB = new RenderTarget(gl, w, h);

    this.current = this.slotA;
    this.onShaderError = opts.onShaderError ?? null;
    this.current.loadPreset(this.compile(this.index), this.presetLifetime());
    if (this.current.shaderErrors.length)
      this.onShaderError?.(this.currentName, this.current.shaderErrors);
  }

  /** Name of the currently-active preset (`"?"` if unknown). */
  get currentName(): string {
    return this.playlist[this.index]?.name ?? "?";
  }
  /** Whether a crossfade between presets is currently in progress. */
  get isBlending(): boolean {
    return this.blending;
  }
  /** The names of every preset in the playlist, in order. */
  get presetNames(): string[] {
    return this.playlist.map((p) => p.name);
  }
  /** Playlist index of the currently-active preset. */
  get currentIndex(): number {
    return this.index;
  }

  /** Optional callback fired when the active preset changes. */
  onPresetChange: ((name: string, index: number) => void) | null = null;

  /**
   * Optional callback fired when a newly-loaded preset has one or more shader
   * stages that failed to compile (and so fell back to a no-shader path).
   */
  onShaderError:
    | ((name: string, errors: readonly ShaderCompileError[]) => void)
    | null = null;

  /**
   * Register dropped images as user textures. A preset shader referencing
   * `sampler_<name>` (e.g. `sampler_pifano`) will sample the image dropped as
   * `<name>.<ext>`. Re-registering a name replaces (and frees) the prior one.
   */
  registerImages(images: { name: string; bitmap: ImageBitmap }[]): void {
    const gl = this.gl;
    for (const { name, bitmap } of images) {
      const existing = this.userTextures.get(name);
      if (existing) gl.deleteTexture(existing);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bitmap,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR_MIPMAP_LINEAR,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.userTextures.set(name, tex);
      bitmap.close();
    }
  }

  /** Replace the whole playlist and switch to its first entry. */
  setPlaylist(
    entries: PresetEntry[],
    blendDuration = this.blendDuration,
  ): void {
    if (!entries.length) return;
    this.playlist = entries;
    this.transitionTo(0, blendDuration);
  }

  /** Append presets; optionally jump to the first newly-added one. */
  appendPresets(entries: PresetEntry[], jump = true): void {
    if (!entries.length) return;
    const firstNew = this.playlist.length;
    this.playlist = this.playlist.concat(entries);
    if (jump) this.transitionTo(firstNew, this.blendDuration);
  }

  /** Blend to a specific playlist index. */
  jumpTo(index: number, blendDuration = this.blendDuration): void {
    if (index < 0 || index >= this.playlist.length) return;
    // Skip only when a blend toward this exact preset is already running, so
    // re-clicking the incoming one doesn't restart it. Selecting the settled
    // current preset re-triggers it; any other preset transitions - so an
    // explicit click always does something.
    if (this.blending && index === this.index) return;
    // Rapid back-and-forth: re-selecting the preset we're currently fading FROM
    // just reverses the in-flight crossfade. Both slots are live and already
    // hold the two presets, so this avoids reloading and the capture path -
    // which otherwise keeps snapshotting the bright outgoing frame, leaving the
    // incoming preset looking washed-out until the blend finally settles.
    if (this.blending && !this.fromCapture && index === this.prevIndex) {
      this.reverseBlend();
      return;
    }
    this.transitionTo(index, blendDuration);
  }

  /** Reverse the in-flight (live, two-slot) crossfade by swapping its ends. */
  private reverseBlend(): void {
    const slot = this.current;
    this.current = this.previous!;
    this.previous = slot;
    const idx = this.index;
    this.index = this.prevIndex;
    this.prevIndex = idx;
    this.blendProgress = 1 - this.blendProgress;
    this.sinceSwitch = 0;
    this.onPresetChange?.(this.currentName, this.index);
  }

  /** Resize both render slots to a new internal resolution. */
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.slotA.resize(w, h);
    this.slotB.resize(w, h);
    this.captureA?.resize(w, h);
    this.captureB?.resize(w, h);
  }

  /** Advance to the next preset with a blend (or instantly if duration ≤ 0). */
  next(blendDuration = this.blendDuration): void {
    if (this.blending) return; // ignore while already transitioning
    this.transitionTo(this.pickNext(), blendDuration);
  }

  /**
   * Load the preset at `index` into the idle slot and begin a crossfade to it
   * (or switch instantly when `blendDuration` ≤ 0).
   *
   * If a blend is already running this interrupts it rather than dropping the
   * request: the live composite is snapshotted into the capture target and the
   * new crossfade resumes from it (pop-free), instead of snapping to the
   * abandoned blend's target. Auto-cycling keeps its own guard in {@link next}
   * so it never stacks a new blend on top of a running one.
   */
  private transitionTo(index: number, blendDuration: number): void {
    // Interrupting a running crossfade: snapshot the live composite into the
    // idle capture target first (before the incoming load overwrites a slot), so
    // the new blend resumes from exactly what's on screen. The "from" image is
    // the outgoing slot for a live blend, or the current capture for one that's
    // already capture-based - reading that capture while writing the other is why
    // the targets ping-pong (otherwise a chained interrupt would lose the
    // on-screen image and pop to a wrong/stale frame).
    const interrupting =
      this.blending && blendDuration > 0 && this.captureA !== null;
    if (interrupting) {
      const dst =
        this.captureSrc === this.captureA ? this.captureB! : this.captureA!;
      const fromTex = this.fromCapture
        ? this.captureSrc!.tex
        : this.previous
          ? this.previous.outputTexture
          : null;
      this.present.toTarget(
        this.current.outputTexture,
        fromTex,
        this.blendProgress,
        dst,
      );
      this.captureSrc = dst;
    }

    // the preset we're leaving is what the outgoing slot keeps (used by the
    // reverse-blend fast path when it's a live, non-capture crossfade)
    this.prevIndex = this.index;
    this.index = index;
    const incoming = this.current === this.slotA ? this.slotB : this.slotA;
    incoming.loadPreset(this.compile(this.index), this.presetLifetime());
    this.sinceSwitch = 0;
    if (incoming.shaderErrors.length)
      this.onShaderError?.(this.currentName, incoming.shaderErrors);

    if (blendDuration <= 0) {
      this.current = incoming;
      this.previous = null;
      this.blending = false;
      this.fromCapture = false;
    } else {
      // On interrupt the "from" image is the frozen capture, so we drop the
      // previous slot; otherwise it's the (live) outgoing preset as usual.
      this.previous = interrupting ? null : this.current;
      this.current = incoming;
      this.fromCapture = interrupting;
      this.blending = true;
      this.blendProgress = 0;
      this.blendDur = blendDuration;
    }
    this.onPresetChange?.(this.currentName, this.index);
  }

  /**
   * Advance and render one frame: step the hard-cut/auto-advance logic, render
   * the active preset (plus the outgoing one while blending), and present the
   * result to the screen.
   *
   * @param audio - This frame's waveform/spectrum audio data.
   * @param dt - Elapsed time since the previous frame, in seconds.
   */
  frame(audio: AudioFrame, dt: number): void {
    this.sinceSwitch += dt;

    // Run the hard-cut threshold dynamics every frame (as the original does),
    // but only act on a trigger when not already mid-blend (≈ "no load underway").
    const wantHardCut = this.hardCutsEnabled && this.detectHardCut(audio, dt);

    if (this.blending) {
      this.blendProgress += dt / this.blendDur;
      if (this.blendProgress >= 1) {
        this.blending = false;
        this.previous = null;
        this.fromCapture = false;
      }
    } else {
      if (wantHardCut) {
        this.next(0); // instant
      } else if (this.sinceSwitch >= this.timeBetweenPresets) {
        this.next();
      }
    }

    // render the active preset(s); on a capture-blend only `current` is live
    this.current.frame(audio, dt);
    if (this.blending && this.previous) this.previous.frame(audio, dt);

    // present / crossfade to screen. The "from" image is the outgoing slot for a
    // normal blend, or the frozen capture for an interrupted one.
    const fromTex = !this.blending
      ? null
      : this.fromCapture
        ? this.captureSrc!.tex
        : (this.previous?.outputTexture ?? null);
    this.present.toScreen(
      this.current.outputTexture,
      fromTex,
      this.blendProgress,
      this.w,
      this.h,
    );
  }

  /**
   * Faithful port of the hard-cut loudness test in RenderFrame
   * (milkdropfs.cpp:907). The sum of the immediate-relative bass/mid/treb bands
   * (each ≈ 1) is compared against a threshold that jumps ×2 on every trigger
   * (a self-limiting refractory) and otherwise decays back toward
   * `hardCutLoudness` with the original's per-frame multiplier. Updates the
   * threshold every frame and returns whether a cut should fire this frame.
   */
  private detectHardCut(audio: AudioFrame, dt: number): boolean {
    const b = this.hardCutAnalyzer.update(audio.spectrum, dt);
    const r = stepHardCut(
      this.hardCutThresh,
      b.bass + b.mid + b.treb,
      this.hardCutLoudness,
      this.hardCutHalflife,
      dt > 0 ? 1 / dt : 60,
    );
    this.hardCutThresh = r.thresh;
    return r.trigger;
  }

  /**
   * The cached `fRating` (0..5, default 3) of playlist entry `i`, used for
   * rating-weighted shuffle: a 5-star preset is picked 5× as often as a 1-star.
   */
  private ratingOf(i: number): number {
    const entry = this.playlist[i]!;
    let r = this.ratings.get(entry);
    if (r === undefined) {
      const m = entry.source.match(/^fRating=([\d.]+)/m);
      r = m ? Math.max(0, Math.min(5, parseFloat(m[1]!))) : 3;
      this.ratings.set(entry, r);
    }
    return r;
  }

  /** Choose the next preset index - rating-weighted random when shuffling, else sequential. */
  private pickNext(): number {
    if (this.playlist.length <= 1) return this.index;
    if (this.shuffle) {
      let total = 0;
      for (let i = 0; i < this.playlist.length; i++)
        if (i !== this.index) total += this.ratingOf(i);
      if (total > 0) {
        let roll = Math.random() * total;
        for (let i = 0; i < this.playlist.length; i++) {
          if (i === this.index) continue;
          roll -= this.ratingOf(i);
          if (roll <= 0) return i;
        }
      }
    }
    return (this.index + 1) % this.playlist.length;
  }

  /** Intended on-screen lifetime of a preset in seconds (display time + blend). */
  private presetLifetime(): number {
    return this.timeBetweenPresets + this.blendDuration;
  }

  /** Parse and compile the preset source at playlist index `i`. */
  private compile(i: number): CompiledPreset {
    const entry = this.playlist[i]!;
    return new CompiledPreset(parseMilk(entry.source, entry.name));
  }
}
