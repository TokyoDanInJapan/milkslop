/**
 * Static presentation assets for the overlay UI: the injected stylesheet and
 * the keyboard-shortcut help markup. Kept out of ui.ts so the widget/wiring
 * logic there stays readable.
 */

import { el } from "./dom.ts";

/** Markup for the keyboard-shortcut help overlay. */
export const HELP_HTML = `
  <div class="mw-help-card">
    <h3>Keyboard shortcuts</h3>
    <dl>
      <dt>N · →</dt><dd>Next preset</dd>
      <dt>←</dt><dd>Previous preset</dd>
      <dt>Space</dt><dd>Freeze / resume</dd>
      <dt>H</dt><dd>Toggle hard cuts</dd>
      <dt>F</dt><dd>Fullscreen</dd>
      <dt>?</dt><dd>Toggle this help</dd>
    </dl>
    <p>Drag in <b>.milk</b> presets or <b>audio</b> files to queue.</p>
    <p class="mw-help-note">Drop image files to supply textures presets can
      sample - <code>foo.jpg</code> becomes <code>sampler_foo</code>.</p>
    <small>Click anywhere to dismiss</small>
  </div>`;

/** Inject the overlay's stylesheet once (idempotent). */
export function injectStyles(): void {
  if (document.getElementById("mw-ui-style")) return;
  const s = el("style");
  s.id = "mw-ui-style";
  s.textContent = `
  .mw-ui { position: fixed; inset: 0; pointer-events: none; font: 13px system-ui, sans-serif; color: #e8e8f0; z-index: 10; transition: opacity .4s; }
  .mw-ui.mw-idle { opacity: 0; }
  /* full-width media bar pinned to the bottom edge */
  .mw-bar { position: absolute; left: 0; right: 0; bottom: 0;
    display: flex; flex-direction: column; gap: 8px; padding: 9px 16px 11px;
    background: rgba(16,16,24,.62); backdrop-filter: blur(10px);
    border-top: 1px solid rgba(255,255,255,.12); pointer-events: auto; }
  /* two zones sized to content; the left zone's auto margin pushes the right
     zone (sliders + transport) to the far right. No flex-grow → no
     shrink-overflow, so nothing overlaps; when it can't fit, zones wrap. */
  .mw-main { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; width: 100%; }
  .mw-zone { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 0 1 auto; }
  .mw-left { margin-right: auto; }
  .mw-right { margin-left: auto; }
  .mw-btn { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: #e8e8f0;
    width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 15px; line-height: 1; flex: none;
    display: inline-flex; align-items: center; justify-content: center; padding: 0; }
  .mw-btn:hover { background: rgba(255,255,255,.16); }
  .mw-btn.mw-on { background: #5a4; border-color: #7c6; }
  .mw-btn.mw-sep { margin-left: 28px; }
  .mw-btn.mw-sep::before { content: ""; position: absolute; left: -18px; top: 4px; bottom: 4px;
    border-left: 1px solid rgba(255,255,255,.14); }
  .mw-btn.mw-sep { position: relative; }
  .mw-source { flex: 0 1 auto; min-width: 0; max-width: 320px; text-align: left; opacity: .9; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* seek bar spans the full bar width along the top */
  .mw-seek { width: 100%; accent-color: #8a9cff; cursor: pointer; }
  .mw-seek:disabled { opacity: .3; cursor: default; }
  .mw-seektime { flex: none; min-width: 82px; text-align: left; font-size: 11px; opacity: .7;
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mw-grp { display: inline-flex; align-items: center; gap: 5px; }
  .mw-lbl { font-size: 10px; opacity: .55; text-transform: uppercase; letter-spacing: .05em; }
  .mw-slider { width: 70px; accent-color: #8a9cff; cursor: pointer; }
  .mw-sliderval { min-width: 24px; text-align: center; opacity: .85; font-variant-numeric: tabular-nums; }
  .mw-fpsval { min-width: 52px; }
  /* render-slider container: no box on wide screens, so the three groups flow
     inline in the right zone exactly as if they were direct children */
  .mw-render { display: contents; }
  .mw-settings-btn { display: none; } /* ⚙ only appears on narrow screens */
  /* Wide: the wrapper vanishes so each panel positions itself against a screen
     edge. Narrow: it becomes a centred stack above the bar (see the media query). */
  .mw-popups { display: contents; }
  /* Side panels float as rounded cards just above the bottom bar, inset from the
     screen edge and styled to match the render-settings popup (presets right,
     queue left). The bar's height varies (single row when wide, two stacked rows
     when compact, taller still for coarse pointers), so we anchor to its live
     height via --mw-bar-h (kept in sync by a ResizeObserver) plus an 8px gap -
     otherwise the taller compact bar would hide the panels behind it. */
  .mw-list { position: absolute; right: 8px; bottom: calc(var(--mw-bar-h, 81px) + 8px); width: 280px;
    max-height: calc(100vh - var(--mw-bar-h, 81px) - 16px);
    display: flex; flex-direction: column; overflow: hidden;
    background: rgba(16,16,24,.62); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
    pointer-events: auto; }
  .mw-list.mw-hidden { display: none; }
  .mw-list-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; }
  .mw-list-title { font-weight: 600; font-size: 13px; letter-spacing: .02em; }
  .mw-list-count { font-size: 11px; opacity: .6; background: rgba(255,255,255,.1);
    padding: 1px 7px; border-radius: 999px; font-variant-numeric: tabular-nums; }
  /* loading throbber (URL preset fetch in progress) */
  .mw-spinner { flex: none; width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.25); border-top-color: #8a9cff;
    animation: mw-spin .7s linear infinite; }
  .mw-spinner.mw-hidden { display: none; }
  @keyframes mw-spin { to { transform: rotate(360deg); } }
  .mw-list-close { margin-left: auto; width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
    background: transparent; border: none; color: #e8e8f0; opacity: .55; font-size: 13px; line-height: 1; }
  .mw-list-close:hover { opacity: 1; background: rgba(255,255,255,.12); }
  .mw-search { margin: 0 12px 8px; padding: 7px 10px; border-radius: 8px; font: inherit; font-size: 12px;
    color: #e8e8f0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); outline: none; }
  .mw-search:focus { border-color: rgba(138,156,255,.7); background: rgba(255,255,255,.09); }
  .mw-search::placeholder { color: rgba(232,232,240,.4); }
  .mw-items { flex: 1; overflow-y: auto; padding: 0 6px; min-height: 0; }
  .mw-item { padding: 6px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mw-item:hover { background: rgba(255,255,255,.1); }
  .mw-item.mw-current { background: rgba(120,140,255,.25); box-shadow: inset 2px 0 0 #8a9cff; }
  .mw-queue { left: 8px; right: auto; }
  .mw-queue .mw-item { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 10px; }
  .mw-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mw-item-del { flex: none; width: 22px; height: 22px; border-radius: 6px; border: none; cursor: pointer;
    background: transparent; color: #e8e8f0; opacity: 0; font-size: 11px; line-height: 1; }
  .mw-queue .mw-item:hover .mw-item-del { opacity: .55; }
  .mw-item-del:hover { opacity: 1; background: rgba(255,120,120,.28); }
  .mw-empty { padding: 18px 10px; text-align: center; font-size: 12px; opacity: .45; }
  .mw-load { margin: 8px 12px 12px; padding: 9px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px;
    font-weight: 500; color: #cdd4ff; background: rgba(120,140,255,.16); border: 1px solid rgba(120,140,255,.4); }
  .mw-load:hover { background: rgba(120,140,255,.28); color: #fff; }
  /* always-visible "load from URL" row: text field + Load button */
  .mw-urlrow { display: flex; gap: 6px; margin: 0 12px 12px; }
  .mw-urlinput { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 8px; font: inherit; font-size: 12px;
    color: #e8e8f0; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); outline: none; }
  .mw-urlinput:focus { border-color: rgba(138,156,255,.7); background: rgba(255,255,255,.09); }
  .mw-urlinput::placeholder { color: rgba(232,232,240,.4); }
  .mw-urlgo { flex: none; padding: 7px 12px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px;
    font-weight: 500; color: #cdd4ff; background: rgba(120,140,255,.16); border: 1px solid rgba(120,140,255,.4); }
  .mw-urlgo:hover { background: rgba(120,140,255,.28); color: #fff; }
  .mw-title { position: absolute; left: 50%; top: 12%; transform: translateX(-50%);
    font-size: clamp(20px, 4vw, 42px); font-weight: 600; letter-spacing: .02em;
    text-shadow: 0 2px 16px rgba(0,0,0,.8); opacity: 0; transition: opacity .5s; }
  .mw-title.mw-show { opacity: .95; }
  .mw-notice { position: absolute; left: 50%; top: 24px; transform: translateX(-50%);
    max-width: 80vw; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500;
    background: rgba(120,30,30,.82); color: #ffe6e6; border: 1px solid rgba(255,120,120,.5);
    box-shadow: 0 2px 16px rgba(0,0,0,.5); text-align: center; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity .4s;
    pointer-events: none; }
  .mw-notice.mw-show { opacity: 1; }
  .mw-help { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(8,8,14,.55); backdrop-filter: blur(3px); pointer-events: auto; z-index: 15; }
  .mw-help.mw-hidden { display: none; }
  .mw-help-card { background: rgba(16,16,24,.92); border: 1px solid rgba(255,255,255,.14);
    border-radius: 14px; padding: 22px 28px; max-width: 360px; box-shadow: 0 8px 40px rgba(0,0,0,.6); }
  .mw-help-card h3 { margin: 0 0 12px; font-size: 16px; }
  .mw-help-card dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
  .mw-help-card dt { font-weight: 600; color: #b9c2ff; white-space: nowrap; }
  .mw-help-card dd { margin: 0; opacity: .9; }
  .mw-help-card p { margin: 14px 0 4px; opacity: .85; font-size: 12px; }
  .mw-help-note { margin-top: 6px !important; opacity: .6 !important; }
  .mw-help-card code { padding: 1px 5px; border-radius: 4px; font-size: .92em;
    background: rgba(255,255,255,.1); }
  .mw-help-card small { opacity: .55; font-size: 11px; }
  @media (pointer: coarse) {
    .mw-btn { width: 42px; height: 42px; font-size: 18px; }
    /* taller touch bar is tracked by --mw-bar-h, so the side panels follow it */
    .mw-slider { width: 72px; }
  }
  /* Once the single wide strip can no longer fit on one line (~1048px with the
     current controls) it would otherwise wrap into two ragged rows - music
     transport stranded above the sliders. Instead, switch the whole bar over at
     that point: stack into two centred rows of icon buttons (music transport,
     then preset transport + window), drop the now-playing text, and collapse the
     render sliders into a panel toggled by the ⚙ button. */
  @media (max-width: 1050px) {
    .mw-main { flex-direction: column; align-items: center; gap: 8px; }
    .mw-zone { justify-content: center; flex-wrap: wrap; }
    .mw-left, .mw-right { margin: 0; }
    /* seek bar already conveys playback position, so the title/time are redundant */
    .mw-source, .mw-seektime { display: none; }
    .mw-settings-btn { display: inline-flex; }
    /* tighten the remaining (preset↔window) divider for the cramped row, and
       centre the divider line in the 22px gap (8px flex gap + 14px margin) so it
       sits equidistant from the hard-cut and fullscreen buttons either side */
    .mw-btn.mw-sep { margin-left: 14px; }
    .mw-btn.mw-sep::before { left: -12px; }
    /* the sliders↔presets divider is meaningless once the sliders are hidden -
       listed last and equally specific so it overrides the compact rule above */
    .mw-btn.mw-sep-list { margin-left: 0; }
    .mw-btn.mw-sep-list::before { display: none; }
    /* Every open menu collects in a centred column above the bar (the .mw-popups
       wrapper, normally display:contents, turns into this flex stack) so that
       multiple open at once stack with a gap instead of overlapping or splitting
       to opposite edges. pointer-events:none lets clicks fall through the gaps. */
    .mw-popups { position: absolute; left: 0; right: 0; top: 8px;
      bottom: calc(var(--mw-bar-h, 81px) + 8px);
      display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
      gap: 8px; overflow: hidden; pointer-events: none; }
    .mw-popups > * { position: static; left: auto; right: auto; bottom: auto;
      max-height: 60vh; max-width: calc(100vw - 16px); pointer-events: auto; }
    /* sliders hidden inline; revealed as a card in the stack on ⚙ */
    .mw-render { display: none; }
    .mw-render.mw-open { display: flex; flex-direction: column; align-items: stretch;
      gap: 12px; padding: 12px 14px;
      background: rgba(16,16,24,.62); backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,.12); border-radius: 10px; }
    /* Lay each row on a shared 3-column grid (label / slider / readout) with fixed
       column widths, so the sliders start and end at the same x down the menu
       regardless of differing label and readout widths. */
    .mw-render.mw-open .mw-grp { display: grid; grid-template-columns: 34px 150px 52px;
      align-items: center; gap: 10px; }
    .mw-render.mw-open .mw-slider { width: 100%; margin: 0; }
  }
  body.mw-drag::after { content: "drop .milk presets, audio, or image textures"; position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center; font: 600 24px system-ui;
    color: #fff; background: rgba(40,60,120,.4); border: 3px dashed rgba(255,255,255,.5); z-index: 20; pointer-events: none; }
  `;
  document.head.appendChild(s);
}
