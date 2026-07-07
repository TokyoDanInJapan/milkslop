/**
 * NS-EEL RAM (`megabuf` / `gmegabuf`): a large, lazily-allocated array of
 * doubles.
 *
 * @remarks
 * Faithful to `ns-eel2/nseel-ram.c`: addresses are floored to integers, reads of
 * never-written cells return 0, and storage is allocated in blocks on demand.
 * The global cap matches ns-eel's default of 128 blocks × 65536 = 8,388,608
 * slots.
 */

import { constants } from "../config.ts";

const BLOCK = constants.eel.megabufBlock;
const MAX_BLOCKS = constants.eel.megabufMaxBlocks;

/** Total addressable size of a {@link Megabuf} (128 × 65536). */
export const MEGABUF_SIZE = BLOCK * MAX_BLOCKS;

/**
 * A sparse, block-allocated array of `f64` cells implementing the `megabuf` /
 * `gmegabuf` intrinsics and `memset` / `memcpy` / `freembuf`.
 */
export class Megabuf {
  private blocks: (Float64Array | undefined)[] = new Array<
    Float64Array | undefined
  >(MAX_BLOCKS);

  /**
   * Read the cell at a (floored) index.
   *
   * @param index - Address; fractional values are floored.
   * @returns The stored value, or 0 if out of range or never written.
   */
  get(index: number): number {
    const i = Math.floor(index);
    if (i < 0 || i >= MEGABUF_SIZE) return 0;
    const b = this.blocks[(i / BLOCK) | 0];
    return b ? b[i % BLOCK]! : 0;
  }

  /**
   * Write a value at a (floored) index. Out-of-range writes are ignored.
   *
   * @param index - Address; fractional values are floored.
   * @param value - Value to store.
   * @returns `value` (so the intrinsic can be used as an expression).
   */
  set(index: number, value: number): number {
    const i = Math.floor(index);
    if (i < 0 || i >= MEGABUF_SIZE) return value;
    const bi = (i / BLOCK) | 0;
    let b = this.blocks[bi];
    if (!b) {
      b = new Float64Array(BLOCK);
      this.blocks[bi] = b;
    }
    b[i % BLOCK] = value;
    return value;
  }

  /**
   * Fill `len` cells starting at `dest` with `value` (the `memset` intrinsic).
   *
   * @param dest - First address to write.
   * @param value - Value to write into each cell.
   * @param len - Number of cells to fill.
   * @returns `dest`.
   */
  memset(dest: number, value: number, len: number): number {
    const d = Math.floor(dest);
    const n = Math.floor(len);
    for (let k = 0; k < n; k++) this.set(d + k, value);
    return dest;
  }

  /**
   * Copy `len` cells from `src` to `dest` (the `memcpy` intrinsic). Handles
   * overlapping ranges.
   *
   * @param dest - Destination start address.
   * @param src - Source start address.
   * @param len - Number of cells to copy.
   * @returns `dest`.
   */
  memcpy(dest: number, src: number, len: number): number {
    const d = Math.floor(dest);
    const s = Math.floor(src);
    const n = Math.floor(len);
    if (d < s) {
      for (let k = 0; k < n; k++) this.set(d + k, this.get(s + k));
    } else {
      for (let k = n - 1; k >= 0; k--) this.set(d + k, this.get(s + k));
    }
    return dest;
  }

  /**
   * Release all storage (the `freembuf` intrinsic); every cell subsequently
   * reads back as 0.
   */
  free(): void {
    this.blocks = new Array<Float64Array | undefined>(MAX_BLOCKS);
  }
}
