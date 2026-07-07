/**
 * The VS0/VS1 ping-pong feedback buffers - the heart of MilkDrop's look.
 *
 * Each frame we sample the previous frame (source) while rendering the warped
 * result into the other texture (target), then swap. RGBA16F avoids the decay
 * banding that RGBA8 feedback produces.
 */

/** The VS0/VS1 ping-pong feedback buffers (RGBA16F where supported). */
export class FrameBuffers {
  private gl: WebGL2RenderingContext;
  private tex: [WebGLTexture, WebGLTexture];
  private fbo: [WebGLFramebuffer, WebGLFramebuffer];
  private cur = 0; // index of the "target" (write) buffer
  width: number;
  height: number;
  private halfFloat: boolean;

  /** Allocate both ping-pong buffers at `width`×`height`. */
  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.halfFloat = gl.getExtension("EXT_color_buffer_float") !== null;
    this.tex = [this.makeTexture(), this.makeTexture()];
    this.fbo = [this.makeFbo(this.tex[0]), this.makeFbo(this.tex[1])];
  }

  /** The texture holding the previous frame (read this while warping). */
  get sourceTexture(): WebGLTexture {
    return this.tex[1 - this.cur]!;
  }

  /** Bind the write buffer as the render target. */
  bindTarget(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]!);
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Bind the previous-frame buffer for drawing. Motion vectors draw into it
   * just before the warp samples it (the original's DrawMotionVectors → VS0),
   * so they get warped on this very frame.
   */
  bindSource(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1 - this.cur]!);
    gl.viewport(0, 0, this.width, this.height);
  }

  /** The texture just rendered into (read this for the composite). */
  get targetTexture(): WebGLTexture {
    return this.tex[this.cur]!;
  }

  /** Flip source and target - call once per frame after compositing. */
  swap(): void {
    this.cur = 1 - this.cur;
  }

  /** Reallocate both buffers to a new size; no-op if unchanged. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const gl = this.gl;
    for (const t of this.tex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      this.allocStorage();
    }
  }

  private allocStorage(): void {
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

  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.allocStorage();
    return t;
  }

  private makeFbo(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("createFramebuffer failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  /** Clear both buffers to black (used on first frame / preset load). */
  clear(): void {
    const gl = this.gl;
    for (const fbo of this.fbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
