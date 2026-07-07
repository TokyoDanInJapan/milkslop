/**
 * Web Audio input → time-domain waveform + frequency spectrum.
 *
 * This is the browser-side capture layer. The MilkDrop-specific band analysis
 * (bass/mid/treb at four timescales, normalized so the long-term average ~= 1)
 * lives in SoundAnalyzer (port of AnalyzeNewSound) and consumes the arrays here.
 */

import { constants } from "../config.ts";

/** Waveform sample count per channel (matches MilkDrop's `fWaveform[2][576]`). */
export const WAVE_SAMPLES = constants.audio.waveSamples;

/** Web Audio capture: per-channel time-domain waveform + frequency spectrum. */
export class AudioEngine {
  readonly ctx: AudioContext;
  private analyserL: AnalyserNode;
  private analyserR: AnalyserNode;
  private splitter: ChannelSplitterNode;
  /** User-facing sensitivity gain applied before analysis (see {@link sensitivity}). */
  private gain: GainNode;
  private source: AudioNode | null = null;

  /** Time-domain waveform, [-1..1], per channel. Length WAVE_SAMPLES. */
  readonly waveform: [Float32Array, Float32Array];
  /** Frequency magnitude (0..1), per channel. Length = fftSize/2. */
  readonly spectrum: [Float32Array, Float32Array];

  private byteWaveL: Uint8Array<ArrayBuffer>;
  private byteWaveR: Uint8Array<ArrayBuffer>;
  private byteFreqL: Uint8Array<ArrayBuffer>;
  private byteFreqR: Uint8Array<ArrayBuffer>;

  /** Build the analyser graph and sample buffers for the given FFT size. */
  constructor(fftSize = 1024) {
    this.ctx = new AudioContext();
    this.splitter = this.ctx.createChannelSplitter(2);

    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    for (const a of [this.analyserL, this.analyserR]) {
      a.fftSize = fftSize;
      a.smoothingTimeConstant = 0.0; // MilkDrop does its own smoothing
    }
    this.gain = this.ctx.createGain();
    this.gain.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);

    const bins = fftSize / 2;
    this.byteWaveL = new Uint8Array(fftSize);
    this.byteWaveR = new Uint8Array(fftSize);
    this.byteFreqL = new Uint8Array(bins);
    this.byteFreqR = new Uint8Array(bins);
    this.waveform = [
      new Float32Array(WAVE_SAMPLES),
      new Float32Array(WAVE_SAMPLES),
    ];
    this.spectrum = [new Float32Array(bins), new Float32Array(bins)];
  }

  /** Route a media element through the analyser graph (and keep it audible). */
  connectMediaElement(el: HTMLMediaElement): void {
    this.disconnect();
    this.source = this.ctx.createMediaElementSource(el);
    this.source.connect(this.gain);
    this.source.connect(this.ctx.destination); // keep it audible (pre-gain)
  }

  /**
   * Audio sensitivity: a gain multiplier applied to the captured signal before
   * band analysis, so quiet sources can be made more reactive (and loud ones
   * tamed) without touching the audible playback path. 1 = unchanged.
   */
  get sensitivity(): number {
    return this.gain.gain.value;
  }
  set sensitivity(value: number) {
    this.gain.gain.value = value;
  }

  /** Play an audio File (drag-dropped or picked) and analyse it. */
  async connectAudioFile(file: File): Promise<HTMLAudioElement> {
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    el.crossOrigin = "anonymous";
    this.connectMediaElement(el);
    await this.resume();
    await el.play();
    return el;
  }

  /** Detach the current source node, if any (safe to call when none). */
  private disconnect(): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
      this.source = null;
    }
  }

  /** Resume the AudioContext if suspended (requires a user gesture). */
  async resume(): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /** Pull the latest frame of audio into waveform[] and spectrum[]. */
  sample(): void {
    this.analyserL.getByteTimeDomainData(this.byteWaveL);
    this.analyserR.getByteTimeDomainData(this.byteWaveR);
    this.analyserL.getByteFrequencyData(this.byteFreqL);
    this.analyserR.getByteFrequencyData(this.byteFreqR);

    copyWave(this.byteWaveL, this.waveform[0]);
    copyWave(this.byteWaveR, this.waveform[1]);
    copyFreq(this.byteFreqL, this.spectrum[0]);
    copyFreq(this.byteFreqR, this.spectrum[1]);
  }
}

/** Decimate a byte time-domain buffer into `dst`, recentred to roughly [-1, 1]. */
function copyWave(src: Uint8Array, dst: Float32Array): void {
  // src is 0..255 centered at 128; sample/decimate down to dst.length.
  const n = dst.length;
  const step = src.length / n;
  for (let i = 0; i < n; i++) {
    const s = src[Math.floor(i * step)] ?? 128;
    dst[i] = (s - 128) / 128;
  }
}

/** Normalise a byte frequency buffer into `dst` as values in [0, 1]. */
function copyFreq(src: Uint8Array, dst: Float32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (src[i] ?? 0) / 255;
}
