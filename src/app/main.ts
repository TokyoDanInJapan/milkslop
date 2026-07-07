/**
 * Milkslop.  Entry point + render loop.
 */

import { createGL } from "../render/gl.ts";
import { Visualizer, type PresetEntry } from "./Visualizer.ts";
import { UI } from "./ui.ts";
import { AudioEngine, WAVE_SAMPLES } from "../audio/AudioEngine.ts";
import defaultPreset from "../presets/default.milk?raw";
import flowPreset from "../presets/flow.milk?raw";
import frothPreset from "../presets/froth.milk?raw";
import rosePreset from "../presets/rose.milk?raw";
import frothTextureUrl from "../presets/froth.png";
import { tunables } from "../config.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const startEl = document.getElementById("start") as HTMLDivElement;

const gl = createGLorFail();
const params = new URLSearchParams(location.search);

/**
 * Create the WebGL2 context, or - on browsers/GPUs that don't support it -
 * show a friendly message in the intro overlay and return null so the app
 * never boots (instead of leaving a blank page behind an unresponsive splash).
 */
function createGLorFail(): WebGL2RenderingContext | null {
  try {
    return createGL(canvas);
  } catch (err) {
    startEl.style.cursor = "default";
    startEl.innerHTML = `
      <b>Milkslop can't run here</b>
      <div>This visualizer needs <b>WebGL2</b>, which this browser or GPU
      doesn't support.</div>
      <small>Try a recent Chrome, Edge, or Firefox with hardware acceleration
      enabled.<br><br>${(err as Error).message}</small>`;
    return null;
  }
}

let viz: Visualizer | null = null;
let audio: AudioEngine | null = null;
let ui: UI | null = null;

// reusable audio scratch buffers
const monoWave = new Float32Array(WAVE_SAMPLES);
let monoSpec = new Float32Array(512);
const silentWave = new Float32Array(WAVE_SAMPLES);
const silentSpec = new Float32Array(512);

/** A zeroed frame: used when there's no audio source, and while frozen. */
const SILENT_FRAME: import("../render/Renderer.ts").AudioFrame = {
  spectrum: silentSpec,
  waveform: silentWave,
  waveL: silentWave,
  waveR: silentWave,
  specL: silentSpec,
  specR: silentSpec,
};

let frozen = false;
let sensitivity = 1; // desired audio sensitivity, applied once an engine exists
let fpsCap = 60; // frame-rate cap in Hz; 0 = off (render every animation frame)

/** Match the canvas backing store to its CSS size (DPR-aware, capped at 2×). */
function sizeCanvas(): { w: number; h: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(16, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(16, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h };
}

/** Sample the audio engine into a render-ready frame (mono mix + per-channel data); silent if no source. */
function buildAudioFrame(): import("../render/Renderer.ts").AudioFrame {
  if (!audio) return SILENT_FRAME;
  audio.sample();
  const [wl, wr] = audio.waveform;
  for (let i = 0; i < WAVE_SAMPLES; i++)
    monoWave[i] = 0.5 * ((wl[i] ?? 0) + (wr[i] ?? 0));
  const [sl, sr] = audio.spectrum;
  if (monoSpec.length !== sl.length) monoSpec = new Float32Array(sl.length);
  for (let i = 0; i < monoSpec.length; i++)
    monoSpec[i] = 0.5 * ((sl[i] ?? 0) + (sr[i] ?? 0));
  return {
    spectrum: monoSpec,
    waveform: monoWave,
    waveL: wl,
    waveR: wr,
    specL: sl,
    specR: sr,
  };
}

let prevT = performance.now();
let frames = 0;
let fpsAvg = 60;

/** Push the current preset list and FPS into the UI overlay. */
function refreshUI(): void {
  if (!viz || !ui) return;
  ui.setPresetList(viz.presetNames, viz.currentIndex);
  ui.setFps(fpsAvg);
}

/** Construct the Visualizer and UI on first frame and wire their callbacks together. */
function initApp(w: number, h: number): void {
  const playlist: PresetEntry[] = [
    { name: "default", source: defaultPreset },
    { name: "flow", source: flowPreset },
    { name: "froth", source: frothPreset },
    { name: "rose", source: rosePreset },
  ];
  // The UI is built first so the Visualizer constructor can already surface
  // shader-compile failures in the initial preset; its callbacks only touch
  // `viz` when the user interacts, by which point it exists.
  ui = new UI({
    onPrev: prevPreset,
    onNext: nextPreset,
    onJump: (i) => viz!.jumpTo(i),
    onQueueFiles: enqueueAudio,
    onQueuePlay: (i) => void playQueueAt(i),
    onQueueRemove: removeFromQueue,
    onTrackPrev: prevTrack,
    onTrackNext: nextTrack,
    onTrackPlayPause: togglePlayPause,
    onSeek: seekCurrent,
    onAddPresets: (entries) => {
      viz!.appendPresets(entries);
      refreshUI();
    },
    onAddImages: (images) => viz!.registerImages(images),
    onToggleFullscreen: toggleFullscreen,
    onToggleHardCuts: toggleHardCuts,
    onToggleFreeze: toggleFreeze,
    onSensitivity: setSensitivity,
    onFpsCap: setFpsCap,
    onBlur: setBlur,
  });

  viz = new Visualizer(gl!, w, h, playlist, {
    // ?fast overrides the configured cycle time with the fast-mode interval;
    // everything else (blend, hard-cut params, …) defaults from config.yaml
    timeBetweenPresets: params.has("fast")
      ? tunables.fastModeInterval
      : tunables.timeBetweenPresets,
    hardCuts: params.has("hardcuts") || undefined,
    onShaderError: (name, errors) => {
      const stages = [...new Set(errors.map((e) => e.stage))].join(" + ");
      ui!.notify(
        `⚠ ${name}: ${stages} shader failed to compile - using fallback`,
      );
    },
  });

  // Bundle the froth texture so the "froth" preset's sampler_froth resolves on
  // load, without the user having to drop an image. Decodes asynchronously; the
  // sampler simply reads black until it's ready a frame or two later.
  void loadBundledTexture("froth", frothTextureUrl);

  viz.onPresetChange = (name) => {
    ui!.showTitle(name);
    refreshUI();
  };
  // No initial title flash: the bundled "default" preset's name stays hidden
  // until the first real preset change fires onPresetChange.
  refreshUI();
  refreshQueueUI();
}

/** Fetch, decode, and register a bundled image as a user texture (`sampler_<name>`). */
async function loadBundledTexture(name: string, url: string): Promise<void> {
  try {
    const resp = await fetch(url);
    const bitmap = await createImageBitmap(await resp.blob());
    viz?.registerImages([{ name, bitmap }]);
  } catch (e) {
    console.error(`Failed to load bundled texture "${name}"`, e);
  }
}

/** The main requestAnimationFrame loop: applies the FPS cap, then renders a frame. */
function loop(): void {
  requestAnimationFrame(loop);

  const now = performance.now();
  // Frame-rate cap: skip this animation frame while we're still ahead of the
  // target interval (prevT only advances on a rendered frame). The 1 ms slack
  // keeps e.g. a 60 Hz cap from collapsing to 30 on a 60 Hz display due to
  // timer jitter. fpsCap 0 = off → never skip.
  if (fpsCap > 0 && now - prevT < 1000 / fpsCap - 1) return;

  const { w, h } = sizeCanvas();
  if (!viz) initApp(w, h);
  else viz.resize(w, h);

  const dt = Math.min(0.1, (now - prevT) / 1000);
  prevT = now;
  fpsAvg = fpsAvg * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;

  // While frozen, re-render the same state (dt 0, no audio) so the image holds
  // and still survives canvas resizes, without advancing motion or reacting.
  viz!.frame(frozen ? SILENT_FRAME : buildAudioFrame(), frozen ? 0 : dt);

  // keep the music seek bar tracking the current track's position
  ui?.setPlayback(
    currentAudioEl?.currentTime ?? 0,
    currentAudioEl?.duration ?? 0,
  );

  if ((frames++ & 31) === 0) refreshUI();
}

/** Lazily create the AudioEngine (on first playback), applying the desired sensitivity. */
function ensureAudio(): AudioEngine {
  if (!audio) {
    audio = new AudioEngine();
    audio.sensitivity = sensitivity;
  }
  return audio;
}

// ── Music queue ────────────────────────────────────────────────────────────
// An ordered list of audio files. Tracks auto-advance on end and wrap around;
// a single-track queue loops gaplessly on the same element.
const queue: File[] = [];
let queueIndex = -1;
let currentAudioEl: HTMLAudioElement | null = null;

/** Push the current music queue and playing index into the UI. */
function refreshQueueUI(): void {
  ui?.setQueue(
    queue.map((f) => f.name),
    queueIndex,
  );
}

/** Append audio files; start playback from the first one if nothing's playing. */
function enqueueAudio(files: File[]): void {
  const wasEmpty = queue.length === 0;
  queue.push(...files);
  if (wasEmpty) void playQueueAt(0);
  else refreshQueueUI();
  ui?.notify(
    `Queued ${files.length} track${files.length === 1 ? "" : "s"}`,
    2500,
  );
}

/** Play the queued track at `index`, wiring auto-advance to the next track. */
async function playQueueAt(index: number): Promise<void> {
  if (index < 0 || index >= queue.length) return;
  queueIndex = index;
  const file = queue[index]!;
  try {
    const el = await ensureAudio().connectAudioFile(file);
    el.loop = false; // we drive advancement ourselves (see onended below)
    if (currentAudioEl && currentAudioEl !== el) {
      currentAudioEl.onended = null;
      currentAudioEl.onplay = null;
      currentAudioEl.onpause = null;
      try {
        URL.revokeObjectURL(currentAudioEl.src);
      } catch {
        /* not an object URL */
      }
    }
    currentAudioEl = el;
    el.onended = () => {
      if (queue.length <= 1) {
        el.currentTime = 0;
        void el.play(); // single track → seamless loop
      } else {
        void playQueueAt((queueIndex + 1) % queue.length);
      }
    };
    el.onplay = () => ui?.setPlaying(true);
    el.onpause = () => ui?.setPlaying(false);
    // connectAudioFile() already started playback before these handlers were
    // attached, so sync the button to the element's current state directly.
    ui?.setPlaying(!el.paused);
    ui?.setSource(`♪ ${file.name}`);
    ui?.showTitle(`♪ ${file.name}`);
  } catch (err) {
    ui?.notify(`Audio error: ${(err as Error).message}`);
  }
  refreshQueueUI();
}

/** Seek the current track to `fraction` (0–1) of its duration. */
function seekCurrent(fraction: number): void {
  const el = currentAudioEl;
  if (el && Number.isFinite(el.duration) && el.duration > 0)
    el.currentTime = Math.max(0, Math.min(1, fraction)) * el.duration;
}

/** Skip to the previous queued track (wraps around). No-op on an empty queue. */
function prevTrack(): void {
  if (queue.length === 0) return;
  const from = queueIndex < 0 ? 0 : queueIndex;
  void playQueueAt((from - 1 + queue.length) % queue.length);
}

/** Skip to the next queued track (wraps around). No-op on an empty queue. */
function nextTrack(): void {
  if (queue.length === 0) return;
  const from = queueIndex < 0 ? -1 : queueIndex;
  void playQueueAt((from + 1) % queue.length);
}

/** Toggle play/pause of the current track, or start the queue if nothing's loaded. */
function togglePlayPause(): void {
  const el = currentAudioEl;
  if (el) {
    if (el.paused) void el.play();
    else el.pause();
  } else if (queue.length > 0) {
    void playQueueAt(queueIndex < 0 ? 0 : queueIndex);
  }
}

/** Remove a queued track, advancing playback if the current one was removed. */
function removeFromQueue(index: number): void {
  if (index < 0 || index >= queue.length) return;
  const wasCurrent = index === queueIndex;
  queue.splice(index, 1);
  if (queue.length === 0) {
    queueIndex = -1;
    if (currentAudioEl) {
      currentAudioEl.onended = null;
      currentAudioEl.pause();
    }
    ui?.setSource("-");
  } else if (wasCurrent) {
    void playQueueAt(index % queue.length);
  } else if (index < queueIndex) {
    queueIndex--; // the playing track shifted down by one
  }
  refreshQueueUI();
}

/** Advance to the next preset (with a blend). */
function nextPreset(): void {
  viz?.next();
}

/** Jump to the previous preset, wrapping around. */
function prevPreset(): void {
  if (!viz) return;
  const n = viz.presetNames.length;
  viz.jumpTo((viz.currentIndex + n - 1) % n);
}

/** Toggle audio-driven hard cuts and reflect the new state in the UI. */
function toggleHardCuts(): void {
  if (!viz) return;
  viz.hardCutsEnabled = !viz.hardCutsEnabled;
  ui?.setHardCutState(viz.hardCutsEnabled);
  ui?.notify(`Hard cuts ${viz.hardCutsEnabled ? "on" : "off"}`);
}

/** Toggle freeze mode, which holds the current image without advancing motion. */
function toggleFreeze(): void {
  frozen = !frozen;
  ui?.setFreezeState(frozen);
}

/** Set the audio sensitivity, applying it to the live engine if one exists. */
function setSensitivity(value: number): void {
  sensitivity = value;
  if (audio) audio.sensitivity = value;
}

/** Set the frame-rate cap in Hz (0 disables the cap). */
function setFpsCap(hz: number): void {
  fpsCap = hz;
}

/** Apply a CSS gaussian blur of `pixels` to the whole canvas (0 clears it). */
function setBlur(pixels: number): void {
  // Soften the whole canvas with the same CSS gaussian the intro overlay uses
  // (backdrop-filter: blur), rather than touching the visualizer pipeline.
  canvas.style.filter = pixels > 0 ? `blur(${pixels}px)` : "";
}

/** Toggle browser fullscreen for the whole document. */
function toggleFullscreen(): void {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  switch (e.key) {
    case "n":
    case "N":
    case "ArrowRight":
      nextPreset();
      break;
    case "ArrowLeft":
      prevPreset();
      break;
    case " ":
      e.preventDefault(); // don't scroll the page
      toggleFreeze();
      break;
    case "f":
    case "F":
      toggleFullscreen();
      break;
    case "h":
    case "H":
      toggleHardCuts();
      break;
    case "?":
      ui?.toggleHelp();
      break;
  }
});

/**
 * Matches the intro overlay's `backdrop-filter: blur(28px)` in index.html, so
 * the canvas blur picks up exactly where the overlay's blur leaves off.
 */
const INTRO_BLUR_PX = 28;

/** Ease the canvas blur from `from`→`to` px over `durationMs` (easeOutCubic). */
function animateBlur(from: number, to: number, durationMs: number): void {
  const t0 = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - t0) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    setBlur(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Dismiss the intro overlay and ease the canvas blur into focus; boots audio opt-in. */
function start(): void {
  // Dismiss the intro overlay with a brief fade (the visualizer is already
  // running behind it). Audio is opt-in: drag in (or pick) an audio file;
  // until then the visuals run on silence.
  startEl.classList.add("leaving");
  // Remove once the overlay's own fade finishes - ignore the bubbling
  // transitionend events from the title/button "explode out" animations.
  startEl.addEventListener("transitionend", function onEnd(e) {
    if (e.target !== startEl || e.propertyName !== "opacity") return;
    startEl.removeEventListener("transitionend", onEnd);
    startEl.remove();
  });
  // Hand the overlay's blur off to the canvas and ease it down to sharp, so the
  // visuals resolve into focus instead of snapping in at the cut.
  animateBlur(INTRO_BLUR_PX, 0, 900);
}

// Only boot the render loop when WebGL2 is available; otherwise the intro
// overlay shows the unsupported message and we stop here.
if (gl) {
  startEl.addEventListener("click", start, { once: true });
  requestAnimationFrame(loop);
}
