import { describe, it, expect } from "vitest";
import { transpile } from "../src/shader/transpile.ts";
import { buildFragmentShader } from "../src/shader/environment.ts";

describe("HLSL → GLSL transpile", () => {
  it("extracts the shader_body block", () => {
    const r = transpile(
      "shader_body\n{\n  ret = tex2D(sampler_main, uv).xyz;\n}",
    );
    expect(r.hasBody).toBe(true);
    expect(r.body).toContain("ret = tex2D(sampler_main, uv).xyz");
  });

  it("translates vector and matrix types", () => {
    const r = transpile(
      "shader_body { float3 a = float3(1.0,0.0,0.0); float3x3 m; }",
    );
    expect(r.body).toContain("vec3 a = vec3(1.0,0.0,0.0)");
    expect(r.body).toContain("mat3 m");
  });

  it("renames intrinsics", () => {
    const r = transpile(
      "shader_body { ret = lerp(a, b, frac(t)); x = rsqrt(y); z = atan2(a,b); }",
    );
    expect(r.body).toContain("_mix(a, b, fract(t))");
    expect(r.body).toContain("_rsqrt(y)");
    expect(r.body).toContain("atan(a,b)");
  });

  it("routes sqrt/log/log2/rsqrt/pow through abs-wrapped helpers (DX9-faithful)", () => {
    const r = transpile(
      "shader_body { a = sqrt(x); b = rsqrt(x); c = log(x); d = log2(x); e = pow(x,y); }",
    );
    // log2 must not be mangled into log(...)2, and log must not touch log2(
    expect(r.body).toContain("_sqrt(x)");
    expect(r.body).toContain("_rsqrt(x)");
    expect(r.body).toContain("_logf(x)");
    expect(r.body).toContain("_log2f(x)");
    expect(r.body).toContain("_powf(x,y)");
    // the helpers themselves apply abs() in the assembled shader prologue
    const full = buildFragmentShader(r, "warp");
    expect(full).toContain("_sqrt(float x){ return sqrt(abs(x)); }");
    expect(full).toContain("_powf(float v, float e){ return pow(abs(v), e); }");
  });

  it("keeps tex2D as named function; maps tex2Dlod to textureLod", () => {
    const r = transpile(
      "shader_body { ret = tex2D(sampler_main, uv).xyz + tex2Dlod(sampler_blur1, float4(uv,0,0)).xyz; }",
    );
    expect(r.body).toContain("tex2D(sampler_main, uv)");
    expect(r.body).toContain("textureLod(sampler_blur1, vec4(uv,0.0,0.0))");
  });

  it("float-ifies bare integer literals but preserves identifiers/swizzles", () => {
    const r = transpile(
      "shader_body { float t = 0; ret *= 2; ret.x = q1; m = float3(1,2,3); }",
    );
    expect(r.body).toContain("float t = 0.0");
    expect(r.body).toContain("ret *= 2.0");
    expect(r.body).toContain("ret.x = q1"); // identifier untouched
    expect(r.body).toContain("vec3(1.0,2.0,3.0)");
  });

  it("does not float-ify inside identifiers like float4 / q1 / _c0", () => {
    const r = transpile("shader_body { float4 v = _c0; x = q12; }");
    // vec4 scalar-broadcast rule wraps plain identifiers with vec4() - valid GLSL
    expect(r.body).toMatch(/vec4 v = (?:vec4\(_c0\)|_c0)/);
    expect(r.body).toContain("x = q12");
  });

  it("collects sampler references including user textures", () => {
    const r = transpile(
      "sampler sampler_mytex;\nshader_body { ret = tex2D(sampler_mytex, uv).xyz + GetBlur1(uv); }",
    );
    expect(r.samplers.has("sampler_mytex")).toBe(true);
  });

  it("keeps preamble helper functions", () => {
    const r = transpile(
      "float myhelper(float x) { return x*2.0; }\nshader_body { ret = myhelper(q1); }",
    );
    expect(r.preamble).toContain("float myhelper(float x)");
  });

  it("maps non-square matrix types (HLSL floatRxC → GLSL matCxR)", () => {
    const r = transpile("shader_body { float3x4 m; float2x2 n; }");
    expect(r.body).toContain("mat4x3 m");
    expect(r.body).toContain("mat2 n");
  });

  it("preserves comments and converts saturate/fmod/ddx", () => {
    const r = transpile(
      "shader_body {\n  // keep me\n  ret = saturate(fmod(time, 1.0));\n  d = ddx(uv.x);\n}",
    );
    expect(r.body).toContain("// keep me");
    expect(r.body).toContain("saturate(mod(time, 1.0))");
    expect(r.body).toContain("dFdx(uv.x)");
  });

  it("strips inline sampler declarations but records them", () => {
    const r = transpile(
      "shader_body { sampler sampler_pw_noise_lq; ret = tex2D(sampler_pw_noise_lq, uv).xyz; }",
    );
    expect(r.body).not.toContain("sampler sampler_pw_noise_lq;");
    expect(r.samplers.has("sampler_pw_noise_lq")).toBe(true);
  });

  it("handles a body with no shader_body wrapper", () => {
    const r = transpile("ret = tex2D(sampler_main, uv).xyz;");
    expect(r.hasBody).toBe(false);
    expect(r.body).toContain("tex2D(sampler_main, uv)");
  });

  it("leaves array indices as integers", () => {
    const r = transpile("shader_body { float a[3]; x = a[2]; }");
    expect(r.body).toContain("a[2]");
    expect(r.body).not.toContain("a[2.0]");
  });

  it("records tex3D samplers separately for sampler3D declaration", () => {
    const r = transpile(
      "shader_body { ret = tex3D(sampler_mynoise, float3(uv,0.5)).xyz; }",
    );
    expect(r.samplers.has("sampler_mynoise")).toBe(true);
    expect(r.samplers3D.has("sampler_mynoise")).toBe(true);
  });

  it("renames pow to the broadcast-safe _powf helper", () => {
    const r = transpile("shader_body { ret = pow(q1, 2.0); }");
    expect(r.body).toContain("_powf(q1, 2.0)");
    expect(r.body).not.toMatch(/\bpow\s*\(/);
  });

  it("treats int declarations as float and int() casts as trunc()", () => {
    const decl = transpile("shader_body { int i = 3; x = i; }");
    expect(decl.body).toContain("float i = 3.0");
    const cast = transpile("shader_body { x = int(q1*5.0); }");
    expect(cast.body).toContain("trunc(q1*5.0)");
  });

  it("rewrites float modulo to mod()", () => {
    const r = transpile("shader_body { float a = time % 4.0; }");
    expect(r.body).toContain("mod(time, 4.0)");
    expect(r.body).not.toContain("%");
  });

  it("broadcasts a scalar RHS to a vec3 declaration", () => {
    const r = transpile("shader_body { float3 c = 0.5; }");
    expect(r.body).toContain("vec3 c = vec3(0.5)");
  });

  it("wraps a tex2D result assigned to a vec4 with alpha 1.0", () => {
    const r = transpile(
      "shader_body { float4 col = tex2D(sampler_main, uv); }",
    );
    expect(r.body).toContain("vec4 col = vec4(tex2D(sampler_main, uv), 1.0)");
  });

  it("wraps a bool comparison assigned to a float with float()", () => {
    const r = transpile("shader_body { float mask = (q1 <= 1.0); }");
    expect(r.body).toContain("float mask = float((q1 <= 1.0))");
  });

  it("converts matrix brace initializers to constructor calls", () => {
    const r = transpile("shader_body { float2x2 m = { 1.0, 0.0, 0.0, 1.0 }; }");
    expect(r.body).toContain("mat2 m = mat2( 1.0, 0.0, 0.0, 1.0 )");
  });

  it("adds .x to vec4 uniforms used as scalars", () => {
    const r = transpile("shader_body { ret = rand_frame * q1; }");
    expect(r.body).toContain("rand_frame.x * q1");
  });

  it("maps half types to float/vec", () => {
    const r = transpile(
      "shader_body { half3 c = half3(1.0,0.0,0.0); half x = 0.5; }",
    );
    expect(r.body).toContain("vec3 c = vec3(1.0,0.0,0.0)");
    expect(r.body).toContain("float x = 0.5");
  });

  it("renames the reserved identifier `output`", () => {
    const r = transpile("shader_body { float output = q1; ret = output; }");
    expect(r.body).toContain("_output");
    expect(r.body).not.toMatch(/\boutput\b/);
  });

  it("swaps min/max args so the vector operand comes first", () => {
    const r = transpile("shader_body { ret = min(0.5, uv.xyy); }");
    expect(r.body).toContain("min(uv.xyy, 0.5)");
  });

  it("hoists uniform-initialized globals into main()", () => {
    const r = transpile(
      "float3 sxy = float3(q4,q5,q6);\nshader_body { ret = sxy; }",
    );
    // declaration stays global without the initializer…
    expect(r.preamble).toContain("vec3 sxy;");
    expect(r.preamble).not.toContain("sxy = vec3(q4");
    // …and the assignment moves to the top of the body
    expect(r.body).toContain("sxy = vec3(q4,q5,q6)");
  });

  it("maps double synonyms (double1→float, doubleN→vecN)", () => {
    const r = transpile(
      "shader_body { double1 a = 1.0; double3 b = double3(1,2,3); }",
    );
    expect(r.body).toContain("float a = 1.0");
    expect(r.body).toContain("vec3 b = vec3(1.0,2.0,3.0)");
  });
});

describe("buildFragmentShader", () => {
  it("produces a complete shader with prologue, main, and ret output", () => {
    const r = transpile(
      "shader_body { ret = tex2D(sampler_main, uv).xyz * decay; }",
    );
    const glsl = buildFragmentShader(r, "comp");
    expect(glsl).toContain("#version 300 es");
    expect(glsl).toContain("uniform sampler2D sampler_main;");
    expect(glsl).toContain("void main()");
    expect(glsl).toContain("vec3 ret = vec3(0.0)");
    expect(glsl).toContain("fragColor = vec4(ret");
    expect(glsl).toContain("ret = tex2D(sampler_main, uv).xyz * decay");
  });
});
