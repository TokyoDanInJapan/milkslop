/**
 * Pure warp-mesh math, ported 1:1 from CPlugin::ComputeGridAlphaValues
 * (milkdropfs.cpp). Kept free of WebGL so it can be unit-tested in node.
 *
 * For each grid vertex the per-pixel equations may modify zoom/rot/warp/cx/cy/
 * dx/dy/sx/sy; this module turns those per-vertex values into the texture
 * coordinates used to sample the previous frame.
 */

import { constants } from "../config.ts";

/** Aspect-ratio correction factors and their inverses. */
export interface Aspect {
  aspectX: number;
  aspectY: number;
  invAspectX: number;
  invAspectY: number;
}

/**
 * Compute the aspect-ratio correction (milkdropfs.cpp:3953): the shorter screen
 * dimension maps fully to [-1, 1].
 *
 * @param width - Render-target width in pixels.
 * @param height - Render-target height in pixels.
 * @returns The aspect factors and their inverses.
 */
export function computeAspect(width: number, height: number): Aspect {
  let aspectX = 1;
  let aspectY = 1;
  if (width > height) aspectY = height / width;
  else aspectX = width / height;
  return { aspectX, aspectY, invAspectX: 1 / aspectX, invAspectY: 1 / aspectY };
}

/** Per-vertex displacement parameters (after the per_pixel equations run). */
export interface WarpParams {
  zoom: number;
  zoomExp: number;
  rot: number;
  warp: number;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

/** Frame-global warp inputs (constant across all grid vertices). */
export interface WarpFrame {
  warpTime: number; // GetTime() * warp_anim_speed
  warpScaleInv: number; // 1 / warp_scale
  f: [number, number, number, number]; // animated warp coefficients
  texelOffsetX: number; // 0.5 / texSizeX
  texelOffsetY: number; // 0.5 / texSizeY
}

/**
 * The four animated warp coefficients (milkdropfs.cpp:1785).
 *
 * @param warpTime - `GetTime() * warp_anim_speed`.
 * @returns The four coefficients `f[0..3]`.
 */
export function warpCoefficients(
  warpTime: number,
): [number, number, number, number] {
  const [c0, c1, c2, c3] = constants.warp.coefficients;
  const f = ([base, amp, freq, phase]: [number, number, number, number]) =>
    base + amp * Math.cos(warpTime * freq + phase);
  return [f(c0!), f(c1!), f(c2!), f(c3!)];
}

/**
 * Polar `rad`/`ang` for a base grid vertex (cf. `UvToMathSpace`,
 * milkdropfs.cpp:3862). `rad` is 0 at the centre and 1 at the corners.
 *
 * @param nx - Clip-space x in [-1, 1].
 * @param ny - Clip-space y in [-1, 1].
 * @param a - Aspect correction.
 * @returns The vertex radius and angle.
 */
export function vertexRadAng(
  nx: number,
  ny: number,
  a: Aspect,
): { rad: number; ang: number } {
  const px = nx * a.aspectX;
  const py = -ny * a.aspectY; // math-space y is flipped (see UV formula)
  const rad =
    Math.sqrt(px * px + py * py) /
    Math.sqrt(a.aspectX * a.aspectX + a.aspectY * a.aspectY);
  const ang = Math.atan2(py, px);
  return { rad, ang };
}

/**
 * Compute the warped (u,v) sample coordinate for one grid vertex.
 * nx, ny: base vertex position in clip space [-1,1]. rad: precomputed radius.
 * Mirrors milkdropfs.cpp:1877-1920 exactly.
 */
export function computeWarpUV(
  nx: number,
  ny: number,
  rad: number,
  p: WarpParams,
  frame: WarpFrame,
  a: Aspect,
): { u: number; v: number } {
  const zoom2 = Math.pow(p.zoom, Math.pow(p.zoomExp, rad * 2.0 - 1.0));
  const zoom2Inv = 1.0 / zoom2;

  let u = nx * a.aspectX * 0.5 * zoom2Inv + 0.5;
  let v = -ny * a.aspectY * 0.5 * zoom2Inv + 0.5;

  // stretch on x/y about (cx,cy)
  u = (u - p.cx) / p.sx + p.cx;
  v = (v - p.cy) / p.sy + p.cy;

  // animated warp
  const w = p.warp * 0.0035;
  const fsi = frame.warpScaleInv;
  const wt = frame.warpTime;
  const [f0, f1, f2, f3] = frame.f;
  u += w * Math.sin(wt * 0.333 + fsi * (nx * f0 - ny * f3));
  v += w * Math.cos(wt * 0.375 - fsi * (nx * f2 + ny * f1));
  u += w * Math.cos(wt * 0.753 - fsi * (nx * f1 - ny * f2));
  v += w * Math.sin(wt * 0.825 + fsi * (nx * f0 + ny * f3));

  // rotation about (cx,cy)
  const u2 = u - p.cx;
  const v2 = v - p.cy;
  const cosR = Math.cos(p.rot);
  const sinR = Math.sin(p.rot);
  u = u2 * cosR - v2 * sinR + p.cx;
  v = u2 * sinR + v2 * cosR + p.cy;

  // translation
  u -= p.dx;
  v -= p.dy;

  // undo aspect
  u = (u - 0.5) * a.invAspectX + 0.5;
  v = (v - 0.5) * a.invAspectY + 0.5;

  // half-texel offset
  u += frame.texelOffsetX;
  v += frame.texelOffsetY;

  return { u, v };
}
