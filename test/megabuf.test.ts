import { describe, it, expect } from "vitest";
import { Megabuf, MEGABUF_SIZE } from "../src/eel/megabuf.ts";

describe("Megabuf", () => {
  it("reads 0 from never-written cells and stores/reads back", () => {
    const m = new Megabuf();
    expect(m.get(1234)).toBe(0);
    m.set(1234, 42);
    expect(m.get(1234)).toBe(42);
  });

  it("floors fractional indices", () => {
    const m = new Megabuf();
    m.set(10.0, 7);
    expect(m.get(10.9)).toBe(7);
    expect(m.get(10.0)).toBe(7);
  });

  it("ignores out-of-range access (no throw, returns 0)", () => {
    const m = new Megabuf();
    expect(m.get(-1)).toBe(0);
    expect(m.get(MEGABUF_SIZE)).toBe(0);
    expect(m.get(MEGABUF_SIZE + 100)).toBe(0);
    expect(() => m.set(-5, 1)).not.toThrow();
    expect(() => m.set(MEGABUF_SIZE + 5, 1)).not.toThrow();
  });

  it("memset fills a run", () => {
    const m = new Megabuf();
    m.memset(100, 3, 5);
    for (let i = 100; i < 105; i++) expect(m.get(i)).toBe(3);
    expect(m.get(105)).toBe(0);
  });

  it("memcpy copies forward without self-overlap corruption", () => {
    const m = new Megabuf();
    for (let i = 0; i < 4; i++) m.set(i, i + 1); // [1,2,3,4]
    m.memcpy(10, 0, 4);
    expect([m.get(10), m.get(11), m.get(12), m.get(13)]).toEqual([1, 2, 3, 4]);
  });

  it("memcpy handles overlapping ranges (dest > src)", () => {
    const m = new Megabuf();
    for (let i = 0; i < 4; i++) m.set(i, i + 1); // [1,2,3,4] at 0..3
    m.memcpy(2, 0, 4); // copy [1,2,3,4] to 2..5
    expect([m.get(2), m.get(3), m.get(4), m.get(5)]).toEqual([1, 2, 3, 4]);
  });

  it("free() releases storage (cells read back as 0)", () => {
    const m = new Megabuf();
    m.set(500, 9);
    m.free();
    expect(m.get(500)).toBe(0);
  });

  it("spans block boundaries (65536)", () => {
    const m = new Megabuf();
    m.set(65535, 11);
    m.set(65536, 22); // next block
    expect(m.get(65535)).toBe(11);
    expect(m.get(65536)).toBe(22);
  });
});
