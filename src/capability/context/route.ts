import { Schema } from "effect";
import { decodeUnknownResult } from "../../core/effect/schema";
import { json, parseJsonRequest } from "../../core/http/http";
import type { RouteRegistrar } from "../../core/service/service";
import {
  type ContextCapabilityClient,
  type ContextOutboundRequest,
} from "./client";
import { ContextEventInputSchema } from "./schema";

const ScopeSchema = Schema.Struct({
  kind: Schema.Literal("owner", "workspace", "channel"),
  ownerId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  channelId: Schema.optional(Schema.String),
  scopeId: Schema.optional(Schema.String),
});
const AppendRequestSchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.String),
  id: ContextEventInputSchema.fields.id,
  kind: ContextEventInputSchema.fields.kind,
  occurredAt: ContextEventInputSchema.fields.occurredAt,
  source: ContextEventInputSchema.fields.source,
  content: ContextEventInputSchema.fields.content,
});
const CompileRequestSchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.String),
  scope: ScopeSchema,
  query: Schema.optional(Schema.String),
  since: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
});
const OutboundRequestSchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.String),
  id: Schema.NonEmptyString,
  destination: Schema.Struct({
    surface: Schema.Literal("pi", "discord", "web", "sms", "integration", "system"),
    channelId: Schema.NonEmptyString,
    threadId: Schema.optional(Schema.String),
    conversationId: Schema.optional(Schema.String),
  }),
  text: Schema.NonEmptyString,
  attachments: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    mediaType: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
  }))),
  replyToId: Schema.optional(Schema.String),
  nextAttemptAt: Schema.optional(Schema.Number),
});

export type ContextRouteOptions = {
  contextClient?: ContextCapabilityClient;
};

export function contextRoutes(options: ContextRouteOptions): RouteRegistrar {
  const unavailable = () => json({ error: "context client is not configured" }, 503);
  const append = async (request: Request): Promise<Response> => {
    if (options.contextClient === undefined) return unavailable();
    const parsed = await parseJsonRequest(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const input = decodeUnknownResult(AppendRequestSchema, parsed.value);
    if (!input.ok) return json({ error: input.error.message }, 400);
    const result = await options.contextClient.append(input.value);
    return json(result);
  };
  const compile = async (request: Request): Promise<Response> => {
    if (options.contextClient === undefined) return unavailable();
    const parsed = await parseJsonRequest(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const input = decodeUnknownResult(CompileRequestSchema, parsed.value);
    if (!input.ok) return json({ error: input.error.message }, 400);
    const result = await options.contextClient.compile(input.value);
    return json(result);
  };
  const outbound = async (request: Request): Promise<Response> => {
    if (options.contextClient === undefined) return unavailable();
    const parsed = await parseJsonRequest(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const input = decodeUnknownResult(OutboundRequestSchema, parsed.value);
    if (!input.ok) return json({ error: input.error.message }, 400);
    const result = await options.contextClient.enqueueOutbound(input.value as ContextOutboundRequest);
    return json(result);
  };
  return (app) => {
    app.post("/v1/context/events", (c) => append(c.req.raw));
    app.post("/v1/context/append", (c) => append(c.req.raw));
    app.post("/v1/context/compile", (c) => compile(c.req.raw));
    app.post("/v1/context/outbound", (c) => outbound(c.req.raw));
  };
}

export type { ContextCompileRequest, ContextOutboundRequest, ContextScopeRequest } from "./client";
