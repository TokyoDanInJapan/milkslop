/**
 * Per-context variable store: a dense, growable `Float64Array` indexed by name.
 *
 * @remarks
 * Variables persist across frames within one preset (e.g. `q1..q32` set in
 * `per_frame` and read in `per_pixel`; user vars carried frame-to-frame). The
 * host reads/writes named slots around each run (cf. `LoadPerFrameEvallibVars`).
 */
export class VarPool {
  /** Backing storage; reallocated (and reassigned) when the pool grows. */
  buf: Float64Array;
  private map = new Map<string, number>();
  private count = 0;

  /**
   * @param initialCapacity - Starting number of slots before the first grow.
   */
  constructor(initialCapacity = 64) {
    this.buf = new Float64Array(initialCapacity);
  }

  /**
   * Get the backing-array index for a variable, allocating a slot on first use.
   *
   * @param name - Lower-cased variable name.
   * @returns The stable slot index into {@link buf}.
   */
  index(name: string): number {
    let idx = this.map.get(name);
    if (idx === undefined) {
      idx = this.count++;
      if (idx >= this.buf.length) this.grow(idx + 1);
      this.map.set(name, idx);
    }
    return idx;
  }

  /**
   * @param name - Lower-cased variable name.
   * @returns Whether a slot has been allocated for `name`.
   */
  has(name: string): boolean {
    return this.map.has(name);
  }

  /**
   * Read a variable's value.
   *
   * @param name - Lower-cased variable name.
   * @returns The current value, or 0 if the variable has never been used.
   */
  get(name: string): number {
    const idx = this.map.get(name);
    return idx === undefined ? 0 : this.buf[idx]!;
  }

  /**
   * Write a variable's value, allocating a slot if needed.
   *
   * @param name - Lower-cased variable name.
   * @param value - Value to store.
   */
  set(name: string, value: number): void {
    this.buf[this.index(name)] = value;
  }

  /**
   * @returns An iterator over the names currently allocated (for diagnostics).
   */
  names(): IterableIterator<string> {
    return this.map.keys();
  }

  /** Zero every allocated slot (used on preset (re)initialisation). */
  clearValues(): void {
    this.buf.fill(0);
  }

  private grow(min: number): void {
    let cap = this.buf.length * 2;
    while (cap < min) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.buf);
    this.buf = next;
  }
}
