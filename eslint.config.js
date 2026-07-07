import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import tsdoc from "eslint-plugin-tsdoc";

/**
 * Flat ESLint config.
 *
 * - `src/` and `test/` get the full type-checked typescript-eslint rule set
 *   (backed by the tsconfig via `projectService`), plus the TSDoc plugin's
 *   `tsdoc/syntax` rule on `src/` so every doc comment is validated as
 *   well-formed TSDoc - keeping the doc style consistent across the codebase.
 * - `scripts/` and root-level JS config files get the plain JS recommended
 *   rules with Node globals.
 *
 * All rules are errors so `eslint .` fails CI on any finding.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["**/*.{js,mjs}"],
    ...js.configs.recommended,
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // These scripts drive a headless page; code inside page.evaluate()
    // callbacks runs in the browser, so browser globals are legitimate.
    files: [
      "scripts/check-shaders.mjs",
      "scripts/debug-shader.mjs",
      "scripts/smoke.mjs",
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: { tsdoc },
    rules: {
      "tsdoc/syntax": "error",
    },
  },
);
