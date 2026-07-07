/**
 * A single colour texture + framebuffer (RGBA16F where supported). Used for the
 * blur chain and any intermediate render targets.
 */

/** A single colour texture plus its framebuffer (an off-screen render target). */
export class RenderTarget {
  /** The colour texture backing this target. */
  readonly tex: WebGLTexture;
  /** The framebuffer that renders into {@link tex}. */
  readonly fbo: WebGLFramebuffer;
  /** Current target width in pixels. */
  width: number;
  /** Current target height in pixels. */
  height: number;
  private gl: WebGL2RenderingContext;
  private halfFloat: boolean;

  /**
   * Allocate the texture and framebuffer. `wrapRepeat` selects `REPEAT`
   * wrapping (vs the default `CLAMP_TO_EDGE`). Dimensions are clamped to ≥1.
   */
  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    wrapRepeat = false,
  ) {
    this.gl = gl;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.halfFloat = gl.getExtension("EXT_color_buffer_float") !== null;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = wrapRepeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    this.alloc();
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.tex,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Bind this target's framebuffer and set the viewport to its size. */
  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
  }

  /** Reallocate the texture to a new size (clamped to ≥1); no-op if unchanged. */
  resize(width: number, height: number): void {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
    this.alloc();
  }

  private alloc(): void {
    const gl = this.gl;
    const internal = this.halfFloat ? gl.RGBA16F : gl.RGBA8;
    const type = this.halfFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internal,
      this.width,
      this.height,
      0,
      gl.RGBA,
      type,
      null,
    );
  }
}
