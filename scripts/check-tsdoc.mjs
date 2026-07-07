/**
 * TSDoc presence check. ESLint's `tsdoc/syntax` rule only validates that doc
 * comments are well-formed - it does not require exports to *have* them. This
 * script fills that gap: it fails (exit 1) if any exported declaration in
 * `src/` lacks a preceding doc comment, or if any real source module lacks a
 * file header comment. Pure re-exports (`export … from "…"`) are exempt.
 *
 * Usage: node scripts/check-tsdoc.mjs
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = walk("src");
const undocumented = [];
const noHeader = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  if (!/^\s*\/\*\*/.test(src.trimStart())) noHeader.push(file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // exported declaration (not a re-export, which has no body to document)
    if (
      /^export\s+(async\s+)?(function|class|interface|type|const|enum|abstract\s+class)\b/.test(
        line,
      ) &&
      !/^export\s+type\s+\*/.test(line) &&
      !/\bfrom\s+["']/.test(line)
    ) {
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === "") j--;
      const hasDoc = j >= 0 && lines[j].trim().endsWith("*/");
      if (!hasDoc)
        undocumented.push(`${file}:${i + 1}  ${line.trim().slice(0, 72)}`);
    }
  }
}

if (undocumented.length || noHeader.length) {
  if (noHeader.length) {
    console.error("Modules missing a file header comment:");
    for (const f of noHeader) console.error("  " + f);
  }
  if (undocumented.length) {
    console.error("Exported declarations missing a doc comment:");
    for (const u of undocumented) console.error("  " + u);
  }
  console.error(
    `\nFAIL: ${undocumented.length} undocumented export(s), ${noHeader.length} headerless module(s).`,
  );
  process.exit(1);
}

console.log(`OK: every export in ${files.length} src modules is documented.`);
