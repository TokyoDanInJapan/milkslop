import { describe, it, expect } from "vitest";
import { listWindow } from "../src/app/listWindow.ts";

const MAX = 300;

describe("listWindow", () => {
  it("renders everything when the list fits", () => {
    expect(listWindow(10, 3, MAX)).toEqual({ start: 0, end: 10 });
    expect(listWindow(MAX, 0, MAX)).toEqual({ start: 0, end: MAX });
  });

  it("handles an empty list", () => {
    expect(listWindow(0, -1, MAX)).toEqual({ start: 0, end: 0 });
  });

  it("renders a full window of exactly `max` rows when truncating", () => {
    const w = listWindow(5000, 2500, MAX);
    expect(w.end - w.start).toBe(MAX);
  });

  it("centres the window on the active preset", () => {
    const w = listWindow(5000, 2500, MAX);
    expect(w.start).toBe(2500 - MAX / 2);
    expect(2500).toBeGreaterThanOrEqual(w.start);
    expect(2500).toBeLessThan(w.end);
  });

  it("clamps to the start of the list near the top", () => {
    const w = listWindow(5000, 10, MAX);
    expect(w.start).toBe(0);
    expect(w.end).toBe(MAX);
    expect(10).toBeLessThan(w.end);
  });

  it("clamps to the end of the list near the bottom", () => {
    const w = listWindow(5000, 4999, MAX);
    expect(w.end).toBe(5000);
    expect(w.start).toBe(5000 - MAX);
    expect(4999).toBeGreaterThanOrEqual(w.start);
  });

  it("keeps the active preset inside the window wherever it sits", () => {
    for (const pos of [0, 1, 149, 150, 151, 2500, 4848, 4999]) {
      const w = listWindow(5000, pos, MAX);
      expect(pos, `pos ${pos}`).toBeGreaterThanOrEqual(w.start);
      expect(pos, `pos ${pos}`).toBeLessThan(w.end);
    }
  });

  it("falls back to the head of the list when the active preset is filtered out", () => {
    const w = listWindow(5000, -1, MAX);
    expect(w).toEqual({ start: 0, end: MAX });
  });

  it("renders nothing when the cap is zero", () => {
    expect(listWindow(5000, 10, 0)).toEqual({ start: 0, end: 0 });
  });
});
