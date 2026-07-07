/**
 * State shared across all preset code that runs against the same "world".
 *
 * @remarks
 * MilkDrop keeps two pieces of state alive between presets so a new preset can
 * read values a previous one left behind:
 *
 * - `gmegabuf` - the global RAM block (`gmem`), shared by every preset.
 * - `reg00..reg99` - 100 global registers, persisted across presets.
 *
 * A fresh {@link Globals} instance is convenient for isolated unit tests.
 */

import { Megabuf } from "./megabuf.ts";

/** The cross-preset global RAM block and register file. */
export class Globals {
  /** The global RAM block (`gmegabuf` / `gmem`). */
  readonly gmegabuf = new Megabuf();
  /** The 100 global registers `reg00`..`reg99`. */
  readonly regs = new Float64Array(100);

  /** Clear the global RAM block and zero all registers. */
  reset(): void {
    this.gmegabuf.free();
    this.regs.fill(0);
  }
}

/**
 * Classify a variable name as a global register `reg00`..`reg99`.
 *
 * @param name - Lower-cased variable name.
 * @returns The register index 0–99, or `-1` if `name` is not a global register.
 */
export function globalRegIndex(name: string): number {
  if (name.length === 5 && name.startsWith("reg")) {
    const a = name.charCodeAt(3);
    const b = name.charCodeAt(4);
    if (a >= 48 && a <= 57 && b >= 48 && b <= 57) {
      return (a - 48) * 10 + (b - 48);
    }
  }
  return -1;
}
