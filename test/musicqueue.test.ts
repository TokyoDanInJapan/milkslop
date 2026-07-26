import { describe, it, expect, beforeEach } from "vitest";
import { MusicQueue, type MusicQueueHost } from "../src/app/MusicQueue.ts";

/** Minimal stand-in for the HTMLAudioElement a queue drives. */
class FakeAudio {
  src = "blob:fake";
  loop = false;
  paused = false;
  currentTime = 0;
  duration = 100;
  playCount = 0;
  onended: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  play(): Promise<void> {
    this.playCount++;
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.onpause?.();
  }
}

const file = (name: string): File => ({ name }) as File;

interface Harness {
  queue: MusicQueue;
  host: MusicQueueHost;
  opened: string[];
  elements: FakeAudio[];
  events: string[];
  /** Wait for the in-flight playAt() promise chain to settle. */
  settle: () => Promise<void>;
}

function harness(opts: { failOn?: string; failFirst?: boolean } = {}): Harness {
  const opened: string[] = [];
  const elements: FakeAudio[] = [];
  const events: string[] = [];
  let firstOpen = true;
  const host: MusicQueueHost = {
    open: (f) => {
      opened.push(f.name);
      const failNow = opts.failFirst && firstOpen;
      firstOpen = false;
      if (opts.failOn === f.name || failNow)
        return Promise.reject(new Error("boom"));
      const el = new FakeAudio();
      elements.push(el);
      return Promise.resolve(el as unknown as HTMLAudioElement);
    },
    onChange: () => events.push("change"),
    onPlayingChange: (p) => events.push(`playing:${p}`),
    onTrackChange: (n) => events.push(`track:${n}`),
    onEmpty: () => events.push("empty"),
    onError: (m) => events.push(`error:${m}`),
  };
  return {
    queue: new MusicQueue(host),
    host,
    opened,
    elements,
    events,
    settle: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
}

describe("MusicQueue ordering", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("starts playback when files are added to an empty queue", async () => {
    h.queue.add([file("a.mp3"), file("b.mp3")]);
    await h.settle();
    expect(h.queue.length).toBe(2);
    expect(h.queue.currentIndex).toBe(0);
    expect(h.opened).toEqual(["a.mp3"]);
  });

  it("appends without interrupting the current track", async () => {
    h.queue.add([file("a.mp3")]);
    await h.settle();
    h.queue.add([file("b.mp3")]);
    await h.settle();
    expect(h.queue.currentIndex).toBe(0);
    expect(h.opened).toEqual(["a.mp3"]); // b was queued, not played
  });

  it("ignores an empty add", () => {
    h.queue.add([]);
    expect(h.queue.length).toBe(0);
    expect(h.opened).toEqual([]);
  });

  it("wraps forward and backward", async () => {
    h.queue.add([file("a"), file("b"), file("c")]);
    await h.settle();
    h.queue.prev();
    await h.settle();
    expect(h.queue.currentIndex).toBe(2); // 0 → wraps to last
    h.queue.next();
    await h.settle();
    expect(h.queue.currentIndex).toBe(0); // last → wraps to first
  });

  it("next/prev are no-ops on an empty queue", () => {
    h.queue.next();
    h.queue.prev();
    expect(h.queue.currentIndex).toBe(-1);
    expect(h.opened).toEqual([]);
  });

  it("shifts the current index down when an earlier track is removed", async () => {
    h.queue.add([file("a"), file("b"), file("c")]);
    await h.settle();
    await h.queue.playAt(2);
    expect(h.queue.currentIndex).toBe(2);
    h.queue.remove(0);
    expect(h.queue.currentIndex).toBe(1);
    expect(h.queue.names).toEqual(["b", "c"]);
  });

  it("leaves the current index alone when a later track is removed", async () => {
    h.queue.add([file("a"), file("b"), file("c")]);
    await h.settle();
    h.queue.remove(2);
    expect(h.queue.currentIndex).toBe(0);
    expect(h.queue.names).toEqual(["a", "b"]);
  });

  it("plays the track that slid into the slot when the current is removed", async () => {
    h.queue.add([file("a"), file("b"), file("c")]);
    await h.settle();
    h.queue.remove(0); // removing the playing track
    await h.settle();
    expect(h.queue.names).toEqual(["b", "c"]);
    expect(h.queue.currentIndex).toBe(0);
    expect(h.opened).toEqual(["a", "b"]);
  });

  it("wraps to the first track when the removed current was last", async () => {
    h.queue.add([file("a"), file("b")]);
    await h.settle();
    await h.queue.playAt(1);
    h.queue.remove(1);
    await h.settle();
    expect(h.queue.names).toEqual(["a"]);
    expect(h.queue.currentIndex).toBe(0);
  });

  it("empties cleanly when the last track is removed", async () => {
    h.queue.add([file("a")]);
    await h.settle();
    h.queue.remove(0);
    await h.settle();
    expect(h.queue.length).toBe(0);
    expect(h.queue.currentIndex).toBe(-1);
    expect(h.events).toContain("empty");
    expect(h.elements[0]!.paused).toBe(true);
  });

  it("ignores out-of-range remove and playAt", async () => {
    h.queue.add([file("a")]);
    await h.settle();
    h.queue.remove(5);
    h.queue.remove(-1);
    await h.queue.playAt(9);
    expect(h.queue.length).toBe(1);
    expect(h.queue.currentIndex).toBe(0);
    expect(h.opened).toEqual(["a"]);
  });
});

describe("MusicQueue playback", () => {
  it("loops a single track on its own element instead of reopening it", async () => {
    const h = harness();
    h.queue.add([file("only.mp3")]);
    await h.settle();
    const el = h.elements[0]!;
    el.onended!();
    await h.settle();
    expect(h.opened).toEqual(["only.mp3"]); // not reopened
    expect(el.currentTime).toBe(0);
    expect(el.playCount).toBe(1);
  });

  it("advances to the next track when a multi-track queue ends one", async () => {
    const h = harness();
    h.queue.add([file("a"), file("b")]);
    await h.settle();
    h.elements[0]!.onended!();
    await h.settle();
    expect(h.queue.currentIndex).toBe(1);
    expect(h.opened).toEqual(["a", "b"]);
  });

  it("detaches the outgoing element's handlers on track change", async () => {
    const h = harness();
    h.queue.add([file("a"), file("b")]);
    await h.settle();
    const first = h.elements[0]!;
    await h.queue.playAt(1);
    expect(first.onended).toBeNull();
    expect(first.onplay).toBeNull();
    expect(first.onpause).toBeNull();
  });

  it("toggles play/pause on the live element", async () => {
    const h = harness();
    h.queue.add([file("a")]);
    await h.settle();
    const el = h.elements[0]!;
    h.queue.togglePlayPause();
    expect(el.paused).toBe(true);
    h.queue.togglePlayPause();
    expect(el.paused).toBe(false);
  });

  it("retries from the queue when toggled with no live element", async () => {
    // the first open fails, so the queue holds a track but no element; the
    // play/pause button should start it rather than doing nothing
    const h = harness({ failFirst: true });
    h.queue.add([file("a")]);
    await h.settle();
    expect(h.elements).toHaveLength(0);

    h.queue.togglePlayPause();
    await h.settle();
    expect(h.opened).toEqual(["a", "a"]);
    expect(h.elements).toHaveLength(1);
    expect(h.elements[0]!.paused).toBe(false);
  });

  it("seeks by fraction, clamped to 0..1", async () => {
    const h = harness();
    h.queue.add([file("a")]);
    await h.settle();
    const el = h.elements[0]!;
    h.queue.seek(0.25);
    expect(el.currentTime).toBe(25);
    h.queue.seek(2);
    expect(el.currentTime).toBe(100);
    h.queue.seek(-1);
    expect(el.currentTime).toBe(0);
  });

  it("does not seek when the duration is unknown", async () => {
    const h = harness();
    h.queue.add([file("a")]);
    await h.settle();
    const el = h.elements[0]!;
    el.duration = NaN;
    h.queue.seek(0.5);
    expect(el.currentTime).toBe(0);
  });

  it("reports an open failure instead of throwing", async () => {
    const h = harness({ failOn: "bad.mp3" });
    h.queue.add([file("bad.mp3")]);
    await h.settle();
    expect(h.events.some((e) => e.startsWith("error:"))).toBe(true);
  });

  it("exposes playback position and duration, zeroed when idle", async () => {
    const h = harness();
    expect(h.queue.currentTime).toBe(0);
    expect(h.queue.duration).toBe(0);
    h.queue.add([file("a")]);
    await h.settle();
    h.elements[0]!.currentTime = 12;
    expect(h.queue.currentTime).toBe(12);
    expect(h.queue.duration).toBe(100);
  });
});
