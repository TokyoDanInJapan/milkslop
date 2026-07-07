/**
 * Tokenizer for the MilkDrop expression language.
 *
 * @remarks
 * Identifiers are case-insensitive (lower-cased here); `//` and block comments
 * are stripped; numbers may have a fraction/exponent or be `0x` hex literals.
 */

/** The kinds of token produced by {@link tokenize}. */
export type TokenType =
  | "num"
  | "ident"
  | "op"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "semi"
  | "eof";

/** A single lexical token. */
export interface Token {
  type: TokenType;
  /** The raw lexeme (lower-cased for identifiers). */
  value: string;
  /** Byte offset of the token in the source (for error messages). */
  pos: number;
}

// Multi-char operators must be tried before single-char ones.
const MULTI_OPS = [
  "<<=",
  ">>=", // tolerated, not semantically distinct from below in practice
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "^=",
  "|=",
  "&=",
];
const SINGLE_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "&",
  "|",
  "=",
  "<",
  ">",
  "!",
  "?",
  ":",
]);

/**
 * Tokenize EEL source into a flat token list ending in an `eof` token.
 *
 * @param src - The expression/program source text.
 * @returns The token stream.
 * @throws SyntaxError on an unexpected character.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isIdentStart = (c: string) =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
  const isIdentChar = (c: string) => isIdentStart(c) || isDigit(c);

  while (i < n) {
    const c = src[i]!;

    // whitespace
    if (
      c === " " ||
      c === "\t" ||
      c === "\r" ||
      c === "\n" ||
      c === "\f" ||
      c === "\v"
    ) {
      i++;
      continue;
    }

    // comments
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // numbers: 0x hex, or decimal with optional . and exponent
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i]!)) i++;
        tokens.push({ type: "num", value: src.slice(start, i), pos: start });
        continue;
      }
      while (i < n && isDigit(src[i]!)) i++;
      if (src[i] === ".") {
        i++;
        while (i < n && isDigit(src[i]!)) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        while (i < n && isDigit(src[i]!)) i++;
      }
      tokens.push({ type: "num", value: src.slice(start, i), pos: start });
      continue;
    }

    // identifiers (lower-cased; ns-eel is case-insensitive)
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentChar(src[i]!)) i++;
      tokens.push({
        type: "ident",
        value: src.slice(start, i).toLowerCase(),
        pos: start,
      });
      continue;
    }

    // punctuation
    if (c === "(") {
      tokens.push({ type: "lparen", value: c, pos: i++ });
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", value: c, pos: i++ });
      continue;
    }
    if (c === "[") {
      tokens.push({ type: "lbracket", value: c, pos: i++ });
      continue;
    }
    if (c === "]") {
      tokens.push({ type: "rbracket", value: c, pos: i++ });
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "comma", value: c, pos: i++ });
      continue;
    }
    if (c === ";") {
      tokens.push({ type: "semi", value: c, pos: i++ });
      continue;
    }

    // operators (multi-char first)
    const two = src.substr(i, 3);
    let matched = "";
    for (const op of MULTI_OPS) {
      if (two.startsWith(op)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      tokens.push({ type: "op", value: matched, pos: i });
      i += matched.length;
      continue;
    }
    if (SINGLE_OPS.has(c)) {
      tokens.push({ type: "op", value: c, pos: i++ });
      continue;
    }

    throw new SyntaxError(`Unexpected character '${c}' at position ${i}`);
  }

  tokens.push({ type: "eof", value: "", pos: i });
  return tokens;
}
