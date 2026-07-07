/**
 * Recursive-descent parser producing the AST node types in `ast.ts`.
 *
 * @remarks
 * Precedence (low → high), faithful to the ns-eel2 dialect:
 *
 * ```text
 *   assignment (= += -= *= /= %= ^= |= &=)   right-assoc
 *   ?:  ternary                              right-assoc
 *   ||                                       left
 *   &&                                       left
 *   |   (bitwise or)                         left
 *   &   (bitwise and)                        left
 *   == !=                                    left
 *   < > <= >=                                left
 *   + -                                      left
 *   * / %                                    left
 *   ^   (pow)                  left, binds tighter than * (per ns-eel)
 *   unary - + !
 *   postfix call / [index]
 *   primary
 * ```
 */

import type { AssignOp, BinaryOp, Node } from "./ast.ts";
import { tokenize, type Token } from "./lexer.ts";

const ASSIGN_OPS = new Set<string>([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "^=",
  "|=",
  "&=",
]);

/**
 * Parse EEL source into an AST.
 *
 * @param src - The expression/program source text.
 * @returns The root AST node (a single statement or a {@link Block}).
 * @throws SyntaxError on a lexical or grammatical error.
 */
export function parse(src: string): Node {
  return new Parser(tokenize(src)).parseProgram();
}

/** Internal recursive-descent parser over a token stream. */
class Parser {
  private toks: Token[];
  private p = 0;

  constructor(toks: Token[]) {
    this.toks = toks;
  }

  private peek(): Token {
    return this.toks[this.p]!;
  }
  private next(): Token {
    return this.toks[this.p++]!;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.type === "op" && t.value === v;
  }
  private eat(type: Token["type"], value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new SyntaxError(
        `Expected ${value ?? type} but found '${t.value || t.type}' at position ${t.pos}`,
      );
    }
    return this.next();
  }

  /** Top level: a ;-separated statement list, value = last statement. */
  parseProgram(): Node {
    const body = this.parseStatements(() => this.peek().type === "eof");
    this.eat("eof");
    return body.length === 1 ? body[0]! : { kind: "block", body };
  }

  private parseStatements(stop: () => boolean): Node[] {
    const body: Node[] = [];
    while (!stop()) {
      // allow empty statements / trailing semicolons
      if (this.peek().type === "semi") {
        this.next();
        continue;
      }
      body.push(this.parseAssignment());
      if (this.peek().type === "semi") this.next();
      else break;
    }
    if (body.length === 0) body.push({ kind: "num", value: 0 });
    return body;
  }

  /** Parse `assignment := ternary ( assignop assignment )?` (right-assoc). */
  private parseAssignment(): Node {
    const left = this.parseTernary();
    if (this.peek().type === "op" && ASSIGN_OPS.has(this.peek().value)) {
      const op = this.next().value as AssignOp;
      const value = this.parseAssignment(); // right-assoc
      if (
        left.kind !== "var" &&
        left.kind !== "call" &&
        left.kind !== "index"
      ) {
        throw new SyntaxError(`Invalid assignment target (${left.kind})`);
      }
      return { kind: "assign", op, target: left, value };
    }
    return left;
  }

  private parseTernary(): Node {
    const cond = this.parseBinary(0);
    if (this.isOp("?")) {
      this.next();
      const then = this.parseAssignment();
      this.eat("op", ":");
      const els = this.parseAssignment();
      return { kind: "ternary", cond, then, else: els };
    }
    return cond;
  }

  /**
   * Precedence-climbing parse of the binary/logical operators.
   *
   * @param minPrec - Minimum operator precedence to consume at this level.
   */
  private parseBinary(minPrec: number): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== "op") break;
      const info = BIN_PREC[t.value];
      if (info === undefined || info.prec < minPrec) break;
      this.next();
      // left-assoc: parse right side with prec+1
      const right = this.parseBinary(info.prec + 1);
      if (t.value === "&&" || t.value === "||") {
        left = { kind: "logical", op: t.value, left, right };
      } else {
        left = { kind: "binary", op: t.value as BinaryOp, left, right };
      }
    }
    return left;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (
      t.type === "op" &&
      (t.value === "-" || t.value === "+" || t.value === "!")
    ) {
      this.next();
      const operand = this.parseUnary();
      return { kind: "unary", op: t.value, operand };
    }
    return this.parsePow();
  }

  /**
   * Parse `^` (pow). It binds tighter than unary (so `-2^2 == -(2^2) == -4`)
   * and is right-associative (so the exponent may itself be unary, e.g.
   * `2^-3`), matching the ns-eel / maths convention.
   */
  private parsePow(): Node {
    const base = this.parsePostfix();
    if (this.isOp("^")) {
      this.next();
      const exp = this.parseUnary();
      return { kind: "binary", op: "^", left: base, right: exp };
    }
    return base;
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    // x[y] indexing (may chain)
    while (this.peek().type === "lbracket") {
      this.next();
      const offset = this.parseAssignment();
      this.eat("rbracket");
      node = { kind: "index", base: node, offset };
    }
    return node;
  }

  /**
   * Parse a single call argument, which may itself be a `;`-separated block
   * (e.g. `loop(8, a=a+1; b=b+2)`). Terminated by `,` or `)`.
   */
  private parseArg(): Node {
    const body = this.parseStatements(() => {
      const t = this.peek().type;
      return t === "comma" || t === "rparen";
    });
    return body.length === 1 ? body[0]! : { kind: "block", body };
  }

  private parsePrimary(): Node {
    const t = this.peek();

    if (t.type === "num") {
      this.next();
      return { kind: "num", value: parseNumber(t.value) };
    }

    if (t.type === "lparen") {
      this.next();
      // Parenthesised block: may contain ;-separated statements.
      const body = this.parseStatements(() => this.peek().type === "rparen");
      this.eat("rparen");
      return body.length === 1 ? body[0]! : { kind: "block", body };
    }

    if (t.type === "ident") {
      this.next();
      if (this.peek().type === "lparen") {
        this.next();
        const args: Node[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseArg());
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseArg());
          }
        }
        this.eat("rparen");
        return { kind: "call", name: t.value, args };
      }
      return { kind: "var", name: t.value };
    }

    throw new SyntaxError(
      `Unexpected token '${t.value || t.type}' at position ${t.pos}`,
    );
  }
}

interface PrecInfo {
  prec: number;
}
const BIN_PREC: Record<string, PrecInfo> = {
  "||": { prec: 1 },
  "&&": { prec: 2 },
  "|": { prec: 3 },
  "&": { prec: 4 },
  "==": { prec: 5 },
  "!=": { prec: 5 },
  "<": { prec: 6 },
  ">": { prec: 6 },
  "<=": { prec: 6 },
  ">=": { prec: 6 },
  "+": { prec: 7 },
  "-": { prec: 7 },
  "*": { prec: 8 },
  "/": { prec: 8 },
  "%": { prec: 8 },
  // "^" is handled in parsePow (tighter than unary), not here.
};

function parseNumber(s: string): number {
  if (s.startsWith("0x") || s.startsWith("0X")) return parseInt(s, 16);
  return parseFloat(s);
}
