/**
 * Resolve the preset corpus directory used by the shader-checking scripts.
 *
 * Precedence: an explicit path argument, then the local (gitignored) full
 * corpus at test/presets, then the committed synthetic corpus at
 * test/presets-gen. Exits with a clear message when nothing usable exists.
 */
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * @param {string} root repo root
 * @param {string | undefined} explicit optional user-supplied path
 * @returns {string} absolute path to a directory of .milk presets
 */
export function resolvePresetsDir(root, explicit) {
  if (explicit) {
    const dir = resolve(explicit);
    if (!existsSync(dir)) {
      console.error(`Presets directory not found: ${dir}`);
      process.exit(1);
    }
    return dir;
  }
  for (const candidate of [
    `${root}/test/presets`,
    `${root}/test/presets-gen`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  console.error(
    "No preset corpus found. Pass a directory of .milk files, or place a " +
      "corpus at test/presets (test/presets-gen is the committed fallback).",
  );
  process.exit(1);
}
