/**
 * Minimal framework-free UI: a bottom toolbar, a preset-list panel, a transient
 * preset-title overlay, and window-wide drag-and-drop for .milk presets and
 * audio files. Auto-hides the chrome when the mouse is idle.
 */

import type { PresetEntry } from "./Visualizer.ts";
import { el, fmtTime } from "./dom.ts";
import {
  loadPresetsFromUrl,
  routeFiles,
  setupDragDrop,
  type IngestSink,
} from "./fileIngest.ts";
import { HELP_HTML, injectStyles } from "./uiStyles.ts";

/** Callbacks the {@link UI} invokes in response to user actions. */
export interface UICallbacks {
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  /** Append audio files to the play queue (starts playback if it was idle). */
  onQueueFiles: (files: File[]) => void;
  /** Play the queued track at `index`. */
  onQueuePlay: (index: number) => void;
  /** Remove the queued track at `index`. */
  onQueueRemove: (index: number) => void;
  /** Skip to the previous queued track. */
  onTrackPrev: () => void;
  /** Skip to the next queued track. */
  onTrackNext: () => void;
  /** Toggle play/pause of the current track. */
  onTrackPlayPause: () => void;
  /** Seek the current track to `fraction` (0–1) of its duration. */
  onSeek: (fraction: number) => void;
  onAddPresets: (entries: PresetEntry[]) => void;
  onAddImages: (images: { name: string; bitmap: ImageBitmap }[]) => void;
  onToggleFullscreen: () => void;
  onToggleHardCuts: () => void;
  onToggleFreeze: () => void;
  onSensitivity: (value: number) => void;
  onFpsCap: (hz: number) => void;
  onBlur: (pixels: number) => void;
}

/** The DOM UI: toolbar, preset list, title overlay, and drag-and-drop. */
export class UI {
  private root: HTMLElement;
  private toolbar: HTMLElement;
  private popups: HTMLElement; // wraps the open menus so they centre/stack when narrow
  private list: HTMLElement;
  private listItems: HTMLElement;
  private listCount: HTMLElement;
  private presetSpinner!: HTMLElement; // throbber shown while loading presets from a URL
  private searchInput: HTMLInputElement;
  private queue: HTMLElement;
  private queueItems: HTMLElement;
  private queueCount: HTMLElement;
  private titleEl: HTMLElement;
  private fpsReadout!: HTMLElement; // "current/max" fps shown beside the cap slider
  private fpsCap = 60; // current frame-rate cap in Hz (0 = uncapped), for the readout
  private lastFps = 0; // last measured fps, retained so cap changes re-render the readout
  private sourceEl: HTMLElement;
  private seekInput: HTMLInputElement;
  private seekTime: HTMLElement;
  private seeking = false; // true while the user drags the seek bar
  private hardCutBtn: HTMLButtonElement;
  private freezeBtn: HTMLButtonElement;
  private playPauseBtn!: HTMLButtonElement;
  private render!: HTMLElement; // render-sliders container (inline wide / ⚙ panel narrow)
  private helpEl: HTMLElement;
  private noticeEl: HTMLElement;
  private idleTimer = 0;
  private titleTimer = 0;
  private noticeTimer = 0;
  // cached playlist so the search box can re-filter without a round-trip
  private names: string[] = [];
  private currentIndex = 0;
  private filter = "";
  // sink handed to the fileIngest module: routes dropped/picked/URL-loaded
  // content into the app callbacks and surfaces progress in this UI
  private ingest: IngestSink;

  /** Build the overlay DOM, wire up event handlers, and attach it to `document.body`. */
  constructor(private cb: UICallbacks) {
    injectStyles();
    this.ingest = {
      onAddPresets: (entries) => cb.onAddPresets(entries),
      onAddImages: (images) => cb.onAddImages(images),
      onQueueFiles: (files) => cb.onQueueFiles(files),
      notify: (message, durationMs) => this.notify(message, durationMs),
      setUrlBusy: (busy) =>
        this.presetSpinner.classList.toggle("mw-hidden", !busy),
    };
    this.root = el("div", "mw-ui");

    // transient title overlay
    this.titleEl = el("div", "mw-title");
    this.root.appendChild(this.titleEl);

    // transient notification toast (e.g. shader-compile failures)
    this.noticeEl = el("div", "mw-notice");
    this.root.appendChild(this.noticeEl);

    // Container for the floating menus. On wide screens it's display:contents, so
    // each panel docks to its own edge (presets right, queue left); on narrow
    // screens it becomes a centred flex column above the bar, so multiple open
    // menus stack instead of overlapping (see the media query).
    this.popups = el("div", "mw-popups");
    this.root.appendChild(this.popups);

    // preset list panel: header (title + count + close), search, items, load
    this.list = el("div", "mw-list mw-hidden");
    const head = el("div", "mw-list-head");
    head.appendChild(el("span", "mw-list-title", "Presets"));
    this.listCount = el("span", "mw-list-count", "0");
    head.appendChild(this.listCount);
    this.presetSpinner = el("span", "mw-spinner mw-hidden");
    this.presetSpinner.title = "Loading presets…";
    head.appendChild(this.presetSpinner);
    const closeBtn = el("button", "mw-list-close", "✕");
    closeBtn.title = "Close (Esc)";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      this.toggleList(false);
    };
    head.appendChild(closeBtn);
    this.list.appendChild(head);

    this.searchInput = el("input", "mw-search");
    this.searchInput.type = "search";
    this.searchInput.placeholder = "Search presets…";
    this.searchInput.onclick = (e) => e.stopPropagation();
    this.searchInput.oninput = () => {
      this.filter = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    };
    this.list.appendChild(this.searchInput);

    this.listItems = el("div", "mw-items");
    this.list.appendChild(this.listItems);

    const loadBtn = el("button", "mw-load", "Load .milk or texture files");
    loadBtn.title = "Open preset or image files";
    loadBtn.onclick = (e) => {
      e.stopPropagation();
      filesInput.click();
    };
    this.list.appendChild(loadBtn);

    // Load presets from a web URL (a raw .milk link or a GitHub folder): an
    // always-visible input + "Load" button; Enter or the button fetches/appends.
    const urlRow = el("div", "mw-urlrow");
    const urlInput = el("input", "mw-urlinput");
    urlInput.type = "url";
    urlInput.placeholder = ".milk or GitHub URL";
    urlInput.onclick = (e) => e.stopPropagation();
    const urlGo = el("button", "mw-urlgo", "Load");
    const submitUrl = (): void => {
      const u = urlInput.value.trim();
      urlInput.value = "";
      if (u) void loadPresetsFromUrl(u, this.ingest);
    };
    urlInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.stopPropagation();
        submitUrl();
      }
    };
    urlGo.onclick = (e) => {
      e.stopPropagation();
      submitUrl();
    };
    urlRow.append(urlInput, urlGo);
    this.list.appendChild(urlRow);
    this.popups.appendChild(this.list);

    // music queue panel: mirrors the preset panel (header + items + add button)
    // but anchored bottom-left, with a remove button per track
    this.queue = el("div", "mw-list mw-queue mw-hidden");
    const qhead = el("div", "mw-list-head");
    qhead.appendChild(el("span", "mw-list-title", "Queue"));
    this.queueCount = el("span", "mw-list-count", "0");
    qhead.appendChild(this.queueCount);
    const qclose = el("button", "mw-list-close", "✕");
    qclose.title = "Close (Esc)";
    qclose.onclick = (e) => {
      e.stopPropagation();
      this.toggleQueue(false);
    };
    qhead.appendChild(qclose);
    this.queue.appendChild(qhead);

    this.queueItems = el("div", "mw-items");
    this.queue.appendChild(this.queueItems);

    const addMusicBtn = el("button", "mw-load", "＋  Add music");
    addMusicBtn.title = "Open audio files to queue";
    addMusicBtn.onclick = (e) => {
      e.stopPropagation();
      musicInput.click();
    };
    this.queue.appendChild(addMusicBtn);
    this.popups.appendChild(this.queue);

    // Full-width media bar pinned to the bottom edge: a seek strip across the
    // top, then one row split into two zones -
    //   left:  music - queue + now-playing title + time
    //   right (far right): render sliders (sens / fps / blur), then preset
    //          transport, then fullscreen / help
    this.toolbar = el("div", "mw-bar");

    // seek strip (position in the current track). Dragging scrubs; position
    // updates pause while `seeking` so the thumb doesn't fight the playhead.
    this.seekInput = el("input", "mw-seek");
    this.seekInput.type = "range";
    this.seekInput.min = "0";
    this.seekInput.max = "1000";
    this.seekInput.step = "1";
    this.seekInput.value = "0";
    this.seekInput.disabled = true;
    this.seekInput.title = "Seek";
    this.seekInput.onclick = (e) => e.stopPropagation();
    const beginSeek = () => {
      if (!this.seekInput.disabled) this.seeking = true;
    };
    this.seekInput.addEventListener("pointerdown", beginSeek);
    this.seekInput.oninput = () => {
      this.seeking = true;
    };
    this.seekInput.onchange = () => {
      this.seeking = false;
      cb.onSeek(parseInt(this.seekInput.value, 10) / 1000);
    };
    this.toolbar.appendChild(this.seekInput);

    const mainRow = el("div", "mw-main");
    const leftZone = el("div", "mw-zone mw-left");
    const rightZone = el("div", "mw-zone mw-right");
    mainRow.append(leftZone, rightZone);
    this.toolbar.appendChild(mainRow);

    const mkBtn = (
      label: string,
      title: string,
      fn: () => void,
      parent: HTMLElement = rightZone,
    ): HTMLButtonElement => {
      const b = el("button", "mw-btn", label);
      b.title = title;
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      parent.appendChild(b);
      return b;
    };

    // left zone: music - queue button + track transport + now-playing title + time
    mkBtn("♫", "Music queue", () => this.toggleQueue(), leftZone);
    // hi-fi style skip-to-track buttons (triangle + bar), flanking play/pause
    mkBtn("⏮", "Previous track", cb.onTrackPrev, leftZone);
    this.playPauseBtn = mkBtn("▶", "Play track", cb.onTrackPlayPause, leftZone);
    mkBtn("⏭", "Next track", cb.onTrackNext, leftZone);
    this.sourceEl = el("div", "mw-source", "-");
    this.sourceEl.title = "Now playing";
    leftZone.appendChild(this.sourceEl);
    this.seekTime = el("div", "mw-seektime", "0:00 / 0:00");
    leftZone.appendChild(this.seekTime);

    // right zone: render sliders, then preset transport, then window / help -
    // all in one zone so the gaps (and the separators) are uniform.

    // The render sliders live in their own container so they can be one inline
    // group on wide screens (display:contents → no extra box, same spacing) and
    // collapse into a ⚙-toggled panel on narrow ones (see the media query).
    this.render = el("div", "mw-render");
    rightZone.appendChild(this.render);

    // a labelled range control: small caption + slider + optional value readout
    const sliderGroup = (
      caption: string,
      input: HTMLInputElement,
      readout?: HTMLElement,
    ): void => {
      input.type = "range";
      input.onclick = (e) => e.stopPropagation();
      const g = el("div", "mw-grp");
      g.appendChild(el("span", "mw-lbl", caption));
      g.appendChild(input);
      if (readout) g.appendChild(readout);
      this.render.appendChild(g);
    };

    // audio sensitivity slider
    const sens = el("input", "mw-slider");
    sens.min = "0";
    sens.max = "3";
    sens.step = "0.05";
    sens.value = "1";
    sens.title = "Audio sensitivity";
    // readout is "current/max", mirroring the fps slider
    const sensVal = el(
      "div",
      "mw-sliderval",
      `${(+sens.value).toFixed(2)}/${sens.max}`,
    );
    sens.oninput = () => {
      sensVal.textContent = `${parseFloat(sens.value).toFixed(2)}/${sens.max}`;
      cb.onSensitivity(parseFloat(sens.value));
    };
    sliderGroup("sens", sens, sensVal);

    // frame-rate cap (0 = off / uncapped)
    const fps = el("input", "mw-slider");
    fps.min = "0";
    fps.max = "120";
    fps.step = "1";
    fps.value = "60";
    fps.title = "Frame-rate cap in Hz (0 = off)";
    // readout is "current/max" fps; the current half is pushed in via setFps()
    this.fpsReadout = el("div", "mw-sliderval mw-fpsval", "—/60");
    fps.oninput = () => {
      this.fpsCap = parseInt(fps.value, 10);
      this.setFps(this.lastFps);
      cb.onFpsCap(this.fpsCap);
    };
    sliderGroup("fps", fps, this.fpsReadout);

    // global output blur in CSS pixels (0 = off), same gaussian as the intro
    const blur = el("input", "mw-slider");
    blur.min = "0";
    blur.max = "40";
    blur.step = "1";
    blur.value = "0";
    blur.title = "Output blur (0 = off)";
    const blurPct = (px: number): string =>
      px === 0 ? "off" : `${Math.round((px / parseInt(blur.max, 10)) * 100)}%`;
    const blurVal = el("div", "mw-sliderval", blurPct(0));
    blur.oninput = () => {
      const px = parseInt(blur.value, 10);
      blurVal.textContent = blurPct(px);
      cb.onBlur(px);
    };
    sliderGroup("blur", blur, blurVal);

    // preset transport, divided from the sliders by a separator on its first button
    const listBtn = mkBtn(
      "☰",
      "Preset list / load",
      () => this.toggleList(),
      rightZone,
    );
    // divider from the sliders (dropped on narrow screens, where they're hidden)
    listBtn.classList.add("mw-sep", "mw-sep-list");
    mkBtn("◀", "Previous preset (←)", cb.onPrev, rightZone);
    this.freezeBtn = mkBtn("⏸", "Freeze (Space)", cb.onToggleFreeze, rightZone);
    mkBtn("▶", "Next preset (N / →)", cb.onNext, rightZone);
    this.hardCutBtn = mkBtn(
      "⚡",
      "Toggle hard cuts (H)",
      cb.onToggleHardCuts,
      rightZone,
    );

    // far right: window / help buttons (after the preset transport)
    const winBtn = mkBtn(
      "⛶",
      "Fullscreen (F)",
      cb.onToggleFullscreen,
      rightZone,
    );
    winBtn.classList.add("mw-sep"); // subtle divider from the preset controls
    // render-settings toggle: only visible on narrow screens (where the inline
    // sliders collapse into a panel); hidden by CSS on wide ones.
    const settingsBtn = mkBtn(
      "⚙",
      "Render settings",
      () => this.toggleSettings(),
      rightZone,
    );
    settingsBtn.classList.add("mw-settings-btn");
    mkBtn("?", "Keyboard shortcuts (?)", () => this.toggleHelp(), rightZone);
    this.root.appendChild(this.toolbar);

    // Publish the bar's live height as --mw-bar-h so the edge-docked side panels
    // (presets / queue) always sit just above it, however tall it gets when the
    // controls reflow into the compact stacked layout (see the media queries).
    const syncBarHeight = (): void =>
      this.root.style.setProperty(
        "--mw-bar-h",
        `${Math.round(this.toolbar.getBoundingClientRect().height)}px`,
      );
    new ResizeObserver(syncBarHeight).observe(this.toolbar);
    syncBarHeight();

    // The render-settings sliders flow inline in the bar's right zone when wide,
    // but become a ⚙-toggled popup when narrow. Re-home that element into the
    // centred popup stack as the compact breakpoint is crossed, so it centres and
    // stacks alongside the queue / preset menus instead of floating on its own.
    const compactMq = window.matchMedia("(max-width: 1050px)");
    const placeRender = (compact: boolean): void => {
      if (compact) this.popups.appendChild(this.render);
      else rightZone.insertBefore(this.render, rightZone.firstChild);
    };
    compactMq.addEventListener("change", (e) => placeRender(e.matches));
    placeRender(compactMq.matches);

    // keyboard-shortcut help overlay
    this.helpEl = el("div", "mw-help mw-hidden");
    this.helpEl.innerHTML = HELP_HTML;
    this.helpEl.onclick = () => this.toggleHelp();
    this.root.appendChild(this.helpEl);

    // hidden multi-file input for the queue's "Add music" button
    const musicInput = el("input");
    musicInput.type = "file";
    musicInput.accept = "audio/*";
    musicInput.multiple = true;
    musicInput.style.display = "none";
    musicInput.onchange = () => {
      const files = Array.from(musicInput.files ?? []);
      if (files.length) cb.onQueueFiles(files);
      musicInput.value = ""; // allow re-picking the same file
    };
    this.root.appendChild(musicInput);

    // hidden multi-file input for the list's "Load" button: same routing as
    // drag-and-drop, so presets / images / audio can be opened via a picker too
    const filesInput = el("input");
    filesInput.type = "file";
    filesInput.accept = ".milk,audio/*,image/*";
    filesInput.multiple = true;
    filesInput.style.display = "none";
    filesInput.onchange = () => {
      void routeFiles(Array.from(filesInput.files ?? []), this.ingest);
      filesInput.value = ""; // allow re-picking the same file
    };
    this.root.appendChild(filesInput);

    document.body.appendChild(this.root);
    setupDragDrop(this.ingest);
    this.setupIdleHide();

    // Esc closes whichever panel is open (clearing the preset search on the way)
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!this.list.classList.contains("mw-hidden")) {
        e.stopPropagation();
        this.searchInput.value = "";
        this.filter = "";
        this.renderList();
        this.toggleList(false);
      } else if (!this.queue.classList.contains("mw-hidden")) {
        e.stopPropagation();
        this.toggleQueue(false);
      } else if (this.render.classList.contains("mw-open")) {
        e.stopPropagation();
        this.render.classList.remove("mw-open");
      }
    });
  }

  /** Toggle the render-settings panel (only meaningful on narrow screens). */
  private toggleSettings(): void {
    this.render.classList.toggle("mw-open");
  }

  /** Update the fps slider's "current/max" readout (max comes from the cap slider). */
  setFps(current: number): void {
    this.lastFps = current;
    const max = this.fpsCap === 0 ? "∞" : String(this.fpsCap);
    this.fpsReadout.textContent = `${Math.round(current)}/${max}`;
  }

  /** Persistent indicator of the active audio source (file / silent). */
  setSource(label: string): void {
    this.sourceEl.textContent = label;
  }

  /** Reflect whether a track is currently playing on the play/pause button. */
  setPlaying(playing: boolean): void {
    this.playPauseBtn.textContent = playing ? "⏸" : "▶";
    this.playPauseBtn.title = playing ? "Pause track" : "Play track";
  }

  /**
   * Update the music seek bar's position and time readout. Pass a non-finite or
   * zero `duration` (e.g. no track playing) to disable and reset the bar. While
   * the user is dragging the bar, the position is left alone so it doesn't fight
   * the scrub.
   */
  setPlayback(current: number, duration: number): void {
    const has = Number.isFinite(duration) && duration > 0;
    this.seekInput.disabled = !has;
    if (!has) {
      this.seekInput.value = "0";
      this.seekTime.textContent = "0:00 / 0:00";
      return;
    }
    if (!this.seeking)
      this.seekInput.value = String(Math.round((current / duration) * 1000));
    this.seekTime.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
  }

  /** Reflect hard-cut on/off state on the toolbar button. */
  setHardCutState(on: boolean): void {
    this.hardCutBtn.classList.toggle("mw-on", on);
  }

  /** Reflect freeze on/off state on the toolbar button. */
  setFreezeState(on: boolean): void {
    this.freezeBtn.classList.toggle("mw-on", on);
    this.freezeBtn.textContent = on ? "▶" : "⏸";
    this.freezeBtn.title = on ? "Resume (Space)" : "Freeze (Space)";
  }

  /** Toggle the keyboard-shortcut help overlay. */
  toggleHelp(): void {
    this.helpEl.classList.toggle("mw-hidden");
  }

  /** Flash the preset name as a transient title overlay (auto-hides after ~2s). */
  showTitle(name: string): void {
    this.titleEl.textContent = name;
    this.titleEl.classList.add("mw-show");
    clearTimeout(this.titleTimer);
    this.titleTimer = window.setTimeout(
      () => this.titleEl.classList.remove("mw-show"),
      2200,
    );
  }

  /**
   * Show a transient notification toast (auto-dismisses after a few seconds).
   * Used to surface non-fatal problems such as a preset's shader failing to
   * compile and falling back to the no-shader path.
   */
  notify(message: string, durationMs = 5000): void {
    this.noticeEl.textContent = message;
    this.noticeEl.classList.add("mw-show");
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(
      () => this.noticeEl.classList.remove("mw-show"),
      durationMs,
    );
  }

  /** Populate the preset panel with `names` and highlight the `current` index. */
  setPresetList(names: string[], current: number): void {
    // The render loop calls this a couple of times a second (to refresh the FPS
    // readout / current highlight). Only rebuild the item DOM when the playlist
    // actually changed - otherwise just move the highlight. Rebuilding every
    // time destroys the item under the cursor and drops in-flight clicks, so a
    // selection would sometimes silently fail.
    const sameList =
      names.length === this.names.length &&
      names.every((n, i) => n === this.names[i]);
    this.names = names;
    this.currentIndex = current;
    this.listCount.textContent = String(names.length);
    if (sameList) this.highlightCurrent();
    else this.renderList();
  }

  /** Move the `mw-current` highlight to the active preset without rebuilding. */
  private highlightCurrent(): void {
    for (const child of this.listItems.children) {
      const item = child as HTMLElement;
      item.classList.toggle(
        "mw-current",
        Number(item.dataset.index) === this.currentIndex,
      );
    }
  }

  /** Show/hide the preset panel; focuses the search box when opening. */
  private toggleList(show?: boolean): void {
    const hidden = this.list.classList.contains("mw-hidden");
    const open = show ?? hidden;
    this.list.classList.toggle("mw-hidden", !open);
    if (open) {
      // bring the active preset into view and focus the filter for quick typing
      this.searchInput.focus();
      this.listItems
        .querySelector(".mw-current")
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  /** (Re)render the list items from the cached playlist + current filter. */
  private renderList(): void {
    this.listItems.replaceChildren();
    const q = this.filter;
    let shown = 0;
    this.names.forEach((name, i) => {
      if (q && !name.toLowerCase().includes(q)) return;
      shown++;
      const item = el(
        "div",
        "mw-item" + (i === this.currentIndex ? " mw-current" : ""),
        `${i + 1}. ${name}`,
      );
      item.title = name;
      item.dataset.index = String(i);
      item.onclick = (e) => {
        e.stopPropagation();
        this.cb.onJump(i);
      };
      this.listItems.appendChild(item);
    });
    if (shown === 0) {
      const msg = this.names.length
        ? "No presets match your search"
        : "No presets loaded yet";
      this.listItems.appendChild(el("div", "mw-empty", msg));
    }
  }

  /**
   * Update the music-queue panel. `current` is the index of the playing track
   * (or -1 when nothing is playing / the queue is empty).
   */
  setQueue(names: string[], current: number): void {
    this.queueCount.textContent = String(names.length);
    this.queueItems.replaceChildren();
    if (names.length === 0) {
      this.queueItems.appendChild(el("div", "mw-empty", "Queue is empty"));
      return;
    }
    names.forEach((name, i) => {
      const item = el("div", "mw-item" + (i === current ? " mw-current" : ""));
      const label = el("span", "mw-item-label", `${i + 1}. ${name}`);
      label.title = name;
      label.onclick = (e) => {
        e.stopPropagation();
        this.cb.onQueuePlay(i);
      };
      const del = el("button", "mw-item-del", "✕");
      del.title = "Remove from queue";
      del.onclick = (e) => {
        e.stopPropagation();
        this.cb.onQueueRemove(i);
      };
      item.append(label, del);
      this.queueItems.appendChild(item);
    });
  }

  /** Show/hide the music-queue panel; scrolls the playing track into view. */
  private toggleQueue(show?: boolean): void {
    const open = show ?? this.queue.classList.contains("mw-hidden");
    this.queue.classList.toggle("mw-hidden", !open);
    if (open)
      this.queueItems
        .querySelector(".mw-current")
        ?.scrollIntoView({ block: "nearest" });
  }

  /** Hide the cursor and overlay after a period of pointer inactivity. */
  private setupIdleHide(): void {
    const show = () => {
      this.root.classList.remove("mw-idle");
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(
        () => this.root.classList.add("mw-idle"),
        2500,
      );
    };
    // Reveal on mouse, keyboard, and touch/pen input. Without the pointer/touch
    // listeners the chrome would fade after 2.5s on touch devices and never come
    // back (no mousemove ever fires), leaving no way to reach the controls.
    window.addEventListener("mousemove", show);
    window.addEventListener("keydown", show);
    window.addEventListener("pointerdown", show);
    window.addEventListener("touchstart", show, { passive: true });
    show();
  }
}
