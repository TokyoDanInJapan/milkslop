/**
 * The music queue: an ordered list of audio files with a current track, plus
 * the playback wiring that keeps one {@link HTMLAudioElement} alive at a time.
 *
 * @remarks
 * Tracks auto-advance on end and wrap around; a single-track queue loops on the
 * same element. The queue owns only ordering and playback lifecycle - opening a
 * file and every user-visible side effect are injected, so the ordering rules
 * (removal index shifting, wrap-around, restart-vs-advance) are unit-testable
 * without a DOM or an AudioContext.
 */

/** Side effects a {@link MusicQueue} needs from its host. */
export interface MusicQueueHost {
  /**
   * Begin playing `file`, returning the element driving it. In the app this is
   * `AudioEngine.connectAudioFile`, which also routes it through the analyser.
   */
  open: (file: File) => Promise<HTMLAudioElement>;
  /** The queue's contents or current index changed; refresh any listing. */
  onChange: () => void;
  /** Playback started (`true`) or paused (`false`). */
  onPlayingChange: (playing: boolean) => void;
  /** A new track became current, with its file name. */
  onTrackChange: (name: string) => void;
  /** The queue emptied, so nothing is playing. */
  onEmpty: () => void;
  /** Opening or playing a track failed. */
  onError: (message: string) => void;
}

/** An ordered list of audio files with playback and auto-advance. */
export class MusicQueue {
  private items: File[] = [];
  private index = -1;
  private el: HTMLAudioElement | null = null;

  /** @param host - Side effects the queue drives (see {@link MusicQueueHost}). */
  constructor(private host: MusicQueueHost) {}

  /** File names in queue order. */
  get names(): string[] {
    return this.items.map((f) => f.name);
  }

  /** Index of the playing track, or -1 when the queue is empty/idle. */
  get currentIndex(): number {
    return this.index;
  }

  /** Number of queued tracks. */
  get length(): number {
    return this.items.length;
  }

  /** Playback position of the current track in seconds (0 when idle). */
  get currentTime(): number {
    return this.el?.currentTime ?? 0;
  }

  /** Duration of the current track in seconds (0 when idle or unknown). */
  get duration(): number {
    return this.el?.duration ?? 0;
  }

  /**
   * Append tracks. Starts playback from the first one if the queue was empty,
   * so dropping files in always produces sound.
   *
   * @param files - Audio files to append.
   */
  add(files: File[]): void {
    if (!files.length) return;
    const wasEmpty = this.items.length === 0;
    this.items.push(...files);
    if (wasEmpty) void this.playAt(0);
    else this.host.onChange();
  }

  /**
   * Play the queued track at `index`, wiring auto-advance to the next one.
   *
   * @param index - Queue position to play; out-of-range indices are ignored.
   */
  async playAt(index: number): Promise<void> {
    if (index < 0 || index >= this.items.length) return;
    this.index = index;
    const file = this.items[index]!;
    try {
      const el = await this.host.open(file);
      el.loop = false; // advancement is driven below, not by the element
      this.releaseElement(el);
      this.el = el;
      el.onended = () => this.advanceAfterEnd(el);
      el.onplay = () => this.host.onPlayingChange(true);
      el.onpause = () => this.host.onPlayingChange(false);
      // open() already started playback before these handlers were attached,
      // so sync the initial state directly from the element.
      this.host.onPlayingChange(!el.paused);
      this.host.onTrackChange(file.name);
    } catch (err) {
      this.host.onError((err as Error).message);
    }
    this.host.onChange();
  }

  /** A single-track queue loops seamlessly; otherwise advance and wrap. */
  private advanceAfterEnd(el: HTMLAudioElement): void {
    if (this.items.length <= 1) {
      el.currentTime = 0;
      void el.play();
    } else {
      void this.playAt((this.index + 1) % this.items.length);
    }
  }

  /** Detach the outgoing element's handlers and free its object URL. */
  private releaseElement(replacement: HTMLAudioElement | null): void {
    const old = this.el;
    if (!old || old === replacement) return;
    old.onended = null;
    old.onplay = null;
    old.onpause = null;
    try {
      URL.revokeObjectURL(old.src);
    } catch {
      /* not an object URL */
    }
  }

  /**
   * Remove a queued track, advancing playback if the current one was removed.
   *
   * @param index - Queue position to remove; out-of-range indices are ignored.
   */
  remove(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    const wasCurrent = index === this.index;
    this.items.splice(index, 1);
    if (this.items.length === 0) {
      this.index = -1;
      if (this.el) {
        this.el.onended = null;
        this.el.pause();
      }
      this.host.onEmpty();
    } else if (wasCurrent) {
      // the removed slot now holds the following track (or wraps to the first)
      void this.playAt(index % this.items.length);
    } else if (index < this.index) {
      this.index--; // the playing track shifted down by one
    }
    this.host.onChange();
  }

  /** Skip to the previous track (wraps). No-op on an empty queue. */
  prev(): void {
    if (this.items.length === 0) return;
    const from = this.index < 0 ? 0 : this.index;
    void this.playAt((from - 1 + this.items.length) % this.items.length);
  }

  /** Skip to the next track (wraps). No-op on an empty queue. */
  next(): void {
    if (this.items.length === 0) return;
    const from = this.index < 0 ? -1 : this.index;
    void this.playAt((from + 1) % this.items.length);
  }

  /** Toggle play/pause, or start the queue if nothing is loaded yet. */
  togglePlayPause(): void {
    if (this.el) {
      if (this.el.paused) void this.el.play();
      else this.el.pause();
    } else if (this.items.length > 0) {
      void this.playAt(this.index < 0 ? 0 : this.index);
    }
  }

  /**
   * Seek the current track.
   *
   * @param fraction - Target position as a fraction (0–1) of the duration.
   */
  seek(fraction: number): void {
    const el = this.el;
    if (el && Number.isFinite(el.duration) && el.duration > 0)
      el.currentTime = Math.max(0, Math.min(1, fraction)) * el.duration;
  }
}
