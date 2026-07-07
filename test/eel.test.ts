import { describe, it, expect } from "vitest";
import { EelContext, Globals, evalEel, CLOSEFACT } from "../src/eel/index.ts";

const near = (a: number, b: number, eps = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe("arithmetic & precedence", () => {
  it("basic operators", () => {
    near(evalEel("2 + 3 * 4"), 14);
    near(evalEel("(2 + 3) * 4"), 20);
    near(evalEel("10 - 2 - 3"), 5); // left-assoc
    near(evalEel("8 / 4 / 2"), 1); // left-assoc
  });

  it("^ binds tighter than *", () => {
    near(evalEel("2 * 3 ^ 2"), 18); // 2 * (3^2)
    near(evalEel("2 ^ 3"), 8);
  });

  it("unary minus", () => {
    near(evalEel("-2 ^ 2"), -4); // -(2^2): unary lower than ^
    near(evalEel("3 - -2"), 5);
  });

  it("decimal and hex literals", () => {
    near(evalEel(".5 + .25"), 0.75);
    near(evalEel("0x10 + 1"), 17);
    near(evalEel("1e3"), 1000);
  });
});

describe("integer mod (%)", () => {
  it("matches ns-eel: abs operands, 0 on zero divisor", () => {
    near(evalEel("7 % 3"), 1);
    near(evalEel("-7 % 3"), 1); // operands abs'd → positive
    near(evalEel("5 % 0"), 0); // divisor rounds to 0 → 0
    near(evalEel("8 % 5"), 3);
  });
});

describe("bitwise & / | are 64-bit integer ops", () => {
  it("single & and |", () => {
    near(evalEel("6 & 3"), 2);
    near(evalEel("6 | 1"), 7);
    near(evalEel("12 & 10"), 8);
  });
});

describe("comparisons use closefact for equality", () => {
  it("== and !=", () => {
    near(evalEel("1 == 1"), 1);
    near(evalEel("1 == 2"), 0);
    near(evalEel(`1 == (1 + ${CLOSEFACT / 2})`), 1); // within closefact
    near(evalEel(`1 == (1 + ${CLOSEFACT * 2})`), 0); // outside closefact
    near(evalEel("1 != 2"), 1);
  });
  it("relational", () => {
    near(evalEel("3 > 2"), 1);
    near(evalEel("2 > 3"), 0);
    near(evalEel("2 <= 2"), 1);
    near(evalEel("2 >= 3"), 0);
  });
});

describe("logical && || (short-circuit) vs band/bor", () => {
  it("&& and ||", () => {
    near(evalEel("1 && 1"), 1);
    near(evalEel("1 && 0"), 0);
    near(evalEel("0 || 5"), 1); // returns 1, not the value
    near(evalEel("0 || 0"), 0);
  });

  it("&& short-circuits (does not run RHS)", () => {
    const ctx = new EelContext();
    ctx.compile("0 && (ran = 1)").run();
    near(ctx.vars.get("ran"), 0);
    ctx.compile("1 && (ran = 1)").run();
    near(ctx.vars.get("ran"), 1);
  });

  it("band/bor always evaluate both", () => {
    near(evalEel("band(1, 1)"), 1);
    near(evalEel("band(1, 0)"), 0);
    near(evalEel("bor(0, 0)"), 0);
    near(evalEel("bor(0, 0.5)"), 1);
  });
});

describe("assignment & sequencing", () => {
  it("assignment returns the assigned value", () => {
    near(evalEel("x = 5"), 5);
    near(evalEel("x = y = 3"), 3); // right-assoc chained
  });

  it("compound assignment", () => {
    const ctx = new EelContext();
    ctx.vars.set("a", 10);
    near(ctx.compile("a += 5").run(), 15);
    near(ctx.compile("a *= 2").run(), 30);
    near(ctx.compile("a -= 10").run(), 20);
    near(ctx.compile("a /= 4").run(), 5);
  });

  it("statement blocks return last value", () => {
    near(evalEel("a = 1; b = 2; a + b"), 3);
    near(evalEel("(a = 4; a * a)"), 16);
  });

  it("variables persist across runs in a context", () => {
    const ctx = new EelContext();
    ctx.compile("counter = counter + 1").run();
    ctx.compile("counter = counter + 1").run();
    near(ctx.vars.get("counter"), 2);
  });
});

describe("builtin functions", () => {
  it("trig and roots", () => {
    near(evalEel("sin(0)"), 0);
    near(evalEel("cos(0)"), 1);
    near(evalEel("sqrt(16)"), 4);
    near(evalEel("sqr(5)"), 25);
    near(evalEel("pow(2, 10)"), 1024);
    near(evalEel("abs(-3)"), 3);
    near(evalEel("min(2, 7)"), 2);
    near(evalEel("max(2, 7)"), 7);
  });

  it("sign and int", () => {
    near(evalEel("sign(-4)"), -1);
    near(evalEel("sign(0)"), 0);
    near(evalEel("sign(2)"), 1);
    near(evalEel("int(3.9)"), 3);
    near(evalEel("int(-3.9)"), -3);
  });

  it("sigmoid", () => {
    near(evalEel("sigmoid(0, 1)"), 0.5);
  });

  it("above / below / equal / bnot", () => {
    near(evalEel("above(3, 2)"), 1);
    near(evalEel("above(2, 3)"), 0);
    near(evalEel("above(2, 2)"), 0);
    near(evalEel("below(2, 3)"), 1);
    near(evalEel("below(3, 2)"), 0);
    near(evalEel("below(2, 2)"), 0);
    near(evalEel(`equal(1, 1 + ${CLOSEFACT / 2})`), 1); // within closefact
    near(evalEel(`equal(1, 1 + ${CLOSEFACT * 2})`), 0); // outside closefact
    near(evalEel("equal(1, 2)"), 0);
    near(evalEel("bnot(0)"), 1);
    near(evalEel("bnot(1)"), 0);
    near(evalEel("bnot(0.5)"), 0);
  });

  it("if is lazy (only taken branch runs)", () => {
    const ctx = new EelContext();
    ctx.compile("if(0, a = 1, b = 1)").run();
    near(ctx.vars.get("a"), 0);
    near(ctx.vars.get("b"), 1);
  });

  it("ternary lowers to if", () => {
    near(evalEel("1 > 0 ? 10 : 20"), 10);
    near(evalEel("1 < 0 ? 10 : 20"), 20);
  });

  it("loop accumulates", () => {
    near(evalEel("acc = 0; loop(5, acc = acc + 2); acc"), 10);
  });

  it("while counts down", () => {
    near(evalEel("i = 3; n = 0; while(n = n + 1; i = i - 1); n"), 3);
  });

  it("exec2 / exec3 return last", () => {
    near(evalEel("exec2(1, 2)"), 2);
    near(evalEel("exec3(1, 2, 3)"), 3);
  });
});

describe("megabuf / gmegabuf", () => {
  it("stores and reads back; unwritten cells are 0", () => {
    const ctx = new EelContext();
    near(ctx.compile("megabuf(100)").run(), 0);
    ctx.compile("megabuf(100) = 42").run();
    near(ctx.compile("megabuf(100)").run(), 42);
  });

  it("compound assignment to megabuf evaluates index once", () => {
    const ctx = new EelContext();
    ctx.compile("megabuf(7) = 10; megabuf(7) += 5").run();
    near(ctx.compile("megabuf(7)").run(), 15);
  });

  it("gmegabuf is shared across contexts", () => {
    const globals = new Globals();
    const a = new EelContext(globals);
    const b = new EelContext(globals);
    a.compile("gmegabuf(3) = 99").run();
    near(b.compile("gmegabuf(3)").run(), 99);
  });

  it("global registers reg00..reg99 are shared", () => {
    const globals = new Globals();
    const a = new EelContext(globals);
    const b = new EelContext(globals);
    a.compile("reg05 = 7").run();
    near(b.compile("reg05").run(), 7);
  });
});

describe("comments and whitespace", () => {
  it("ignores // and /* */ comments", () => {
    near(evalEel("a = 5; // set a\n a + 1 /* inline */ + 1"), 7);
  });
});

describe("milkdrop-style per-frame snippet", () => {
  it("runs a representative block", () => {
    const ctx = new EelContext();
    ctx.vars.set("bass", 1.5);
    ctx.vars.set("time", 2.0);
    const prog = ctx.compile(`
      vol = bass;
      zoom = 1.0 + 0.02*sin(time) + 0.01*vol;
      rot = 0.02*cos(time*0.7);
      q1 = vol;
    `);
    prog.run();
    expect(ctx.vars.get("zoom")).toBeGreaterThan(0.9);
    near(ctx.vars.get("q1"), 1.5);
  });
});
