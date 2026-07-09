import { Data } from "effect";

export class VaultRegistrationInvalid extends Data.TaggedError("VaultRegistrationInvalid")<{
  message: string;
}> {}

export class VaultRegistryFailed extends Data.TaggedError("VaultRegistryFailed")<{
  message: string;
}> {}

export type VaultError = VaultRegistrationInvalid | VaultRegistryFailed;
