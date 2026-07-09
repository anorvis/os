import { Data } from "effect";

export class SchemaValidationError extends Data.TaggedError("SchemaValidationError")<{
  message: string;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  message: string;
}> {}

export class ConflictError extends Data.TaggedError("ConflictError")<{
  message: string;
}> {}

export class InvalidStateError extends Data.TaggedError("InvalidStateError")<{
  message: string;
}> {}

export type HttpEffectError = SchemaValidationError | NotFoundError | ConflictError | InvalidStateError;
