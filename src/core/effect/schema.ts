import { Either, ParseResult, Schema } from "effect";
import { SchemaValidationError } from "./errors";

export function decodeUnknown<A, I>(schema: Schema.Schema<A, I, never>, value: unknown): A {
  const decoded = Schema.decodeUnknownEither(schema)(value);
  if (Either.isRight(decoded)) return decoded.right;
  throw new SchemaValidationError({ message: ParseResult.TreeFormatter.formatErrorSync(decoded.left) });
}

export function decodeUnknownResult<A, I>(schema: Schema.Schema<A, I, never>, value: unknown): { ok: true; value: A } | { ok: false; error: SchemaValidationError } {
  const decoded = Schema.decodeUnknownEither(schema)(value);
  return Either.isRight(decoded)
    ? { ok: true, value: decoded.right }
    : { ok: false, error: new SchemaValidationError({ message: ParseResult.TreeFormatter.formatErrorSync(decoded.left) }) };
}
