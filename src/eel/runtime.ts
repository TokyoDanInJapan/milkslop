/**
 * Compiles the AST to nested JS closures (no `eval`) and runs them against an
 * {@link EelContext}.
 *
 * @remarks
 * Semantics are matched to ns-eel2 (see the per-operator notes inline). Each AST
 * node compiles to a `() =\> number` closure that reads/writes the context's
 * variable pool and memory directly, so per-pixel evaluation stays cheap.
 */

import type { AssignOp, BinaryOp, Node, UnaryOp } from "./ast.ts";
import { parse } from "./parser.ts";
import { Megabuf } from "./megabuf.ts";
import { VarPool } from "./varpool.ts";
import { Globals, globalRegIndex } from "./globals.ts";
import { constants } from "../config.ts";

/** ns-eel "closeness" factor: values within this of zero count as zero/equal. */
export const CLOSEFACT = constants.eel.closefact;

/** Max iterations for loop()/while() - guards against runaway preset code. */
const MAX_LOOP = constants.eel.maxLoop;

/** A compiled expression node: evaluate it to produce a number. */
type CNode = () => number;

/** ns-eel truthiness: `|x|` strictly greater than {@link CLOSEFACT}. */
const truthy = (x: number): boolean => Math.abs(x) > CLOSEFACT;

// --- scalar operator implementations -------------------------------------

/**
 * The `%` operator. ns-eel takes `fabs` of both operands, converts to int
 * (round), and returns 0 if the divisor rounds to 0.
 */
function eelMod(a: number, b: number): number {
  const ib = Math.round(Math.abs(b));
  if (ib === 0) return 0;
  return Math.round(Math.abs(a)) % ib;
}

/** Round to the nearest integer and widen to `bigint` (0 if non-finite). */
function toInt64(x: number): bigint {
  const r = Math.round(x);
  return Number.isFinite(r) ? BigInt(r) : 0n;
}
/** The `|` operator: bitwise OR on 64-bit integers. */
const eelOr = (a: number, b: number): number => Number(toInt64(a) | toInt64(b));
/** The `&` operator: bitwise AND on 64-bit integers. */
const eelAnd = (a: number, b: number): number =>
  Number(toInt64(a) & toInt64(b));

/** Apply an arithmetic/bitwise operator (shared by binary and compound assign). */
function applyArith(op: AssignOp | BinaryOp, a: number, b: number): number {
  switch (op) {
    case "+":
    case "+=":
      return a + b;
    case "-":
    case "-=":
      return a - b;
    case "*":
    case "*=":
      return a * b;
    case "/":
    case "/=":
      return a / b;
    case "%":
    case "%=":
      return eelMod(a, b);
    case "^":
    case "^=":
      return Math.pow(a, b);
    case "|":
    case "|=":
      return eelOr(a, b);
    case "&":
    case "&=":
      return eelAnd(a, b);
    default:
      throw new Error(`not an arithmetic op: ${op}`);
  }
}

/** Apply a comparison operator, returning 1/0 (`==`/`!=` use {@link CLOSEFACT}). */
function applyCompare(op: BinaryOp, a: number, b: number): number {
  switch (op) {
    case "==":
      return Math.abs(a - b) <= CLOSEFACT ? 1 : 0;
    case "!=":
      return Math.abs(a - b) > CLOSEFACT ? 1 : 0;
    case "<":
      return a < b ? 1 : 0;
    case ">":
      return a > b ? 1 : 0;
    case "<=":
      return a <= b ? 1 : 0;
    case ">=":
      return a >= b ? 1 : 0;
    default:
      throw new Error(`not a compare op: ${op}`);
  }
}

/** Apply a prefix unary operator (`!` uses {@link CLOSEFACT} truthiness). */
function applyUnary(op: UnaryOp, x: number): number {
  switch (op) {
    case "-":
      return -x;
    case "+":
      return x;
    case "!":
      return truthy(x) ? 0 : 1;
  }
}

// --- lvalue resolution ----------------------------------------------------

/** A resolved assignable location: a paired value reader and writer. */
interface LValue {
  load: CNode;
  /** Store a value; returns the stored value. */
  store: (v: number) => number;
}

// --- the compiler ---------------------------------------------------------

/**
 * A self-contained evaluation context: its own variable pool and `megabuf`,
 * plus a shared {@link Globals} (`gmegabuf` + registers). Multiple code blocks
 * compiled against one context share variables; separate contexts are isolated
 * except for the shared globals.
 */
export class EelContext {
  /** Named local variables for this context. */
  readonly vars: VarPool;
  /** This context's private `megabuf` RAM. */
  readonly mega: Megabuf;
  /** Cross-preset globals (`gmegabuf` + `reg00`..`reg99`). */
  readonly globals: Globals;

  /**
   * @param globals - Shared globals; defaults to a fresh isolated instance.
   */
  constructor(globals: Globals = new Globals()) {
    this.vars = new VarPool();
    this.mega = new Megabuf();
    this.globals = globals;
  }

  /**
   * Parse and compile a code block against this context.
   *
   * @param code - EEL source (one or more `;`-separated statements).
   * @returns A runnable {@link EelProgram}.
   * @throws SyntaxError on a parse/compile error.
   */
  compile(code: string): EelProgram {
    const ast = parse(code);
    const fn = this.compileNode(ast);
    return new EelProgram(fn);
  }

  /** Resolve a variable name to a load/store pair (global reg or local slot). */
  private resolveVar(name: string): LValue {
    const g = globalRegIndex(name);
    if (g >= 0) {
      const regs = this.globals.regs;
      return {
        load: () => regs[g]!,
        store: (v) => (regs[g] = v),
      };
    }
    const pool = this.vars;
    const idx = pool.index(name);
    return {
      load: () => pool.buf[idx]!,
      store: (v) => (pool.buf[idx] = v),
    };
  }

  private compileNode(node: Node): CNode {
    switch (node.kind) {
      case "num": {
        const v = node.value;
        return () => v;
      }
      case "var": {
        const lv = this.resolveVar(node.name);
        return lv.load;
      }
      case "unary": {
        const op = node.op;
        const operand = this.compileNode(node.operand);
        return () => applyUnary(op, operand());
      }
      case "binary": {
        const op = node.op;
        const l = this.compileNode(node.left);
        const r = this.compileNode(node.right);
        if (
          op === "==" ||
          op === "!=" ||
          op === "<" ||
          op === ">" ||
          op === "<=" ||
          op === ">="
        ) {
          return () => applyCompare(op, l(), r());
        }
        return () => applyArith(op, l(), r());
      }
      case "logical": {
        const l = this.compileNode(node.left);
        const r = this.compileNode(node.right);
        if (node.op === "&&") {
          return () => (truthy(l()) ? (truthy(r()) ? 1 : 0) : 0);
        }
        return () => (truthy(l()) ? 1 : truthy(r()) ? 1 : 0);
      }
      case "ternary": {
        const c = this.compileNode(node.cond);
        const t = this.compileNode(node.then);
        const e = this.compileNode(node.else);
        return () => (truthy(c()) ? t() : e());
      }
      case "block": {
        const stmts = node.body.map((s) => this.compileNode(s));
        const n = stmts.length;
        if (n === 1) return stmts[0]!;
        return () => {
          let v = 0;
          for (let i = 0; i < n; i++) v = stmts[i]!();
          return v;
        };
      }
      case "index": {
        const base = this.compileNode(node.base);
        const off = this.compileNode(node.offset);
        const mega = this.mega;
        return () => mega.get(base() + off());
      }
      case "assign":
        return this.compileAssign(node.op, node.target, node.value);
      case "call":
        return this.compileCall(node.name, node.args);
    }
  }

  private compileAssign(op: AssignOp, target: Node, valueNode: Node): CNode {
    const val = this.compileNode(valueNode);

    // Target: plain variable / global register.
    if (target.kind === "var") {
      const lv = this.resolveVar(target.name);
      if (op === "=") return () => lv.store(val());
      const { load, store } = lv;
      return () => store(applyArith(op, load(), val()));
    }

    // Target: megabuf(i) / gmegabuf(i).
    if (target.kind === "call") {
      const buf = this.bufferForCall(target.name);
      const addr = this.compileNode(target.args[0]!);
      if (op === "=") {
        return () => buf.set(addr(), val());
      }
      return () => {
        const a = addr();
        return buf.set(a, applyArith(op, buf.get(a), val()));
      };
    }

    // Target: base[offset] → local megabuf at (base + offset).
    if (target.kind === "index") {
      const mega = this.mega;
      const base = this.compileNode(target.base);
      const off = this.compileNode(target.offset);
      if (op === "=") {
        return () => mega.set(base() + off(), val());
      }
      return () => {
        const a = base() + off();
        return mega.set(a, applyArith(op, mega.get(a), val()));
      };
    }

    throw new SyntaxError(`Invalid assignment target: ${target.kind}`);
  }

  private bufferForCall(name: string): Megabuf {
    if (name === "megabuf" || name === "_mem") return this.mega;
    if (name === "gmegabuf" || name === "_gmem" || name === "gmem")
      return this.globals.gmegabuf;
    throw new SyntaxError(`Cannot assign to ${name}()`);
  }

  private compileCall(name: string, argNodes: Node[]): CNode {
    const args = argNodes.map((a) => this.compileNode(a));
    const arity = (n: number) => {
      if (args.length !== n) {
        throw new SyntaxError(
          `${name}() expects ${n} argument(s), got ${args.length}`,
        );
      }
    };

    // --- special forms (lazy / control flow) ---
    switch (name) {
      case "if": {
        arity(3);
        const [c, t, e] = args as [CNode, CNode, CNode];
        return () => (truthy(c()) ? t() : e());
      }
      case "loop": {
        arity(2);
        const [count, body] = args as [CNode, CNode];
        return () => {
          let n = Math.floor(count());
          if (n > MAX_LOOP) n = MAX_LOOP;
          let v = 0;
          for (let i = 0; i < n; i++) v = body();
          return v;
        };
      }
      case "while": {
        arity(1);
        const body = args[0]!;
        return () => {
          let v = 0;
          let guard = MAX_LOOP;
          do {
            v = body();
          } while (truthy(v) && --guard > 0);
          return v;
        };
      }
      case "exec2": {
        arity(2);
        const [a, b] = args as [CNode, CNode];
        return () => {
          a();
          return b();
        };
      }
      case "exec3": {
        arity(3);
        const [a, b, c] = args as [CNode, CNode, CNode];
        return () => {
          a();
          b();
          return c();
        };
      }
      case "megabuf":
      case "_mem": {
        arity(1);
        const a = args[0]!;
        const mega = this.mega;
        return () => mega.get(a());
      }
      case "gmegabuf":
      case "_gmem":
      case "gmem": {
        arity(1);
        const a = args[0]!;
        const g = this.globals.gmegabuf;
        return () => g.get(a());
      }
      case "freembuf": {
        arity(1);
        const mega = this.mega;
        return () => {
          mega.free();
          return 0;
        };
      }
      case "memset": {
        arity(3);
        const [d, v, l] = args as [CNode, CNode, CNode];
        const mega = this.mega;
        return () => mega.memset(d(), v(), l());
      }
      case "memcpy": {
        arity(3);
        const [d, s, l] = args as [CNode, CNode, CNode];
        const mega = this.mega;
        return () => mega.memcpy(d(), s(), l());
      }
      case "rand": {
        arity(1);
        const a = args[0]!;
        return () => {
          let x = Math.floor(a());
          if (x < 1) x = 1;
          return Math.random() * x; // non-EEL1-compat: float in [0, x)
        };
      }
    }

    // --- eager unary math ---
    const u = UNARY_FNS[name];
    if (u) {
      arity(1);
      const a = args[0]!;
      return () => u(a());
    }

    // --- eager binary math ---
    const b = BINARY_FNS[name];
    if (b) {
      arity(2);
      const [x, y] = args as [CNode, CNode];
      return () => b(x(), y());
    }

    throw new SyntaxError(`Unknown function '${name}'`);
  }
}

/** A compiled, runnable EEL code block bound to its {@link EelContext}. */
export class EelProgram {
  /** @param fn - The compiled root closure. */
  constructor(private fn: CNode) {}

  /**
   * Execute the program.
   *
   * @returns The value of the last statement.
   */
  run(): number {
    return this.fn();
  }
}

/** The `sign` built-in: -1, 0, or 1. */
function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Eager single-argument math built-ins. */
const UNARY_FNS: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  sqr: (x) => x * x,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  sign,
  invsqrt: (x) => 1 / Math.sqrt(x),
  // int() - integer part toward zero. (NS-EEL2 lacks `int`; MilkDrop docs call
  // it "integer part". Verify direction against reference presets if needed.)
  int: Math.trunc,
  bnot: (x) => (truthy(x) ? 0 : 1),
};

/** Eager two-argument math built-ins. */
const BINARY_FNS: Record<string, (a: number, b: number) => number> = {
  atan2: Math.atan2,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  sigmoid: (x, c) => {
    const t = 1 + Math.exp(-x * c);
    return Math.abs(t) > CLOSEFACT ? 1 / t : 0;
  },
  band: (a, b) => (truthy(a) && truthy(b) ? 1 : 0),
  bor: (a, b) => (truthy(a) || truthy(b) ? 1 : 0),
  above: (a, b) => (a > b ? 1 : 0),
  below: (a, b) => (a < b ? 1 : 0),
  equal: (a, b) => (Math.abs(a - b) <= CLOSEFACT ? 1 : 0),
};

/** Convenience: compile + run a snippet against a fresh context. */
export function evalEel(
  code: string,
  vars: Record<string, number> = {},
): number {
  const ctx = new EelContext();
  for (const [k, v] of Object.entries(vars)) ctx.vars.set(k.toLowerCase(), v);
  return ctx.compile(code).run();
}
