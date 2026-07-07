/**
 * Public surface of the EEL expression engine: tokenizer, parser, AST types,
 * the runtime/compiler, and the variable/memory stores.
 */
export { tokenize } from "./lexer.ts";
export { parse } from "./parser.ts";
export type * from "./ast.ts";
export { Megabuf, MEGABUF_SIZE } from "./megabuf.ts";
export { VarPool } from "./varpool.ts";
export { Globals } from "./globals.ts";
export { EelContext, EelProgram, evalEel, CLOSEFACT } from "./runtime.ts";
