import { Data } from "effect";

export class InvalidProviderInput extends Data.TaggedError("InvalidProviderInput")<{
  message: string;
}> {}

export class ProviderNotFound extends Data.TaggedError("ProviderNotFound")<{
  providerId: string;
}> {}

export class ProviderSecretFailed extends Data.TaggedError("ProviderSecretFailed")<{
  message: string;
}> {}

export type ProviderError = InvalidProviderInput | ProviderNotFound | ProviderSecretFailed;
