/**
 * HLSL → GLSL ES 3.00 transpiler for MilkDrop warp/composite pixel shaders.
 *
 * @remarks
 * MilkDrop preset shaders are a constrained subset of HLSL wrapped in a
 * `shader_body \{ ... \}` block, optionally preceded by helper functions and
 * extra `sampler` declarations. A real HLSL compiler is overkill; a careful
 * token/regex translation handles the domain (mostly straight-line float math).
 * Shaders that fall outside the subset fail to compile and the renderer falls
 * back to the no-shader path, so partial coverage degrades gracefully.
 */

/** The result of transpiling one preset shader. */
export interface TranspileResult {
  /** Translated global code that preceded `shader_body` (helpers, samplers). */
  preamble: string;
  /** Translated body that goes inside `main()`. */
  body: string;
  /** Sampler names referenced (`sampler_main`, `sampler_blur1`, user textures…). */
  samplers: Set<string>;
  /** Subset of `samplers` that were called via `tex3D` - must be declared as `sampler3D`. */
  samplers3D: Set<string>;
  /** Whether the source actually contained a `shader_body` block. */
  hasBody: boolean;
}

/**
 * Transpile one MilkDrop preset shader from HLSL to a GLSL body + preamble.
 *
 * @param src - The raw shader text (optionally wrapped in `shader_body \{ … \}`).
 * @returns The translated {@link TranspileResult}.
 */
export function transpile(src: string): TranspileResult {
  const cleaned = src.replace(/\r/g, "");
  const idx = cleaned.indexOf("shader_body");
  let preambleSrc = "";
  let bodySrc = "";
  let hasBody = false;

  if (idx >= 0) {
    preambleSrc = cleaned.slice(0, idx);
    const rest = cleaned.slice(idx + "shader_body".length);
    const open = rest.indexOf("{");
    if (open >= 0) {
      bodySrc = extractBraceBlock(rest.slice(open));
      hasBody = true;
    }
  } else {
    // some presets store just the body
    bodySrc = cleaned;
  }

  const samplers = new Set<string>();
  const samplers3D = new Set<string>();
  collectSamplers(preambleSrc, samplers, samplers3D);
  collectSamplers(bodySrc, samplers, samplers3D);

  // Collapse `;;` runs and lone `;` lines after translation - preset typos like
  // `float a;;` or a stripped sampler declaration leave stray top-level
  // semicolons, which are syntax errors at global scope in GLSL ES.
  let translatedPreamble = translate(preambleSrc)
    .replace(/;(?:\s*;)+/g, ";")
    .replace(/^\s*;\s*$/gm, "");

  // GLSL ES requires global initializers to be constant expressions. Presets
  // initialize globals from uniforms (`float3 sxy = float3(q4,q5,q6);`) -
  // split those: keep the declaration global, move the assignment into main().
  const globalInits: string[] = [];
  {
    const lines = translatedPreamble.split("\n");
    let depth = 0;
    const kept: string[] = [];
    for (const line of lines) {
      if (depth === 0) {
        const dm =
          /^(\s*)(vec[234]|float|mat[234](?:x[234])?)\s+(\w+)\s*=\s*([^;]+);\s*(?:\/\/.*)?$/.exec(
            line,
          );
        if (dm) {
          // Constant if, after dropping type-constructor names, no identifier remains
          const exprIds = dm[4]!.replace(
            /\b(?:vec[234]|mat[234](?:x[234])?|float)\s*\(/g,
            "(",
          );
          if (/[a-zA-Z_]/.test(exprIds)) {
            kept.push(`${dm[1]}${dm[2]} ${dm[3]};`);
            globalInits.push(`${dm[3]} = ${dm[4]!.trim()};`);
            continue;
          }
        }
      }
      depth +=
        (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0);
      kept.push(line);
    }
    if (globalInits.length > 0) translatedPreamble = kept.join("\n");
  }

  // Collect vec3/vec2 variable names declared in the preamble so the body
  // translator can fix implicit HLSL scalar broadcasts to those variables.
  const preambleVec3Names = collectVecNames(translatedPreamble, "vec3");
  // `ret` is always vec3 in main() - add it so body scalar-broadcast fixes apply
  preambleVec3Names.add("ret");
  const preambleVec2Names = collectVecNames(translatedPreamble, "vec2");
  // `uv` and `uv_orig` are always vec2 in main()
  preambleVec2Names.add("uv");
  preambleVec2Names.add("uv_orig");
  // Collect preamble-declared scalar (float) names for dimension-mismatch fixes.
  // collectVecNames handles multi-name declarations (`float k,m,n,zoom;`).
  const preambleFloatNames = new Set<string>();
  for (const n of collectVecNames(translatedPreamble, "float")) {
    if (!preambleVec3Names.has(n) && !preambleVec2Names.has(n))
      preambleFloatNames.add(n);
  }

  let body = translateBody(
    bodySrc,
    preambleVec3Names,
    preambleVec2Names,
    preambleFloatNames,
  );
  // Run moved global initializers before any body code.
  if (globalInits.length > 0) body = globalInits.join("\n") + "\n" + body;

  return {
    preamble: translatedPreamble,
    body,
    samplers,
    samplers3D,
    hasBody,
  };
}

/**
 * Collect variable names declared as `vecN name` in a translated GLSL chunk.
 * Handles initializers (`vec3 a = vec3(0.0);`) and multi-name declarations
 * (`vec3 a, b, c;`).
 */
function collectVecNames(src: string, vecType: string): Set<string> {
  const names = new Set<string>();
  // Strip all parenthesized content first (function parameter lists would
  // otherwise leak `vec2 project(vec3 s, …)` as declarations of `s` etc.;
  // initializer call arguments are never needed for name extraction).
  let stripped = src;
  for (let prev = ""; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/\([^()]*\)/g, "");
  }
  const re = new RegExp(`\\b${vecType}\\s+([^;]+);`, "g");
  for (const m of stripped.matchAll(re)) {
    // Split on TOP-LEVEL commas only (commas inside initializer call parens like
    // `vec3 a = tex2D(s, uv).xyz;` must not produce bogus names), then take the
    // identifier before any `=`.
    const decl = m[1]!;
    let depth = 0;
    let start = 0;
    const parts: string[] = [];
    for (let i = 0; i <= decl.length; i++) {
      const c = decl[i];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if ((c === "," && depth === 0) || i === decl.length) {
        parts.push(decl.slice(start, i));
        start = i + 1;
      }
    }
    for (const tok of parts) {
      // A `{` means we crossed into a function body (e.g. `vec2 project { …`
      // after paren-stripping a definition) - not a variable declaration.
      if (tok.includes("{")) continue;
      const name = tok.split("=")[0]!.trim().split(/\s+/)[0]!;
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Take the text inside the first balanced `{...}`, excluding the outer braces. */
function extractBraceBlock(s: string): string {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i);
    }
  }
  return start >= 0 ? s.slice(start) : s;
}

/** Collect every `sampler_*` name referenced in `src` into `out`; 3D ones also into `out3D`. */
function collectSamplers(
  src: string,
  out: Set<string>,
  out3D: Set<string>,
): void {
  for (const m of src.matchAll(/\b(sampler_\w+)\b/g)) out.add(m[1]!);
  // Detect tex3D(sampler_name, ...) - these need sampler3D declarations.
  // Case-insensitive: presets write tex3d/tex3D interchangeably.
  for (const m of src.matchAll(/\btex3[Dd]\s*\(\s*(sampler_\w+)/g))
    out3D.add(m[1]!);
  // Honour explicit sampler3D declarations in the source
  for (const m of src.matchAll(/\bsampler3D\s+(sampler_\w+)/g))
    out3D.add(m[1]!);
}

/**
 * Translate the shader body with preamble context for vec3/vec2 names.
 * Handles implicit scalar broadcasts to preamble-declared vec3 variables,
 * and vec3*vec2 truncation for preamble-declared variables.
 */
function translateBody(
  src: string,
  preambleVec3Names: Set<string>,
  preambleVec2Names: Set<string>,
  preambleFloatNames: Set<string> = new Set(),
): string {
  let s = translate(src);

  // Extend vec2 names with names declared in the body itself (e.g. `vec2 zoom = ...`).
  // This lets subsequent assignments like `zoom = scalar;` be scalar-broadcast too.
  for (const n of collectVecNames(s, "vec2")) preambleVec2Names.add(n);
  for (const n of collectVecNames(s, "vec3")) preambleVec3Names.add(n);

  // All vector-valued (3+ component) variable names - vec3 AND vec4 - used for
  // scalar-context analysis and UV-arg truncation (semantics are identical:
  // D3D9 truncates either to the needed width).
  const wideVecNames = new Set(preambleVec3Names);
  for (const n of collectVecNames(s, "vec4")) wideVecNames.add(n);

  // ANY vector name (vec2/3/4) - for float-LHS contexts, where a vec2-valued
  // RHS needs .x just as much as a vec3-valued one.
  const anyVecNames = new Set([...wideVecNames, ...preambleVec2Names]);

  if (preambleVec3Names.size > 0) {
    const v3names = [...preambleVec3Names].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    // Fix: PREAMBLE_VEC3 = scalar_expr; → PREAMBLE_VEC3 = vec3(scalar_expr);
    const assignRe = new RegExp(
      `(?<!\\.)(?<!(?:vec[234]|float|mat[234])\\s{1,8})\\b(${v3names.join("|")})\\s*=(?!=)\\s*([^;]+);`,
      "g",
    );
    s = s.replace(assignRe, (m, name: string, rhs: string) => {
      const t = rhs.trim();
      // 3-component swizzle present → vector-valued, leave as-is
      if (/\.[xyzwrgba]{3}/.test(rhs)) return `${name} = ${rhs};`;
      // Whole-RHS vec4 constructor assigned to vec3 → truncate (D3D9 semantics)
      if (/^vec4\s*\(/.test(t)) return `${name} = (${rhs}).xyz;`;
      // Provably scalar (all vector-valued calls/ctors/vars reduced to a single
      // component or consumed by lum/dot/length/distance) → broadcast to vec3.
      if (innerIsScalar(t)) return `${name} = vec3(${rhs});`;
      // Otherwise vector-valued already - leave as-is.
      return m;
    });
  }

  // Preamble vec2 scalar broadcast: PREAMBLE_VEC2 = scalar → PREAMBLE_VEC2 = vec2(scalar)
  if (preambleVec2Names.size > 0) {
    const v2names = [...preambleVec2Names].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const assignRe2 = new RegExp(
      `(?<!\\.)(?<!(?:vec[234]|float|mat[234])\\s{1,8})\\b(${v2names.join("|")})\\s*=(?!=)\\s*([^;]+);`,
      "g",
    );
    s = s.replace(assignRe2, (_m, name: string, rhs: string) => {
      // First: replace unswizzled preamble/body vec3 names with .xy - they are
      // vec3 in GLSL but HLSL would implicitly truncate to float2 in this
      // context. Only at paren depth 0: inside call arguments the expected
      // type belongs to the callee (e.g. project(sxy, …) wants the vec3).
      let fixedRhs = rhs;
      if (preambleVec3Names.size > 0) {
        const pv3esc = [...preambleVec3Names].map((n) =>
          n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        );
        const pv3Re = new RegExp(`\\b(${pv3esc.join("|")})\\b(?!\\s*\\.)`, "g");
        fixedRhs = rhs.replace(pv3Re, (mm: string, nm: string, off: number) => {
          let depth = 0;
          for (let i = 0; i < off; i++) {
            if (rhs[i] === "(") depth++;
            else if (rhs[i] === ")") depth--;
          }
          return depth === 0 ? `${nm}.xy` : mm;
        });
      }
      const t = fixedRhs.trim();
      if (/\bvec2\s*\(/.test(fixedRhs)) return `${name} = ${fixedRhs};`;
      // Already ends with a 2-component swizzle - already vec2
      if (/\.[xyzwrgba]{2}\s*$/.test(t)) return `${name} = ${fixedRhs};`;
      // Contains vec3-returning texture helper → wrap the whole RHS with .xy
      if (
        /\b(?:GetPixel|GetMain|GetBlur[0-3]|tex2D|tex3D|textureLod|texture)\s*\(/.test(
          fixedRhs,
        )
      )
        return `${name} = (${fixedRhs}).xy;`;
      // Scalar or vec2 expression → broadcast to vec2
      return `${name} = vec2(${fixedRhs});`;
    });
  }

  // Fix: vec3 names used inside vec2(EXPR) - add .xy so GLSL vec2 arithmetic works.
  // In HLSL, a float3 is implicitly truncated to float2 in this context.
  // Applies to ALL vec3 variables (preamble and body-declared).
  if (preambleVec3Names.size > 0) {
    const v3esc = [...preambleVec3Names].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    // Match NAME when NOT directly followed by '.' (already has a swizzle/member access).
    const vec3InVec2Re = new RegExp(
      `\\b(${v3esc.join("|")})\\b(?!\\s*\\.)`,
      "g",
    );
    // Match vec2(EXPR) with up to 3 levels of nested parens.
    s = s.replace(
      /\bvec2\s*\(([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*)\)/g,
      (m, inner: string) => {
        if (!vec3InVec2Re.test(inner)) return m;
        vec3InVec2Re.lastIndex = 0;
        // Only truncate names at paren depth 0 - inside nested call arguments
        // the expected type belongs to the callee (project(sxy, …) wants vec3).
        const fixed = inner.replace(
          vec3InVec2Re,
          (mm: string, nm: string, off: number) => {
            let depth = 0;
            for (let i = 0; i < off; i++) {
              if (inner[i] === "(") depth++;
              else if (inner[i] === ")") depth--;
            }
            return depth === 0 ? `${nm}.xy` : mm;
          },
        );
        return fixed === inner ? m : `vec2(${fixed})`;
      },
    );
  }

  // Fix: preamble-declared float variables assigned a vec2 expression.
  // In HLSL, float = float2 implicitly takes the first component.
  // Detect by: assignment contains a 2-component swizzle (like texsize.zw).
  if (preambleFloatNames.size > 0) {
    const pfesc = [...preambleFloatNames].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const preambleFloatAssignRe = new RegExp(
      `(?<!\\.)(?<!(?:vec[234]|float|mat[234])\\s{1,8})\\b(${pfesc.join("|")})\\s*=(?!=)\\s*([^;]+);`,
      "g",
    );
    s = s.replace(preambleFloatAssignRe, (m, name: string, rhs: string) => {
      // 2-component swizzle (e.g. texsize.zw) → vec2 expression → need .x
      if (/\.[xyzwrgba]{2}(?!\.[xyzwrgba])/.test(rhs))
        return `${name} = (${rhs}).x;`;
      // Unswizzled vec3-returning call or vec3 variable → vec3 expression → need .x
      if (!innerIsScalar(rhs.trim(), anyVecNames))
        return `${name} = (${rhs}).x;`;
      return m;
    });
  }

  // Fix: ret = vec4(ARGS) → ret = (vec4(ARGS)).xyz
  // In HLSL, float3 ret = float4(...) implicitly truncates; GLSL rejects vec3=vec4.
  s = s.replace(
    /\bret\s*=\s*(vec4\s*\([^;]*\))\s*;/g,
    (_m, expr) => `ret = (${expr}).xyz;`,
  );

  // Fix: preamble vec3 names that appear (without an existing swizzle) inside the UV
  // argument of GetPixel/GetBlur/GetMain calls - add .xy so the UV is vec2.
  // In HLSL, float3 UV in tex2D is implicitly truncated to float2.
  // Also apply the same fix inside tex2D UV args (second argument).
  {
    // Build a regex for all known vec3 names (preamble AND body-declared) -
    // a float3 in UV position is truncated to float2 by HLSL either way.
    const uvVec3Re =
      preambleVec3Names.size > 0
        ? new RegExp(
            `\\b(${[...preambleVec3Names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b(?!\\s*\\.)`,
            "g",
          )
        : null;

    const fixUvArg = (arg: string): string => {
      // Add .xy to unswizzled GetBlur/GetPixel/GetMain calls inside the UV arg
      let fixed = arg.replace(
        /\b(GetBlur[0-3]|GetMain|GetPixel)\s*(\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\))(?!\.[xyzwrgba])/g,
        "$1$2.xy",
      );
      // Also add .xy to any preamble vec3 names that appear unswizzled
      if (uvVec3Re) {
        uvVec3Re.lastIndex = 0;
        fixed = fixed.replace(uvVec3Re, "$1.xy");
      }
      return fixed;
    };

    // tex2D(sampler, UV_ARG) - fix the UV (second) argument
    const parts: string[] = [];
    let pos = 0;
    while (pos < s.length) {
      const m2 = /\btex2D\s*\(\s*\w+\s*,/.exec(s.slice(pos));
      if (!m2) break;
      parts.push(s.slice(pos, pos + m2.index + m2[0].length));
      let i = pos + m2.index + m2[0].length;
      let depth = 1;
      const uvStart = i;
      while (i < s.length && depth > 0) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      const uvArg = s.slice(uvStart, i);
      parts.push(fixUvArg(uvArg), ")");
      pos = i + 1;
    }
    parts.push(s.slice(pos));
    s = parts.join("");

    // Apply the same preamble-vec3 → .xy fix inside the UV arg of GetPixel/GetBlur/GetMain.
    // These take a single UV argument; a preamble vec3 used as (part of) that UV will fail
    // in GLSL because vec2+vec3 arithmetic is not defined.
    if (uvVec3Re) {
      s = s.replace(
        /\b(GetBlur[0-3]|GetMain|GetPixel)\s*\(([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*)\)/g,
        (_m, funcName: string, inner: string) => {
          uvVec3Re.lastIndex = 0;
          if (!uvVec3Re.test(inner)) return _m;
          uvVec3Re.lastIndex = 0;
          return `${funcName}(${inner.replace(uvVec3Re, "$1.xy")})`;
        },
      );
    }
  }

  // Fix: HLSL vector comparison `(vec_expr >= scalar)` → GLSL `step(scalar, vec_expr)`.
  // `>=` / `<=` is only defined for scalars in GLSL ES 3.0. Replace with step() when
  // the LHS of the comparison contains a vec3-returning call.
  s = s.replace(
    /\(\s*([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*)\s*(>=|<=)\s*([\d.]+)\s*\)/g,
    (_m: string, lhs: string, op: string, scalar: string) => {
      if (!/\b(?:GetBlur[0-3]|GetPixel|GetMain|tex2D|tex3D)\b/.test(lhs))
        return _m;
      if (op === ">=") return `step(${scalar}, ${lhs.trim()})`;
      return `(1.0 - step(${scalar}, ${lhs.trim()}))`;
    },
  );

  // Fix: ANY single-component LHS (vecN.single) = vec3_expr → add .x to RHS.
  // Covers both compound (+=/-=) and plain (=) assignment.
  // HLSL allows assigning vec3 to a float component (takes .x); GLSL does not.
  // Strategy: first replace any multi-component swizzles in the RHS (.xyz/.rgb etc.)
  // with the single .x/.r equivalent - this often makes the whole RHS scalar,
  // avoiding the need to wrap the entire expression.
  s = s.replace(
    /\b(\w+\.[xyzw]\s*[-+*\/]?=(?!=)\s*)([^;]+);/g,
    (_m: string, lhsOp: string, rhs: string) => {
      rhs = rhs
        .replace(/\.(xyz|rgb)\b/g, ".x")
        .replace(/\.(xyzw|rgba)\b/g, ".x");
      const t = rhs.trim();
      if (/\.[xyzw]\s*$/.test(t) && innerIsScalar(t, anyVecNames))
        return `${lhsOp}${rhs};`;
      if (innerIsScalar(t, anyVecNames)) return `${lhsOp}${rhs};`;
      return `${lhsOp}(${rhs}).x;`;
    },
  );

  // Fix: float NAME = VEC3_EXPR → add .x
  // Handles initial float declarations assigned an unswizzled tex2D/GetBlur result.
  // Also catches texsize.xy * texsize_X.zw (vec2*vec2) patterns assigned to float.
  s = s.replace(
    /\bfloat\s+(\w+)\s*=\s*([^;]+);/g,
    (_m: string, name: string, rhs: string) => {
      const t = rhs.trim();
      // Already ends with single-char swizzle → scalar, leave unchanged
      if (/\.[xyzwrgba]\s*$/.test(t) && !/\.[xyzwrgba]{2}\s*$/.test(t))
        return `float ${name} = ${rhs};`;
      // Strip one level of outer parens for prefix check
      const tCore =
        t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1).trimEnd() : t;
      // (PAREN_GROUP).[swizzle] prefix → that sub-expression is scalar
      const prefixRe =
        /^\s*\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)\s*\.[xyzwrgba]\b/;
      const pm = prefixRe.exec(tCore);
      if (pm && innerIsScalar(tCore.slice(pm[0].length).trim() || "1"))
        return `float ${name} = ${rhs};`;
      // Unswizzled vec3-returning call or vec3 variable → add .x
      if (!innerIsScalar(t, anyVecNames)) return `float ${name} = (${rhs}).x;`;
      // texsize.XY * texsize_*.ZW pattern → vec2*vec2 = vec2 assigned to float
      if (
        /\btexsize(?:_\w+)?\.([xyzw]{2})\s*\*.*\btexsize(?:_\w+)?\.([xyzw]{2})/.test(
          t,
        )
      )
        return `float ${name} = (${rhs}).x;`;
      // mod(vec2_expr, scalar) → vec2 assigned to float (fmod on uv produces vec2)
      if (/^\s*mod\s*\(\s*\(?\s*[\d.]+\s*\*\s*(?:uv|uv_orig)\b/.test(t))
        return `float ${name} = (${rhs}).x;`;
      return `float ${name} = ${rhs};`;
    },
  );

  // Fix: body-declared float variable += tex3D/tex2D/GetBlur expr → add .x
  // HLSL implicitly truncates vec3/vec4 to float; GLSL does not.
  {
    const bodyFloatNames = new Set<string>();
    for (const m of s.matchAll(/\bfloat\s+(\w+)\s*[=;]/g))
      bodyFloatNames.add(m[1]!);
    if (bodyFloatNames.size > 0) {
      const fn = [...bodyFloatNames].map((n) =>
        n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      );
      const floatCompoundRe = new RegExp(
        `(?<!\\.)\\b(${fn.join("|")})\\s*([-+*/]=)\\s*([^;]+);`,
        "g",
      );
      s = s.replace(
        floatCompoundRe,
        (m: string, name: string, op: string, rhs: string) => {
          const t = rhs.trim();
          if (innerIsScalar(t, anyVecNames)) return m;
          return `${name} ${op} (${rhs}).x;`;
        },
      );
      // Also fix: float_var = step(scalar, vec_expr) → float_var = step(...).x
      // Happens when (vec >= scalar) was converted to step() by the >= rule above.
      const floatStepRe = new RegExp(
        `\\b(${fn.join("|")})\\s*=(?!=)\\s*((?:step|1\\.0\\s*-\\s*step)\\s*\\([^;]+\\))\\s*;`,
        "g",
      );
      s = s.replace(floatStepRe, (_m: string, name: string, rhs: string) => {
        const t = rhs.trim();
        if (/\.[xyzw]\s*$/.test(t)) return `${name} = ${rhs};`;
        return `${name} = ${rhs}.x;`;
      });
    }
  }

  // Fix uv_var += preamble_vec3_expr → uv_var += (expr).xy
  // Pattern: vec2 preamble var is compound-assigned from a vec3 expression.
  if (preambleVec2Names.size > 0 && preambleVec3Names.size > 0) {
    const v2 = [...preambleVec2Names].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const v3 = [...preambleVec3Names].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    // vec2_name op= RHS containing live vec3-valued items (unswizzled vec3
    // variables or vec3/vec4-returning sampler calls) → truncate them to .xy
    // in place (HLSL float2 op float3 truncates the float3).
    const uvCompound = new RegExp(
      `(?<![.\\w])(${v2.join("|")})\\s*([-+*/]?=)(?!=)\\s*([^;]+);`,
      "g",
    );
    const v3CallRe =
      /\b(GetBlur[0-3]|GetMain|GetPixel|tex2D|tex3D|textureLod)\s*(\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\))(?!\s*\.)/g;
    const v3NameRe = new RegExp(`\\b(${v3.join("|")})\\b(?!\\s*\\.)`, "g");
    s = s.replace(uvCompound, (m, lhsName: string, op: string, rhs: string) => {
      v3CallRe.lastIndex = 0;
      v3NameRe.lastIndex = 0;
      // Skip items inside user-function call arguments - the callee decides
      // the expected type there (project(sxy, …) wants the full vec3).
      let fixed = rhs.replace(
        v3CallRe,
        (mm: string, fn: string, args: string, off: number) =>
          isInsideUserCall(rhs, off) ? mm : `${fn}${args}.xy`,
      );
      fixed = fixed.replace(v3NameRe, (mm: string, nm: string, off: number) =>
        isInsideUserCall(fixed, off) ? mm : `${nm}.xy`,
      );
      return fixed === rhs ? m : `${lhsName} ${op} ${fixed};`;
    });
  }

  // Fix vec3NAME * vec2NAME → vec3NAME.xy * vec2NAME (D3D9 implicit truncation)
  if (preambleVec3Names.size > 0 && preambleVec2Names.size > 0) {
    const v3 = [...preambleVec3Names].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const v2 = [...preambleVec2Names].map((n) =>
      n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    // Match vec3Name * vec2Name (and vice-versa) - truncate to vec2.
    // The partner name must NOT be swizzled/indexed (rs2.y is a scalar).
    const mulRe = new RegExp(
      `\\b(${v3.join("|")})\\s*\\*\\s*(${v2.join("|")})\\b(?!\\s*[.\\[])`,
      "g",
    );
    s = s.replace(mulRe, "$1.xy * $2");
    const mulRe2 = new RegExp(
      `\\b(${v2.join("|")})\\s*\\*\\s*(${v3.join("|")})\\b(?!\\s*[.\\[])`,
      "g",
    );
    s = s.replace(mulRe2, "$1 * $2.xy");
  }

  return s;
}

/**
 * Apply the ordered HLSL→GLSL translation passes to a chunk of code.
 *
 * Each pass is a pure string→string rewrite; the order is load-bearing
 * (e.g. type substitution must precede the declaration-coercion fixes, and
 * literal floatification must precede scalar-swizzle stripping).
 */
function translate(src: string): string {
  let s = src;
  s = rewriteTypesAndRenames(s);
  s = fixDeclarationCoercions(s);
  s = rewriteBraceInitializers(s);
  s = renameIntrinsicFunctions(s);
  s = fixVectorComparisons(s);
  s = stripStorageQualifiers(s);
  s = fixTexsizeTruncations(s);
  s = stripLumScalarSwizzles(s);
  s = fixBoolFloatConversions(s);
  s = floatifyIntegers(s);
  s = stripRedundantScalarSwizzles(s);
  s = wrapFloatArrayIndices(s);
  return s;
}

/**
 * Strip sampler declarations, map HLSL scalar/vector/matrix type names to
 * their GLSL equivalents, normalise tex2d/tex3d case, rename identifiers that
 * are reserved in GLSL ES, and add `.x` to vec4 uniforms used as scalars.
 */
function rewriteTypesAndRenames(s: string): string {
  // strip `sampler ... ;` declarations - we declare samplers in the prologue
  s = s.replace(/\bsampler(?:2D|3D|CUBE)?\s+sampler_\w+\s*;/g, "");

  // HLSL `int` declarations → `float` declarations before floatify runs.
  // MilkDrop preset shaders use `int` only for loop counters and counters that
  // are compared / divided with float variables; treating them as float avoids
  // GLSL integer/float arithmetic errors.
  // Careful: don't match `int1`, `int2` etc. (those are vector types handled below)
  s = s.replace(
    /\bint(?![1-9])(\s+\w[\w]*\s*(?:,\s*\w+\s*)*(?:=|;))/g,
    "float$1",
  );
  // HLSL `int(x)` casts in float arithmetic → trunc() (same truncation semantics,
  // returns float so it composes with GLSL ES float math; array indices get
  // re-wrapped with int() by the array-index fix later).
  s = s.replace(/\bint\s*\(/g, "trunc(");

  // HLSL float1/double1 scalar synonyms → float; doubleN → vecN
  s = s.replace(/\bfloat1\b/g, "float");
  s = s.replace(/\bdouble1\b/g, "float");
  s = s.replace(/\bdouble([234])\b/g, "vec$1");
  s = s.replace(/\bint1\b/g, "float");

  // matrix types: HLSL floatRxC → GLSL matCxR (square stays matN)
  s = s.replace(/\bfloat([234])x([234])\b/g, (_m, r, c) =>
    r === c ? `mat${r}` : `mat${c}x${r}`,
  );
  s = s.replace(/\bhalf([234])x([234])\b/g, (_m, r, c) =>
    r === c ? `mat${r}` : `mat${c}x${r}`,
  );

  // vector / scalar types
  s = s.replace(/\bfloat([234])\b/g, "vec$1");
  s = s.replace(/\bhalf([234])\b/g, "vec$1");
  s = s.replace(/\bhalf\b/g, "float");
  // MilkDrop int2/3/4 are float vectors in practice - map to vec, not ivec.
  s = s.replace(/\bint([234])\b/g, "vec$1");
  s = s.replace(/\bbool([234])\b/g, "bvec$1");

  // Normalise tex2d/tex3d case (HLSL is case-insensitive; our helpers use uppercase D)
  s = s.replace(/\btex2d\b/g, "tex2D");
  s = s.replace(/\btex3d\b/g, "tex3D");

  // `output` is a reserved word in GLSL ES 3.0 (used for interface blocks).
  // Rename all uses of `output` as a variable identifier to `_output`.
  s = s.replace(/\boutput\b/g, "_output");

  // rand_frame / rand_preset / roam_* are vec4 uniforms but many shaders use them
  // as scalars. Add .x when accessed without a swizzle in a scalar context.
  // We do this early (before type rules) so vec4 is known.
  // Pattern: these uniforms followed by arithmetic (* + - /) but not by . or [
  s = s.replace(
    /\b(rand_frame|rand_preset|roam_cos|roam_sin|slow_roam_cos|slow_roam_sin)\b(?!\s*[.[(\w])/g,
    "$1.x",
  );

  // texture sampling: lod/bias variants use native GLSL; tex2D/tex3D/texCUBE are
  // kept as-is and resolved by GLSL helper functions defined in the prologue.
  // The helpers return vec3 for 2D (truncating alpha, matching HLSL's common usage)
  // and vec4 for 3D/CUBE, avoiding float3=float4 type mismatches.
  s = s.replace(/\btex2Dlod\s*\(/g, "textureLod(");
  s = s.replace(/\btex2Dbias\s*\(/g, "texture(");
  // tex2D, tex3D, texCUBE → left as function names, resolved by prologue helpers

  return s;
}

/**
 * Fix HLSL D3D9 implicit conversions at declaration/assignment sites that
 * GLSL rejects: scalar→vector broadcast, vector→narrower-vector truncation,
 * vector→float `.x` extraction, and bool→float masks (rules 1-10).
 * Runs after vec type substitution.
 */
function fixDeclarationCoercions(s: string): string {
  // HLSL D3D9 implicit type narrowing fixes (run after vec type substitution):
  // 1. float var = a.?? * b.??  (D3D9 assigns vec2 to float by taking .x) → vec2 var
  s = s.replace(
    /\bfloat(\s+\w+\s*=\s*[\w.]+\.[xyzwrgba]{2}\s*\*\s*[\w.]+\.[xyzwrgba]{2}\s*;)/g,
    "vec2$1",
  );
  // (Rule 2 removed: narrowing vec3 GetBlur→vec2 caused false positives when
  //  the blur result was used as a color vector, not a UV offset.)
  // 3. vec2 var = uvExpr * (…GetBlur…) → add .xy so vec3 result truncates to vec2
  s = s.replace(
    /\b(vec2\s+\w+\s*=\s*\w+)\s*\*\s*\(([^;]*GetBlur[^;]*)\)/g,
    "$1 * ($2).xy",
  );
  // 4. uvVar += (…GetBlur…) → .xy so vec3 result truncates to vec2
  s = s.replace(/\b(uv\w*)\s*\+=\s*([^;]*GetBlur[^;]*);/g, "$1 += ($2).xy;");

  // 5. vec2 var = vec3 expr (three-component swizzle on a 2-vec, e.g. uv_orig.xyy).
  //    D3D9 truncates vec3→vec2; add .xy.
  s = s.replace(
    /\bvec2(\s+\w+\s*=\s*)([^;]+\.[xyzwrgba]{3}[^;]*);/g,
    "vec2$1($2).xy;",
  );

  // 6. float var = <texture-helper expr> - HLSL implicitly takes .x.
  //    If the declared float variable's RHS contains GetPixel/GetBlur/tex2D/tex3D
  //    without a direct single-component swizzle, the result is vec3 - add .x.
  //    Skip when the outermost call is a known scalar-returning function (dot, lum,
  //    length, distance) - those wrap vec3 and return float, so no .x needed.
  s = s.replace(
    /\bfloat(\s+\w+\s*=\s*)([^;]+);/g,
    (_m: string, decl: string, rhs: string) => {
      const t = rhs.trim();
      // If rhs ends with `.[xyzwrgba]` AND the character before '.' is ')' then
      // the whole expression ends with a direct scalar swizzle of a paren-group.
      // e.g. (GetBlur1(...)).y - already scalar.
      if (/\.[xyzwrgba]$/.test(t) && t[t.length - 3] === ")")
        return `float${decl}${rhs};`;
      // Outermost call is a scalar-returning function → scalar
      if (/^(?:lum|dot|length|distance)\s*\(/.test(t))
        return `float${decl}${rhs};`;
      // Strip one level of outer parens and check if content starts with (PAREN_GROUP).swizzle.
      // e.g. ((GetBlur2(x)-GetBlur2(y)).x * scale.x) - the inner diff is vec3 but is
      // immediately swizzled to scalar, so the whole expression is scalar.
      const tCore =
        t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1).trimEnd() : t;
      const prefixRe =
        /^\s*\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)\s*\.[xyzwrgba]\b/;
      const pm = prefixRe.exec(tCore);
      if (pm && innerIsScalar(tCore.slice(pm[0].length).trim() || "1"))
        return `float${decl}${rhs};`;
      // If the whole RHS is provably scalar (all vec3 calls are swizzled or
      // wrapped inside lum/dot/length/distance), leave it unchanged.
      if (innerIsScalar(t)) return `float${decl}${rhs};`;
      // Contains texture helper used as vec3 → add .x
      if (/\b(?:GetPixel|GetMain|GetBlur[0-3]|tex2D|tex3D)\s*\(/.test(rhs))
        return `float${decl}(${rhs}).x;`;
      return `float${decl}${rhs};`;
    },
  );

  // 7. float MASK = (comparison) - HLSL implicit bool→float; GLSL needs float().
  //    `float mask = (z <= 1);` → `float mask = float((z <= 1));`
  s = s.replace(
    /\bfloat(\s+\w+\s*=\s*)(\([^;]*(?:<=|>=|<(?!<)|>(?!>)|==|!=)[^;]*\))\s*;/g,
    "float$1float($2);",
  );

  // 8. vec3 NAME = SCALAR_EXPR - HLSL broadcasts scalar to vec3; GLSL rejects.
  //    Wrap the RHS with vec3() when it doesn't already produce a vec3.
  //    Heuristic: skip if RHS contains a vec3/GetPixel/GetBlur/tex* call.
  s = s.replace(
    /\bvec3(\s+\w+\s*=\s*)([^;]+);/g,
    (_m: string, decl: string, rhs: string) => {
      const t = rhs.trim();
      // Keep if RHS contains a swizzle that extracts 3 components
      if (/\.[xyzwrgba]{3}/.test(rhs)) return `vec3${decl}${rhs};`;
      // Whole-RHS vec4 constructor → truncate (D3D9 semantics)
      if (/^vec4\s*\(/.test(t)) return `vec3${decl}(${rhs}).xyz;`;
      // Unswizzled tex3D/textureLod return vec4 → truncate to .xyz (D3D9)
      if (
        /\b(?:tex3D|textureLod)\s*\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)(?!\s*\.)/.test(
          rhs,
        )
      )
        return `vec3${decl}(${rhs}).xyz;`;
      // Provably scalar (vector calls/ctors all reduced to one component or
      // consumed by lum/dot/length/…) → broadcast to vec3
      if (innerIsScalar(t)) return `vec3${decl}vec3(${rhs});`;
      // Otherwise assume vector-valued - leave unchanged
      return `vec3${decl}${rhs};`;
    },
  );

  // 9. vec2 NAME = SCALAR_EXPR - HLSL broadcasts; GLSL rejects.
  s = s.replace(
    /\bvec2(\s+\w+\s*=\s*)([^;]+);/g,
    (_m: string, decl: string, rhs: string) => {
      const t = rhs.trim();
      // Ends in a 2-component swizzle → already vec2
      if (/(?<![xyzwrgba])\.[xyzwrgba]{2}\s*$/.test(t))
        return `vec2${decl}${rhs};`;
      // Ends in a 3/4-component swizzle → truncate to vec2 (D3D9)
      if (/\.[xyzwrgba]{3,4}\s*$/.test(t)) return `vec2${decl}(${rhs}).xy;`;
      // Provably scalar → broadcast
      if (innerIsScalar(t)) return `vec2${decl}vec2(${rhs});`;
      // Vector-valued with a top-level 3/4-component swizzle → vec3/vec4-shaped,
      // truncate to vec2 (e.g. `vec2 tmp = (uv_orig.xyy*ret.x);`)
      if (/\.[xyzwrgba]{3,4}(?![xyzwrgba])/.test(t))
        return `vec2${decl}(${rhs}).xy;`;
      return `vec2${decl}${rhs};`;
    },
  );

  // 10. vec4 NAME = SCALAR_EXPR - HLSL broadcasts; GLSL rejects.
  // Also: vec4 NAME = tex2D/GetBlur(...) - those return vec3; in HLSL tex2D returned float4
  // (RGBA), so wrap with vec4(result, 1.0) to match the original float4 semantics.
  s = s.replace(
    /\bvec4(\s+\w+\s*=\s*)([^;]+);/g,
    (_m: string, decl: string, rhs: string) => {
      if (/\bvec[234]\s*\(/.test(rhs)) return `vec4${decl}${rhs};`;
      if (/\.[xyzwrgba]{2,}\s*$/.test(rhs.trim())) return `vec4${decl}${rhs};`;
      // tex2D/GetBlur/GetPixel return vec3 (not vec4); wrap so the vec4 variable is filled.
      // tex3D/textureLod/texture already return vec4 - leave unchanged.
      if (/\b(?:tex3D|textureLod|texture)\s*\(/.test(rhs))
        return `vec4${decl}${rhs};`;
      if (/\b(?:GetPixel|GetMain|GetBlur[0-3]|tex2D)\s*\(/.test(rhs))
        return `vec4${decl}vec4(${rhs}, 1.0);`;
      return `vec4${decl}vec4(${rhs});`;
    },
  );

  return s;
}

/**
 * Rewrite HLSL brace initializers for matrices and const arrays into GLSL
 * constructor syntax (rules 11-12).
 */
function rewriteBraceInitializers(s: string): string {
  // 11. Matrix brace initializers: HLSL `mat2 rot = { a, b, c, d };`
  //     → GLSL `mat2 rot = mat2(a, b, c, d);`
  s = s.replace(
    /\b(mat[234](?:x[234])?)\s+(\w+)\s*=\s*\{([^}]+)\};/g,
    "$1 $2 = $1($3);",
  );

  // 12. Array brace initializers: `const vecN name[K] = { ... };`
  //     → GLSL `const vecN name[K] = vecN[K]( ... );`
  //     For vecN elements: group every N scalars into a vecN() constructor.
  s = s.replace(
    /\bconst\s+(vec([234])|float|int)\s+(\w+)\s*\[(\d+)\]\s*=\s*\{([^}]+)\};/g,
    (
      _m: string,
      elemType: string,
      vecDim: string,
      name: string,
      count: string,
      body: string,
    ) => {
      const k = parseInt(count);
      if (!vecDim) {
        return `const ${elemType} ${name}[${count}] = ${elemType}[${count}](${body.replace(/\s+/g, " ").trim()});`;
      }
      const n = parseInt(vecDim);
      const elems = body
        .split(",")
        .map((e: string) => e.trim())
        .filter(Boolean);
      if (elems.length === k) {
        // Already one complete vec per element (e.g. vec4(...) per slot)
        return `const ${elemType} ${name}[${count}] = ${elemType}[${count}](${elems.join(", ")});`;
      }
      // Group n scalars per array element into vecN() constructors
      const grouped: string[] = [];
      for (let i = 0; i < elems.length; i += n) {
        grouped.push(`${elemType}(${elems.slice(i, i + n).join(", ")})`);
      }
      return `const ${elemType} ${name}[${count}] = ${elemType}[${count}](${grouped.join(", ")});`;
    },
  );

  return s;
}

/**
 * Rename HLSL intrinsics to their GLSL (or prologue-helper) equivalents and
 * rewrite float `%` to `mod()`.
 */
function renameIntrinsicFunctions(s: string): string {
  // pow( → _powf( - rename unconditionally so nested-paren first args work too.
  // _powf is defined for all genType pairs including (T,float) broadcast variants.
  s = s.replace(/\bpow\s*\(/g, "_powf(");

  // intrinsic renames
  // lerp → _mix (not mix): our _mix overloads handle HLSL's broadcast semantics
  // where second/third args may be scalar while first is a vector type.
  s = s.replace(/\blerp\s*\(/g, "_mix(");
  s = s.replace(/\bfrac\s*\(/g, "fract(");
  // sqrt/rsqrt/log/log2 → abs-wrapped helpers (DX9-faithful; see environment.ts).
  // log2 before log so `\blog\b` doesn't touch `log2(`. rsqrt before sqrt is not
  // required (`\bsqrt` has no word boundary inside `rsqrt`), but keep them grouped.
  s = s.replace(/\brsqrt\s*\(/g, "_rsqrt(");
  s = s.replace(/\bsqrt\s*\(/g, "_sqrt(");
  s = s.replace(/\blog2\s*\(/g, "_log2f(");
  s = s.replace(/\blog\s*\(/g, "_logf(");
  s = s.replace(/\batan2\s*\(/g, "atan(");
  s = s.replace(/\bfmod\s*\(/g, "mod(");
  s = s.replace(/\bddx\s*\(/g, "dFdx(");
  s = s.replace(/\bddy\s*\(/g, "dFdy(");

  // HLSL `%` on floats: GLSL ES only supports `%` for integers.
  // Replace float modulo patterns with mod(). Handles simple and paren'd LHS.
  s = s.replace(/\(([^()]+)\)\s*%\s*([\w.]+)/g, "mod(($1), $2)");
  s = s.replace(/\b(\w+(?:\.[xyzwrgba]+)?)\s*%\s*([\w.]+)/g, "mod($1, $2)");

  return s;
}

/**
 * Rewrite vector comparison patterns to `step()` and swap min/max argument
 * order where GLSL requires the vector operand first.
 */
function fixVectorComparisons(s: string): string {
  // HLSL comparison operators on vectors: `name *= (name >= scalar)` →
  // `name *= step(scalar, name)`. step(e,x) returns 0.0/1.0 per component.
  s = s.replace(
    /\b(\w+)\s*\*=\s*\(\s*\1\s*(>=|<=|>|<)\s*([\w.]+)\s*\)/g,
    (_, name, op, threshold) => {
      // >= and >: step(threshold, name); <= and <: 1-step
      if (op === ">=" || op === ">")
        return `${name} *= step(${threshold}, ${name})`;
      return `${name} *= (1.0 - step(${threshold}, ${name}))`;
    },
  );

  // GLSL min/max: min(genType, float) requires vector as first arg.
  // Swap args when first is a float literal and second is a vec expression.
  // Handles both plain identifiers and parenthesized expressions as the second arg.
  s = s.replace(
    /\bmin\s*\(\s*([\d.]+)\s*,\s*(\([^()]*\)|[\w.]+(?:\.[xyzwrgba]+)?)\s*\)/g,
    "min($2, $1)",
  );
  s = s.replace(
    /\bmax\s*\(\s*([\d.]+)\s*,\s*(\([^()]*\)|[\w.]+(?:\.[xyzwrgba]+)?)\s*\)/g,
    "max($2, $1)",
  );

  return s;
}

/** Drop HLSL storage qualifiers that GLSL ES does not know. */
function stripStorageQualifiers(s: string): string {
  s = s.replace(/\bstatic\s+const\b/g, "const");
  s = s.replace(/\bstatic\b/g, "");

  return s;
}

/**
 * Truncate vec3-shaped operands multiplied with vec2 texsize/vec2 constants
 * (D3D9 implicitly truncates; GLSL rejects vec3*vec2).
 */
function fixTexsizeTruncations(s: string): string {
  // .xyz * texsize.zw/.xy - vec3*vec2 fails in GLSL; truncate .xyz→.xy.
  // MilkDrop dithering pattern: (tex2D(...).xyz - scalar) * texsize.zw
  s = s.replace(/\.xyz(\s*[-+][^)]*\)\s*\*\s*texsize\.(?:zw|xy))/g, ".xy$1");
  // Also handle bare .xyz followed by arithmetic then * texsize
  s = s.replace(/\.xyz(\s*[-+]\s*[\d.]+\s*\*\s*texsize\.(?:zw|xy))/g, ".xy$1");

  // GetBlurN/GetMain/GetPixel result * vec2 → add .xy (D3D9 implicit vec3→vec2 truncation)
  // e.g. 1.0*GetBlur1(uv)*vec2(0.0,1.0) → 1.0*GetBlur1(uv).xy*vec2(0.0,1.0)
  s = s.replace(
    /\b(GetBlur[0-3]|GetMain|GetPixel)\s*\(([^)]*)\)(?!\s*\.)\s*\*\s*(vec2\s*\()/g,
    "$1($2).xy * $3",
  );

  return s;
}

/**
 * Strip no-op scalar swizzles applied to the float-returning `lum()` helper
 * (HLSL permits scalar swizzles; GLSL rejects them on non-vector types).
 */
function stripLumScalarSwizzles(s: string): string {
  // Strip scalar swizzle from known float-returning function calls: lum(...).x etc.
  // HLSL permits no-op scalar swizzles; GLSL rejects them on non-vector types.
  // Handle 1-level nested parens in lum() argument (e.g. lum(GetPixel(uv)).x)
  const lumArgPat = "([^()]*(?:\\([^()]*\\)[^()]*)*)";
  const lumSwizzleRe = new RegExp(
    `\\blum\\s*\\(${lumArgPat}\\)\\s*\\.[xyzwrgba]\\b`,
    "g",
  );
  s = s.replace(lumSwizzleRe, "lum($1)");
  // Strip when lum is wrapped in outer parens, with optional non-paren prefix:
  // (prefix*lum(...)).x → (prefix*lum(...))
  // Handles: (lum(x)).x, (f0*lum(expr)).x, (f0*lum(multiline_expr)).x
  const lumOuterRe = new RegExp(
    `\\(\\s*[^()]*\\blum\\s*\\(${lumArgPat}\\)\\s*\\)\\s*\\.[xyzwrgba]\\b`,
    "g",
  );
  s = s.replace(lumOuterRe, (m) => m.replace(/\.[xyzwrgba]\s*$/, ""));

  return s;
}

/**
 * Insert the explicit bool↔float conversions GLSL requires: wrap comparison
 * results used in arithmetic with `float()`, and turn `if (floatVar)` into
 * `if (floatVar != 0.0)`.
 */
function fixBoolFloatConversions(s: string): string {
  // HLSL bool→float in arithmetic: (a<=b)*(c>d) → float(a<=b)*float(c>d).
  // HLSL implicitly converts comparison results to float; GLSL does not.
  // Wrap a parenthesized comparison with float() when it is an operand of an
  // arithmetic operator. Skip control-flow conditions, ternaries, and logic ops.
  s = s.replace(
    /\(((?:[^()]|\([^()]*\))*(?:<=|>=|==|!=|<|>)(?:[^()]|\([^()]*\))*)\)/g,
    (m, inner: string, off: number, full: string) => {
      if (/[;?]/.test(inner) || /&&|\|\|/.test(inner)) return m;
      let i = off - 1;
      while (i >= 0 && /\s/.test(full[i]!)) i--;
      const prev = full[i] ?? "";
      let j = off + m.length;
      while (j < full.length && /\s/.test(full[j]!)) j++;
      const next = full[j] ?? "";
      if (/[*+/-]/.test(prev) || /[*+/-]/.test(next)) return `float(${inner})`;
      return m;
    },
  );

  // HLSL implicit float→bool in conditions: if (mask1) → if (mask1 != 0.0).
  // Only bare identifiers (optionally swizzled) - comparisons are already bool.
  s = s.replace(
    /\bif\s*\(\s*([A-Za-z_]\w*(?:\.[xyzwrgba])?)\s*\)/g,
    (m, cond: string) =>
      cond === "true" || cond === "false" ? m : `if (${cond} != 0.0)`,
  );

  return s;
}

/**
 * Turn bare integer literals into float literals (GLSL ES has no implicit
 * int→float), keeping preprocessor conditionals integral.
 */
function floatifyIntegers(s: string): string {
  // float-ify bare integer literals (GLSL ES has no implicit int→float).
  // Conservative: a run of digits not adjacent to word chars or a dot, and not
  // an array index. Domain shaders are mostly straight-line float math.
  s = floatifyLiterals(s);
  // Post-fix: preprocessor conditionals (#if/#elif) must use integer constants;
  // floatifyLiterals may not catch indented # lines, so strip trailing .0 here.
  s = s.replace(/^(\s*#\w+\s+)(\d+)\.0\b/gm, "$1$2");

  return s;
}

/**
 * Strip the remaining no-op scalar swizzles: on declared float variables and
 * on parenthesised expressions that are provably scalar.
 */
function stripRedundantScalarSwizzles(s: string): string {
  // HLSL scalar swizzle: `floatVar.x` is legal in HLSL but not GLSL. After
  // floatify, collect all `float NAME` declarations, then strip `.x`/`.y`/`.z`
  // accesses on those names.
  s = stripScalarSwizzles(s);

  // Strip outer scalar swizzle from parenthesized PRODUCT of two scalar sub-
  // expressions: ((inner_paren_group).[xyzw] * name.[xyzw]).[xyzw]
  // Inner group allows 2 levels of nesting (for GetBlur2(uv + vec2(d,0.0)) etc.)
  // e.g. ((GetBlur2(a)-GetBlur2(b)).x * scale.x).x → ((GetBlur2(a)-GetBlur2(b)).x * scale.x)
  // Deliberately narrow: both operands of * must end with a single-char swizzle.
  s = s.replace(
    /\(\s*\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)\s*\.[xyzwrgba]\s*\*\s*\w+\.[xyzwrgba]\s*\)\s*\.[xyzwrgba]\b/g,
    (m) => m.replace(/\.[xyzwrgba]\s*$/, ""),
  );

  // General: strip (INNER).[xyzw] when INNER is provably a scalar expression.
  // Uses a negative lookbehind to exclude function calls like tex2D(args).x -
  // the paren must NOT be preceded by an identifier character.
  // A vec3-returning call inside INNER is "scalar" iff immediately followed by
  // .[single] (swizzled) or ) (wrapped in lum()/dot()/etc.).
  // If the entire INNER starts with lum/dot/length/distance, it's scalar.
  s = s.replace(
    /(?<![a-zA-Z0-9_])\(([^()]*(?:\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)[^()]*)*)\)\s*\.[xyzwrgba]\b/g,
    (m, inner: string) => {
      // A single bare identifier has an unknowable type here (could be a vec4
      // variable like `(noise9).x`) - keep the swizzle.
      if (/^\s*\w+\s*$/.test(inner)) return m;
      return innerIsScalar(inner) ? `(${inner})` : m;
    },
  );

  // Strip outer multi-char swizzle from parenthesized scalar:
  // (scalar_expr.[single]).[multi] → (scalar_expr.[single])
  // e.g. (GetPixel(uv).x).xy → (GetPixel(uv).x)
  s = s.replace(
    /\(([^()]*\.[xyzwrgba])\)\s*\.[xyzwrgba]{2,}\b/g,
    (m, inner: string) => {
      const t = inner.trimEnd();
      if (
        /\.[xyzwrgba]\s*$/.test(t) &&
        !/\.[xyzwrgba]{2,}\s*$/.test(t) &&
        innerIsScalar(t)
      )
        return `(${inner})`;
      return m;
    },
  );

  return s;
}

/**
 * Wrap float-typed array indices with `int()` (HLSL for-loop counters are
 * floats after the int→float rewrite; GLSL array indices must be integer).
 */
function wrapFloatArrayIndices(s: string): string {
  // GLSL array indices must be integer. Float variables used as indices (HLSL
  // for-loop counters declared as float) must be wrapped with int().
  // Only wrap when the index contains a letter (i.e. it's a variable, not a literal).
  s = s.replace(/\[([^\]]*[a-zA-Z][^\]]*)\]/g, (m, idx: string) => {
    // Skip if already has a cast, or if it's a swizzle / sampler subscript.
    if (/^\s*int\s*\(/.test(idx) || /^\s*uint\s*\(/.test(idx)) return m;
    return `[int(${idx.trim()})]`;
  });

  return s;
}

/**
 * Return true when `inner` (the content of a parenthesised expression) is
 * provably scalar, so that a trailing `.[xyzw]` swizzle on it is a no-op and
 * can be safely stripped.
 *
 * Strategy:
 *  • If `inner` starts with a known scalar-returning function (lum, dot, length,
 *    distance) the whole thing is scalar.
 *  • Otherwise find every vec3-returning call (GetBlurN, GetPixel, tex2D, …)
 *    and check that each one is immediately followed by either:
 *      – a single-char swizzle  →  the call result is taken scalar
 *      – a closing `)`          →  the call is an argument to an outer scalar fn
 *    If any call is "naked" (followed by `*`, `+`, `,`, etc.) the expression is
 *    a vector and we must not strip.
 */
// Returns true when `pos` (the start of a vec3-returning call) sits inside a
// context that makes it scalar.  Two cases:
//   1. It is an argument to lum/dot/length/distance.
//   2. Its immediately-containing paren group is followed by a single-char swizzle,
//      e.g. (GetBlur1(uv) - GetBlur2(uv)).x  - the group as a whole is scalar.
function isInsideScalarFunc(t: string, pos: number): boolean {
  // Walk UP through enclosing paren groups. At each level the vector-ness of
  // the item at `pos` is neutralized if:
  //  - the group is the argument list of a scalar-returning call
  //    (lum/dot/length/distance), or
  //  - the group is the argument list of a sampler call (tex2D/GetBlur/…) whose
  //    return type does not depend on its arguments (the call's own vector-ness
  //    is evaluated separately at its own scan position), or
  //  - the group is followed by a single-char swizzle (scalar selection).
  // Otherwise the group is type-preserving (saturate/abs/min/… or plain parens)
  // and we keep walking up.
  let cur = pos;
  for (;;) {
    let depth = 0;
    let open = -1;
    for (let i = cur - 1; i >= 0; i--) {
      if (t[i] === ")") depth++;
      else if (t[i] === "(") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    if (open < 0) return false;
    const before = t.slice(0, open).trimEnd();
    if (
      /(?:^|[^a-zA-Z0-9_])(?:lum|dot|length|distance|tex2D|tex3D|GetPixel|GetMain|GetBlur[0-3]|textureLod|texture|vec[234])\s*$/.test(
        before,
      )
    )
      return true;
    // Find the matching close of this group; check for a single-char swizzle.
    let j = open + 1;
    let d2 = 1;
    while (j < t.length && d2 > 0) {
      if (t[j] === "(") d2++;
      else if (t[j] === ")") d2--;
      j++;
    }
    while (j < t.length && t[j] === " ") j++;
    if (
      t[j] === "." &&
      /[xyzwrgba]/.test(t[j + 1] ?? "") &&
      !/[xyzwrgba]/.test(t[j + 2] ?? "")
    )
      return true;
    cur = open;
  }
}

/**
 * True when the item at `pos` sits inside the argument list of an UNKNOWN
 * (user-defined) function call. Known type-preserving builtins (sin, fract, …)
 * and plain paren groups are transparent; an unrecognized callee means the
 * expected argument type belongs to that function - don't rewrite the item.
 */
function isInsideUserCall(t: string, pos: number): boolean {
  const KNOWN =
    /(?:^|[^a-zA-Z0-9_])(?:sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|fract|abs|floor|ceil|round|trunc|sqrt|inversesqrt|exp|exp2|log|log2|pow|_powf|min|max|clamp|mod|sign|mix|_mix|smoothstep|step|normalize|saturate|lum|dot|length|distance|tex2D|tex3D|GetPixel|GetMain|GetBlur[0-3]|textureLod|texture|vec[234]|float|mat[234](?:x[234])?)\s*$/;
  let cur = pos;
  for (;;) {
    let depth = 0;
    let open = -1;
    for (let i = cur - 1; i >= 0; i--) {
      if (t[i] === ")") depth++;
      else if (t[i] === "(") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    if (open < 0) return false;
    const before = t.slice(0, open).trimEnd();
    // Plain paren group (no callee) - transparent
    if (!/[a-zA-Z0-9_]$/.test(before)) {
      cur = open;
      continue;
    }
    if (KNOWN.test(before)) {
      cur = open;
      continue;
    }
    return true;
  }
}

function innerIsScalar(inner: string, vec3Names?: Set<string>): boolean {
  const t = inner.trim();
  if (/^(?:lum|dot|length|distance)\s*\(/.test(t)) return true;
  const vec3Re =
    /\b(?:GetBlur[0-3]|GetMain|GetPixel|tex2D|tex3D|vec[234])\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = vec3Re.exec(t)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < t.length && depth > 0) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      i++;
    }
    while (i < t.length && t[i] === " ") i++;
    const ch = t[i] ?? "";
    // Single-component swizzle: the char after '.' must be a swizzle char, but
    // the char AFTER that must NOT be (otherwise .xy/.xyz/etc. would match).
    if (
      ch === "." &&
      /[xyzwrgba]/.test(t[i + 1] ?? "") &&
      !/[xyzwrgba]/.test(t[i + 2] ?? "")
    )
      continue;
    // A closing ')' after the call means it's the last arg of some outer call or group.
    // Use isInsideScalarFunc to check whether that outer context is scalar-returning
    // (e.g. lum/dot/length, or a paren-group followed by a single-char swizzle).
    if (ch === ")") {
      if (isInsideScalarFunc(t, m.index)) continue;
      return false;
    }
    // vec3 call not directly swizzled/closed - but if it lives inside a
    // lum/dot/length/distance call, the surrounding context makes it scalar.
    if (isInsideScalarFunc(t, m.index)) continue;
    return false;
  }
  // A bare multi-component swizzle (foo.xy, foo.xyy, …) is vector-valued unless
  // its enclosing context reduces it to a scalar.
  const multiSwizzleRe = /\.[xyzwrgba]{2,4}\b/g;
  let sw: RegExpExecArray | null;
  while ((sw = multiSwizzleRe.exec(t)) !== null) {
    if (isInsideScalarFunc(t, sw.index)) continue;
    return false;
  }
  // Also treat known vec3 VARIABLES (not just calls) as vector-valued unless
  // they are reduced to a scalar by a single-char swizzle or scalar context.
  if (vec3Names && vec3Names.size > 0) {
    const nameRe = new RegExp(
      `(?<![.\\w])(${[...vec3Names]
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|")})\\b`,
      "g",
    );
    let nm: RegExpExecArray | null;
    while ((nm = nameRe.exec(t)) !== null) {
      let i = nm.index + nm[0].length;
      while (i < t.length && t[i] === " ") i++;
      // Single-component swizzle or array index → scalar component. A longer
      // swizzle is still a vector and falls through to the context check.
      if (t[i] === "[") continue;
      if (
        t[i] === "." &&
        /[xyzwrgba]/.test(t[i + 1] ?? "") &&
        !/[xyzwrgba]/.test(t[i + 2] ?? "")
      )
        continue;
      if (isInsideScalarFunc(t, nm.index)) continue;
      return false;
    }
  }
  return true;
}

/**
 * Collect variable names declared as `float NAME` (or `float NAME = …`) and
 * remove any `.x`, `.y`, `.z` component access on those names. In HLSL a scalar
 * permits `.x` as a no-op; GLSL rejects it.
 */
function stripScalarSwizzles(src: string): string {
  // Collect every `float IDENTIFIER` declaration visible in this chunk.
  const floatVars = new Set<string>();
  for (const m of src.matchAll(/\bfloat\s+(\w+)\b/g)) {
    floatVars.add(m[1]!);
  }
  if (floatVars.size === 0) return src;

  // Build a regex that matches `NAME.x` (or .y/.z/.w) for any of the float names.
  const names = [...floatVars].map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  // Single-char swizzle: strip it (no-op on scalar, HLSL allows it, GLSL rejects).
  const reSingle = new RegExp(`\\b(${names.join("|")})\\.([xyzwrgba])\\b`, "g");
  let result = src.replace(reSingle, "$1");
  // Multi-char all-same swizzle (HLSL scalar broadcast, e.g. float.xxx → vec3):
  // Replace with vecN constructor so GLSL accepts it.
  const reMulti = new RegExp(
    `\\b(${names.join("|")})\\.([xyzwrgba])\\2\\2?\\2?\\b`,
    "g",
  );
  result = result.replace(reMulti, (_m, name) => {
    const n = _m.slice(_m.indexOf(".") + 1).length;
    return `vec${n}(${name})`;
  });
  return result;
}

/**
 * Convert integer literals to float literals (GLSL ES has no implicit int→float),
 * skipping identifiers, hex, existing floats, and (best-effort) array indices.
 * Preprocessor directive lines (starting with #) are left unchanged - the GLSL
 * preprocessor requires integer constants in #if/#elif expressions.
 */
function floatifyLiterals(s: string): string {
  let out = "";
  let lineStart = true;
  let inPreprocessor = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;

    if (c === "\n") {
      out += c;
      lineStart = true;
      inPreprocessor = false;
      continue;
    }
    if (lineStart) {
      lineStart = false;
      if (c === "#") {
        inPreprocessor = true;
      }
    }
    if (inPreprocessor || !/[\d]/.test(c)) {
      out += c;
      continue;
    }

    if (c >= "0" && c <= "9") {
      const prev = i > 0 ? s[i - 1]! : "";
      // part of an identifier or hex or a number with a leading dot
      if (/[\w.]/.test(prev)) {
        out += c;
        continue;
      }
      let j = i;
      while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j++;
      const next = j < s.length ? s[j]! : "";
      if (next === "." || next === "x" || next === "X" || /[\w]/.test(next)) {
        // already a float, hex, or identifier-suffixed - leave as-is
        out += s.slice(i, j);
        i = j - 1;
        continue;
      }
      // array index like [3] - leave integer
      if (prev === "[" && next === "]") {
        out += s.slice(i, j);
        i = j - 1;
        continue;
      }
      out += s.slice(i, j) + ".0";
      i = j - 1;
    } else {
      out += c;
    }
  }
  return out;
}
