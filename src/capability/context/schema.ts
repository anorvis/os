import { Schema } from "effect";

export const ContextSurfaceSchema = Schema.Literal(
  "pi",
  "discord",
  "web",
  "sms",
  "integration",
  "system",
);

export const ContextVisibilitySchema = Schema.Literal("private", "shared");

export const ContextEventKindSchema = Schema.Literal(
  "conversation_turn",
  "integration_update",
  "agent_action",
  "context_note",
);

export const ContextEventSourceSchema = Schema.Struct({
  surface: ContextSurfaceSchema,
  principalId: Schema.optional(Schema.NonEmptyString),
  conversationId: Schema.NonEmptyString,
  visibility: ContextVisibilitySchema,
  workspaceId: Schema.optional(Schema.NonEmptyString),
  channelId: Schema.optional(Schema.NonEmptyString),
  threadId: Schema.optional(Schema.NonEmptyString),
});
export const ContextEventAttachmentSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  mediaType: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

export type ContextEventAttachment = typeof ContextEventAttachmentSchema.Type;


export const ContextEventContentSchema = Schema.Struct({
  text: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  assistant: Schema.optional(Schema.Unknown),
  toolResults: Schema.optional(Schema.Unknown),
  resource: Schema.optional(Schema.NonEmptyString),
  resourceId: Schema.optional(Schema.NonEmptyString),
  attachments: Schema.optional(Schema.Array(ContextEventAttachmentSchema)),
});

export const ContextEventInputSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: ContextEventKindSchema,
  occurredAt: Schema.Number,
  source: ContextEventSourceSchema,
  content: ContextEventContentSchema,
});

export type ContextSurface = typeof ContextSurfaceSchema.Type;
export type ContextVisibility = typeof ContextVisibilitySchema.Type;
export type ContextEventKind = typeof ContextEventKindSchema.Type;
export type ContextEventSource = typeof ContextEventSourceSchema.Type;
export type ContextEventContent = typeof ContextEventContentSchema.Type;
export type ContextEventInput = typeof ContextEventInputSchema.Type;
