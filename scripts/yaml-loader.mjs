/**
 * Node ESM loader hook for `.yaml` / `.yml` imports - the Node-side equivalent
 * of the Vite yaml plugin in vite.config.ts. The app bundles config.yaml via
 * Vite; the tsx-run scripts under scripts/ import `src/` (and thus
 * `../config.yaml`) directly under plain Node, which otherwise rejects the
 * `.yaml` extension. Scripts register this loader before their dynamic
 * `import()`s so the same config drives both paths.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/** Resolve `.yaml` imports as JS modules whose default export is the parsed object. */
export async function load(url, context, nextLoad) {
  if (/\.ya?ml$/.test(url)) {
    const text = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(yaml.load(text))};`,
    };
  }
  return nextLoad(url, context);
}
