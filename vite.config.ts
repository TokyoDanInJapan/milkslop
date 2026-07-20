import { defineConfig, type Plugin } from "vite";
import { load as parseYaml } from "js-yaml";

/**
 * Import `.yaml` / `.yml` files as parsed JS objects. Used to load the root
 * `config.yaml` (the single source of truth for tunables and engine constants)
 * at build time, so the bundled app and the vitest run share the same values
 * with no runtime fetch or parser.
 */
function yamlPlugin(): Plugin {
  return {
    name: "milkslop-yaml",
    transform(code, id) {
      if (!/\.ya?ml$/.test(id)) return null;
      return {
        code: `export default ${JSON.stringify(parseYaml(code))};`,
        map: null,
      };
    },
  };
}

/**
 * Legal notice prepended to the built bundle. BSD-3-Clause condition 2 requires
 * binary/compiled redistributions to reproduce the copyright notice in the
 * materials provided with the distribution; the deployed `dist/` bundle is that
 * distribution. Kept as a `/*!` banner with `legalComments: "inline"` so esbuild
 * preserves it through minification.
 */
const banner = `/*! Milkslop - BSD-3-Clause. Copyright (c) 2026 Daniel Hebberd.
 * Derivative of MilkDrop 2 (v2.25c): Copyright 2005-2013 Nullsoft, Inc.,
 * MilkDrop by Ryan Geiss. See LICENSE and NOTICE. */`;

export default defineConfig({
  root: ".",
  plugins: [yamlPlugin()],
  esbuild: {
    legalComments: "inline",
  },
  build: {
    target: "es2022",
    outDir: "dist",
    rollupOptions: {
      output: {
        banner,
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Only the GL-free, deterministic logic is unit-tested; GPU classes and
      // the app shell are verified via the headless-Chrome scripts instead.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/presets/**",
        "src/app/**", // DOM/render-loop wiring (headless smoke test)
        // GPU-bound classes exercised via scripts/smoke.mjs and
        // scripts/check-shaders.mjs, not unit tests:
        "src/audio/AudioEngine.ts",
        "src/render/ColorBatch.ts",
        "src/render/Composite.ts",
        "src/render/CustomShapes.ts",
        "src/render/CustomWaves.ts",
        "src/render/FrameBuffers.ts",
        "src/render/gl.ts",
        "src/render/Renderer.ts",
        "src/render/RenderTarget.ts",
        "src/render/WarpMesh.ts",
        "src/shader/ShaderPass.ts",
      ],
    },
  },
});
