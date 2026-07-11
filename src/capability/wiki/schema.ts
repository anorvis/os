import { Schema } from "effect";

export const VaultEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  addedAt: Schema.optional(Schema.String),
});

export const VaultRegistrySchema = Schema.Struct({
  vaults: Schema.Array(VaultEntrySchema),
});

export const VaultRegistrationInputSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  path: Schema.NonEmptyString,
});

export const WikiAgentRequestSchema = Schema.Struct({
  task: Schema.optional(Schema.String),
  vault: Schema.optional(Schema.String),
  allowWeb: Schema.optional(Schema.Boolean),
  dryRun: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(Schema.Positive),
});

export type VaultEntry = typeof VaultEntrySchema.Type;
export type VaultRegistry = typeof VaultRegistrySchema.Type;
export type VaultRegistrationInput = typeof VaultRegistrationInputSchema.Type;
export type WikiAgentRequest = typeof WikiAgentRequestSchema.Type;
