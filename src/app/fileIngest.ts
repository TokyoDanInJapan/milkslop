/**
 * File and URL ingestion for the UI: window-wide drag-and-drop wiring, routing
 * a mixed batch of files by kind, and fetching `.milk` presets from a web URL.
 * Pure logic + event wiring; the UI class supplies the sink callbacks.
 */

import type { PresetEntry } from "./Visualizer.ts";
import { fetchMilkFromUrl } from "./presetUrl.ts";

/** Where ingested content and user feedback are delivered. */
export interface IngestSink {
  /** Append parsed presets to the playlist. */
  onAddPresets: (entries: PresetEntry[]) => void;
  /** Register decoded images as user textures. */
  onAddImages: (images: { name: string; bitmap: ImageBitmap }[]) => void;
  /** Append audio files to the play queue. */
  onQueueFiles: (files: File[]) => void;
  /** Show a transient notification toast. */
  notify: (message: string, durationMs?: number) => void;
  /** Show/hide the "loading presets from URL" throbber. */
  setUrlBusy: (busy: boolean) => void;
}

/**
 * Wire up drag-and-drop onto the window. Dropped files are forwarded to
 * {@link routeFiles}; a dropped link (e.g. a `.milk` URL or a GitHub URL
 * dragged from a browser) is loaded via {@link loadPresetsFromUrl}.
 */
export function setupDragDrop(sink: IngestSink): void {
  const prevent = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ["dragenter", "dragover", "dragleave", "drop"].forEach((t) =>
    window.addEventListener(t, prevent),
  );
  window.addEventListener("dragover", () =>
    document.body.classList.add("mw-drag"),
  );
  window.addEventListener("dragleave", () =>
    document.body.classList.remove("mw-drag"),
  );
  window.addEventListener("drop", (e) => {
    document.body.classList.remove("mw-drag");
    const dt = e.dataTransfer;
    const files = Array.from(dt?.files ?? []);
    if (files.length) {
      void routeFiles(files, sink);
      return;
    }
    // No files - a link dragged in from a browser. The URL arrives as
    // text/uri-list (one URL per line, '#' comments) or text/plain; pull the
    // first real URL and load presets from it (direct .milk or GitHub URL).
    const text = dt?.getData("text/uri-list") || dt?.getData("text/plain");
    const url = text
      ?.split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^https?:\/\//i.test(l));
    if (url) void loadPresetsFromUrl(url, sink);
  });
}

/**
 * Route a batch of files by kind - shared by drag-and-drop and the list's
 * "Load" picker. `.milk` files become presets, images become user textures,
 * and audio files are appended to the play queue.
 */
export async function routeFiles(
  files: File[],
  sink: IngestSink,
): Promise<void> {
  const milk = files.filter((f) => f.name.toLowerCase().endsWith(".milk"));
  const audio = files.filter((f) => f.type.startsWith("audio/"));
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (milk.length) {
    const entries: PresetEntry[] = await Promise.all(
      milk.map(async (f) => ({
        name: f.name.replace(/\.milk$/i, ""),
        source: await f.text(),
      })),
    );
    sink.onAddPresets(entries);
    sink.notify(
      `Added ${entries.length} preset${entries.length > 1 ? "s" : ""}`,
      2500,
    );
  }
  if (images.length) {
    // bind each image as a user texture keyed by its base filename, so a
    // preset's sampler_<name> resolves to the matching drop (e.g. pifano.jpg
    // → sampler_pifano). createImageBitmap decodes off the main thread.
    // allSettled (not all) so one undecodable file doesn't drop the whole
    // batch - the rest still load.
    const results = await Promise.allSettled(
      images.map(async (f) => ({
        name: f.name.replace(/\.[^.]+$/, "").toLowerCase(),
        bitmap: await createImageBitmap(f),
      })),
    );
    const decoded = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    if (decoded.length) sink.onAddImages(decoded);
    const failed = results.length - decoded.length;
    sink.notify(
      `Loaded ${decoded.length} image${decoded.length === 1 ? "" : "s"}` +
        (failed ? ` · ${failed} failed to decode` : ""),
      2500,
    );
  }
  if (audio.length) sink.onQueueFiles(audio);
}

/**
 * Fetch `.milk` presets from a web URL and append them to the playlist.
 * Accepts a raw/direct `.milk` link, a GitHub single-file (blob) URL, a
 * GitHub folder (tree) URL, or a bare GitHub repo / `.git` URL - folders and
 * repos are listed via the GitHub contents API and every `.milk` in them is
 * fetched. Presets only; any textures they
 * reference must still be supplied locally (drag them in).
 */
export async function loadPresetsFromUrl(
  url: string,
  sink: IngestSink,
): Promise<void> {
  // throbber in the panel header signals the fetch is in flight
  sink.setUrlBusy(true);
  try {
    const { entries, total, failed } = await fetchMilkFromUrl(url);
    if (!entries.length) {
      sink.notify(
        failed
          ? `All ${failed} preset download${failed === 1 ? "" : "s"} from that URL failed`
          : "No .milk presets found at that URL",
        4000,
      );
      return;
    }
    sink.onAddPresets(entries);
    const more =
      total > entries.length + failed
        ? ` (first ${entries.length} of ${total})`
        : "";
    const failures = failed ? ` · ${failed} failed to download` : "";
    sink.notify(
      `Added ${entries.length} preset${entries.length === 1 ? "" : "s"} from URL${more}${failures}`,
      3500,
    );
  } catch (e) {
    sink.notify(
      `Couldn't load from URL: ${e instanceof Error ? e.message : String(e)}`,
      5000,
    );
  } finally {
    sink.setUrlBusy(false);
  }
}
