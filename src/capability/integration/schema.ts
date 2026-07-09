import { Schema } from "effect";

export const ProviderAuthTypeSchema = Schema.Literal("local", "oauth2", "token", "webhook");
export const ProviderCategorySchema = Schema.Literal("life", "library", "productivity", "health");
export const ProviderStatusSchema = Schema.Literal("connected", "pending", "available", "unavailable");
export const ProviderIdSchema = Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9_.:-]*$/));

export const ProviderDefinitionInputSchema = Schema.Struct({
  id: ProviderIdSchema,
  displayName: Schema.NonEmptyString,
  category: ProviderCategorySchema,
  capabilities: Schema.Array(Schema.NonEmptyString),
  authType: ProviderAuthTypeSchema,
  enabled: Schema.optional(Schema.Boolean),
});

export const ProviderConnectionInputSchema = Schema.Struct({
  settings: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  secrets: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});

export type ProviderAuthType = typeof ProviderAuthTypeSchema.Type;
export type ProviderCategory = typeof ProviderCategorySchema.Type;
export type ProviderStatus = typeof ProviderStatusSchema.Type;
export type ProviderDefinitionInput = typeof ProviderDefinitionInputSchema.Type;
export type ProviderConnectionInput = typeof ProviderConnectionInputSchema.Type;
