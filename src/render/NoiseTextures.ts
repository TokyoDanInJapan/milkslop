/**
 * Pre-generated noise textures matching the MilkDrop noise samplers, ported
 * from CPlugin::AddNoiseTex / AddNoiseVol (plugin.cpp:2419, 2553).
 *
 * MilkDrop generates six distinct textures that differ by *feature size*, not
 * resolution: a `zoom_factor` controls how many texels share an interpolated
 * cell (1 = pure per-texel random; 4/8 = random values every N texels with
 * cubic interpolation between, giving progressively smoother, larger blobs).
 *
 *   sampler_noise_lq       256×256 2D, zoom 1  (sharp)
 *   sampler_noise_mq       256×256 2D, zoom 4
 *   sampler_noise_hq       256×256 2D, zoom 8  (smoothest)
 *   sampler_noise_lq_lite   32×32  2D, zoom 1
 *   sampler_noisevol_lq     32³    3D, zoom 1
 *   sampler_noisevol_hq     32³    3D, zoom 4
 *
 * The pure generators (`generateNoise2D` / `generateNoise3D`) are unit-tested;
 * the exported factory uploads them as RGBA8 textures with mipmaps.
 */

/** The six noise textures bound to the MilkDrop noise samplers. */
export interface NoiseTextures {
  noiseLQ: WebGLTexture; // 256×256, zoom 1
  noiseMQ: WebGLTexture; // 256×256, zoom 4
  noiseHQ: WebGLTexture; // 256×256, zoom 8
  noiseLQLite: WebGLTexture; // 32×32, zoom 1
  noiseVolLQ: WebGLTexture; // 32³, zoom 1
  noiseVolHQ: WebGLTexture; // 32³, zoom 4
}

/**
 * Cubic interpolation through four samples, 1:1 with `fCubicInterpolate`
 * (plugin.cpp:2382). `t` runs 0→1 from `y1` toward `y2`.
 *
 * @returns The interpolated value (not clamped).
 */
export function cubicInterpolate(
  y0: number,
  y1: number,
  y2: number,
  y3: number,
  t: number,
): number {
  const t2 = t * t;
  const a0 = y3 - y2 - y0 + y1;
  const a1 = y0 - y1 - a0;
  const a2 = y2 - y0;
  const a3 = y1;
  return a0 * t * t2 + a1 * t2 + a2 * t + a3;
}

/** A 0..1 random source (injectable so generation is unit-testable). */
export type Rand = () => number;

function randByte(rand: Rand, range: number): number {
  // ((rand % RANGE) + RANGE/2), truncated to a byte - matches the original's
  // DWORD-channel write, including its intentional 8-bit wraparound.
  return (((rand() * range) | 0) + (range >> 1)) & 0xff;
}

/**
 * Generate one RGBA8 2D noise plane (`size × size × 4` bytes). With `zoom > 1`,
 * random values are placed on a coarse `zoom`-spaced lattice and cubically
 * interpolated between - separably across X (on the lattice rows) then down Y
 * (every column), exactly as AddNoiseTex does.
 */
export function generateNoise2D(
  size: number,
  zoom: number,
  rand: Rand = Math.random,
): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const range = zoom > 1 ? 216 : 256;
  for (let i = 0; i < data.length; i++) data[i] = randByte(rand, range);
  if (zoom <= 1) return data;

  const at = (x: number, y: number, c: number) => data[(y * size + x) * 4 + c]!;
  const set = (x: number, y: number, c: number, v: number) => {
    data[(y * size + x) * 4 + c] = Math.max(0, Math.min(1, v)) * 255;
  };

  // X pass: fill the lattice rows (y stepped by zoom)
  for (let y = 0; y < size; y += zoom)
    for (let x = 0; x < size; x++)
      if (x % zoom) {
        const bx = Math.floor(x / zoom) * zoom;
        const t = (x % zoom) / zoom;
        for (let c = 0; c < 4; c++)
          set(
            x,
            y,
            c,
            cubicInterpolate(
              at((bx - zoom + size) % size, y, c) / 255,
              at(bx % size, y, c) / 255,
              at((bx + zoom) % size, y, c) / 255,
              at((bx + 2 * zoom) % size, y, c) / 255,
              t,
            ),
          );
      }

  // Y pass: fill every column from the (now complete) lattice rows
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++)
      if (y % zoom) {
        const by = Math.floor(y / zoom) * zoom;
        const t = (y % zoom) / zoom;
        for (let c = 0; c < 4; c++)
          set(
            x,
            y,
            c,
            cubicInterpolate(
              at(x, (by - zoom + size) % size, c) / 255,
              at(x, by % size, c) / 255,
              at(x, (by + zoom) % size, c) / 255,
              at(x, (by + 2 * zoom) % size, c) / 255,
              t,
            ),
          );
      }

  return data;
}

/**
 * Generate one RGBA8 3D noise volume (`size³ × 4` bytes), cubically
 * interpolated on a `zoom`-spaced lattice across X, then Y, then Z - the 3D
 * analogue of {@link generateNoise2D} (AddNoiseVol).
 */
export function generateNoise3D(
  size: number,
  zoom: number,
  rand: Rand = Math.random,
): Uint8Array {
  const data = new Uint8Array(size * size * size * 4);
  const range = zoom > 1 ? 216 : 256;
  for (let i = 0; i < data.length; i++) data[i] = randByte(rand, range);
  if (zoom <= 1) return data;

  const idx = (x: number, y: number, z: number, c: number) =>
    ((z * size + y) * size + x) * 4 + c;
  const at = (x: number, y: number, z: number, c: number) =>
    data[idx(x, y, z, c)]!;
  const set = (x: number, y: number, z: number, c: number, v: number) => {
    data[idx(x, y, z, c)] = Math.max(0, Math.min(1, v)) * 255;
  };
  const sample = (x: number, y: number, z: number, c: number) =>
    at(x, y, z, c) / 255;

  // X pass on lattice rows/slices
  for (let z = 0; z < size; z += zoom)
    for (let y = 0; y < size; y += zoom)
      for (let x = 0; x < size; x++)
        if (x % zoom) {
          const b = Math.floor(x / zoom) * zoom;
          const t = (x % zoom) / zoom;
          for (let c = 0; c < 4; c++)
            set(
              x,
              y,
              z,
              c,
              cubicInterpolate(
                sample((b - zoom + size) % size, y, z, c),
                sample(b % size, y, z, c),
                sample((b + zoom) % size, y, z, c),
                sample((b + 2 * zoom) % size, y, z, c),
                t,
              ),
            );
        }

  // Y pass on lattice slices
  for (let z = 0; z < size; z += zoom)
    for (let x = 0; x < size; x++)
      for (let y = 0; y < size; y++)
        if (y % zoom) {
          const b = Math.floor(y / zoom) * zoom;
          const t = (y % zoom) / zoom;
          for (let c = 0; c < 4; c++)
            set(
              x,
              y,
              z,
              c,
              cubicInterpolate(
                sample(x, (b - zoom + size) % size, z, c),
                sample(x, b % size, z, c),
                sample(x, (b + zoom) % size, z, c),
                sample(x, (b + 2 * zoom) % size, z, c),
                t,
              ),
            );
        }

  // Z pass on every voxel
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let z = 0; z < size; z++)
        if (z % zoom) {
          const b = Math.floor(z / zoom) * zoom;
          const t = (z % zoom) / zoom;
          for (let c = 0; c < 4; c++)
            set(
              x,
              y,
              z,
              c,
              cubicInterpolate(
                sample(x, y, (b - zoom + size) % size, c),
                sample(x, y, b % size, c),
                sample(x, y, (b + zoom) % size, c),
                sample(x, y, (b + 2 * zoom) % size, c),
                t,
              ),
            );
        }

  return data;
}

/**
 * Create the six MilkDrop noise textures (see the module overview).
 *
 * @param gl - The WebGL2 context.
 * @returns The created {@link NoiseTextures}.
 */
export function createNoiseTextures(gl: WebGL2RenderingContext): NoiseTextures {
  return {
    noiseLQ: upload2D(gl, 256, generateNoise2D(256, 1)),
    noiseMQ: upload2D(gl, 256, generateNoise2D(256, 4)),
    noiseHQ: upload2D(gl, 256, generateNoise2D(256, 8)),
    noiseLQLite: upload2D(gl, 32, generateNoise2D(32, 1)),
    noiseVolLQ: upload3D(gl, 32, generateNoise3D(32, 1)),
    noiseVolHQ: upload3D(gl, 32, generateNoise3D(32, 4)),
  };
}

function upload2D(
  gl: WebGL2RenderingContext,
  size: number,
  data: Uint8Array,
): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    size,
    size,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data,
  );
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function upload3D(
  gl: WebGL2RenderingContext,
  size: number,
  data: Uint8Array,
): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA,
    size,
    size,
    size,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data,
  );
  gl.texParameteri(
    gl.TEXTURE_3D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.bindTexture(gl.TEXTURE_3D, null);
  return tex;
}
