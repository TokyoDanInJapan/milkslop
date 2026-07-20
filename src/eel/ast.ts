/**
 * AST for the MilkDrop expression language (NS-EEL2 dialect).
 *
 * @remarks
 * Surface syntax is faithful to ns-eel2's `preprocessCode` + base grammar (see
 * `ns-eel2/nseel-compiler.c`): infix `== != < > <= >=`, `&&` / `||` (logical,
 * short-circuit), single `&` / `|` (64-bit bitwise), `%` (integer mod), `^`
 * (pow), compound assignment ops, and the ternary `?:` which lowers to `if()`.
 */

/** Any AST node, discriminated by its `kind`. */
export type Node =
  | NumberLit
  | Var
  | Assign
  | Unary
  | Binary
  | Logical
  | Ternary
  | Call
  | Index
  | Block;

/** A numeric literal. */
export interface NumberLit {
  kind: "num";
  value: number;
}

/** A variable reference (or global register). */
export interface Var {
  kind: "var";
  /** Variable name, already lower-cased. */
  name: string;
}

/** Assignment operators: plain `=` and the compound forms. */
export type AssignOp =
  "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=" | "|=" | "&=";

/** An assignment to an lvalue. */
export interface Assign {
  kind: "assign";
  op: AssignOp;
  /** The lvalue: a variable, `megabuf()`/`gmegabuf()`, or `x[y]`. */
  target: Var | Call | Index;
  value: Node;
}

/** Prefix unary operators. */
export type UnaryOp = "-" | "+" | "!";

/** A unary-operator application. */
export interface Unary {
  kind: "unary";
  op: UnaryOp;
  operand: Node;
}

/** Eager binary operators (arithmetic, bitwise, comparison). */
export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "^"
  | "|"
  | "&"
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">=";

/** A binary-operator application. */
export interface Binary {
  kind: "binary";
  op: BinaryOp;
  left: Node;
  right: Node;
}

/**
 * A short-circuit `&&` / `||`. Kept distinct from the eager bitwise `&` / `|`
 * in {@link Binary}.
 */
export interface Logical {
  kind: "logical";
  op: "&&" | "||";
  left: Node;
  right: Node;
}

/** A ternary `cond ? then : else` (lazy; lowers to `if`). */
export interface Ternary {
  kind: "ternary";
  cond: Node;
  then: Node;
  else: Node;
}

/** A function call (built-in or special form). */
export interface Call {
  kind: "call";
  /** Function name, already lower-cased. */
  name: string;
  args: Node[];
}

/** Indexed megabuf access `base[offset]` (base + offset), per EEL2 semantics. */
export interface Index {
  kind: "index";
  base: Node;
  offset: Node;
}

/** A `;`-separated sequence; evaluates to the value of the last statement. */
export interface Block {
  kind: "block";
  body: Node[];
}
