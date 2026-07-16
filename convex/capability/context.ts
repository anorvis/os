import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { requireWorkspace, type WorkspaceAccess } from "../platform/auth/access";

const eventKind = v.union(
  v.literal("conversation_turn"),
  v.literal("integration_update"),
  v.literal("agent_action"),
  v.literal("context_note"),
);
const surface = v.union(
  v.literal("pi"),
  v.literal("discord"),
  v.literal("web"),
  v.literal("sms"),
  v.literal("integration"),
  v.literal("system"),
);
const visibility = v.union(v.literal("private"), v.literal("shared"));
const eventSource = v.object({
  surface,
  principalId: v.optional(v.string()),
  conversationId: v.string(),
  visibility,
  workspaceId: v.optional(v.string()),
  channelId: v.optional(v.string()),
  threadId: v.optional(v.string()),
});
const eventContent = v.object({
  text: v.optional(v.string()),
  prompt: v.optional(v.string()),
  assistant: v.optional(v.any()),
  toolResults: v.optional(v.any()),
  resource: v.optional(v.string()),
  resourceId: v.optional(v.string()),
});
const scope = v.object({
  kind: v.union(v.literal("owner"), v.literal("workspace"), v.literal("channel")),
  ownerId: v.optional(v.string()),
  workspaceId: v.optional(v.id("workspaces")),
  channelId: v.optional(v.string()),
  scopeId: v.optional(v.string()),
});
const attachments = v.optional(v.array(v.object({
  id: v.string(),
  name: v.string(),
  mediaType: v.optional(v.string()),
  url: v.optional(v.string()),
})));
const destination = v.object({
  surface,
  channelId: v.string(),
  threadId: v.optional(v.string()),
  conversationId: v.optional(v.string()),
});

export type ContextScopeInput = {
  kind: "owner" | "workspace" | "channel";
  ownerId?: string;
  workspaceId?: Id<"workspaces">;
  channelId?: string;
  scopeId?: string;
};

type Access = WorkspaceAccess;
type ContextEvent = Doc<"contextEvents">;
type ScopeInfo = {
  kind: ContextScopeInput["kind"];
  scopeId: string;
  channelId?: string;
  ownerId?: string;
};

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_INPUT", message });
}

function nonEmpty(value: string, name: string): string {
  const result = value.trim();
  if (!result) invalid(`${name} is required`);
  return result;
}

async function accessForScope(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces"> | undefined,
  requested: ContextScopeInput,
): Promise<{ access: Access; info: ScopeInfo }> {
  const requestedWorkspace = requested.workspaceId;
  if (workspaceId !== undefined && requestedWorkspace !== undefined && workspaceId !== requestedWorkspace) {
    throw new ConvexError({ code: "FORBIDDEN", message: "Scope workspace does not match the requested workspace" });
  }
  const access = await requireWorkspace(ctx, workspaceId ?? requestedWorkspace);
  if (requested.kind === "owner") {
    if (requested.ownerId !== undefined && requested.ownerId !== String(access.userId)) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Owner scope belongs to another user" });
    }
    return { access, info: { kind: "owner", scopeId: String(access.userId), ownerId: String(access.userId) } };
  }
  if (requested.kind === "workspace") {
    return { access, info: { kind: "workspace", scopeId: String(access.workspaceId) } };
  }
  const channelId = nonEmpty(requested.channelId ?? requested.scopeId ?? "", "channelId");
  return { access, info: { kind: "channel", scopeId: channelId, channelId } };
}

function shareSafe(event: ContextEvent): boolean {
  if (event.source.visibility !== "shared") return false;
  const resource = event.content.resource?.trim().toLowerCase();
  if (resource === undefined) return true;
  return !/(health|finance|wiki|private|raw|interaction)/.test(resource);
}
function visibleEvent(event: ContextEvent, info: ScopeInfo, access: Access): boolean {
  if (info.kind === "owner") {
    return event.source.visibility === "shared" || event.ownerId === access.userId;
  }
  if (!shareSafe(event)) return false;
  return info.kind === "workspace" || event.source.channelId === info.channelId;
}

async function workspaceEvents(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  info: ScopeInfo,
  access: Access,
  since: number | undefined,
  limit: number,
): Promise<ContextEvent[]> {
  const scopeQuery = ctx.db
    .query("contextEvents")
    .withIndex("by_workspace_occurred", (q) => q.eq("workspaceId", workspaceId))
    .order("desc");
  const events = await scopeQuery
    .filter((q) => {
      const shared = q.eq(q.field("source.visibility"), "shared");
      const owner = q.eq(q.field("ownerId"), access.userId);
      const scoped = info.kind === "owner"
        ? q.or(shared, owner)
        : info.kind === "workspace"
          ? shared
          : q.and(shared, q.eq(q.field("source.channelId"), info.channelId));
      return since === undefined
        ? scoped
        : q.and(scoped, q.gt(q.field("occurredAt"), since));
    })
    // Dynamic share-safety checks still run below. Keep the database read
    // bounded while allowing a small amount of filtering headroom.
    .take(Math.min(Math.max(limit * 20, limit), 1_000));
  return events
    .filter((event) => visibleEvent(event, info, access))
    .slice(0, limit);
}

async function summariesForScope(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  info: ScopeInfo,
  access: Access,
  limit: number,
): Promise<Doc<"contextSummaries">[]> {
  const summaries = await ctx.db
    .query("contextSummaries")
    .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .collect();
  return summaries
    .filter((summary) => {
      if (info.kind === "owner") {
        return (summary.visibility === "private" && summary.ownerId === access.userId) || summary.visibility === "shared";
      }
      return summary.visibility === "shared" && (info.kind === "workspace" || summary.channelId === info.channelId);
    })
    .slice(0, limit);
}

export const append = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.string(),
    kind: eventKind,
    occurredAt: v.number(),
    source: eventSource,
    content: eventContent,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const id = nonEmpty(args.id, "id");
    const conversationId = nonEmpty(args.source.conversationId, "source.conversationId");
    const existing = await ctx.db
      .query("contextEvents")
      .withIndex("by_event_id", (q) => q.eq("id", id))
      .unique();
    if (existing !== null) {
      if (existing.workspaceId !== access.workspaceId) {
        throw new ConvexError({ code: "CONFLICT", message: "Event id is already used by another workspace" });
      }
      return { id: existing.id, eventId: existing._id, inserted: false };
    }
    const now = Date.now();
    const eventId = await ctx.db.insert("contextEvents", {
      id,
      workspaceId: access.workspaceId,
      ownerId: access.userId,
      kind: args.kind,
      occurredAt: args.occurredAt,
      source: {
        ...args.source,
        conversationId,
        principalId: String(access.userId),
        workspaceId: String(access.workspaceId),
      },
      content: args.content,
      createdAt: now,
    });
    return { id, eventId, inserted: true };
  },
});

export const list = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    scope,
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { access, info } = await accessForScope(ctx, args.workspaceId, args.scope);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 500);
    return workspaceEvents(ctx, access.workspaceId, info, access, args.since, limit);
  },
});

export const claim = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    scope: v.optional(scope),
    consumer: v.string(),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const consumer = nonEmpty(args.consumer, "consumer");
    const access = await requireWorkspace(ctx, args.workspaceId ?? args.scope?.workspaceId);
    const info = args.scope
      ? (await accessForScope(ctx, access.workspaceId, args.scope)).info
      : { kind: "owner" as const, scopeId: String(access.userId), ownerId: String(access.userId) };
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 200);
    const leaseMs = Math.min(Math.max(Math.floor(args.leaseMs ?? 30_000), 1_000), 86_400_000);
    const candidates = (await workspaceEvents(ctx, access.workspaceId, info, access, args.since, Math.min(limit * 10, 500))).reverse();
    const now = Date.now();
    const claimed: Array<{ event: ContextEvent; claimToken: string; attempts: number; leaseUntil: number }> = [];
    for (const event of candidates) {
      if (claimed.length >= limit) break;
      const prior = await ctx.db
        .query("contextEventClaims")
        .withIndex("by_event_consumer", (q) => q.eq("eventId", event._id).eq("consumer", consumer))
        .unique();
      if (prior?.status === "acked") continue;
      if (prior !== null && prior.leaseUntil > now) continue;
      const attempts = (prior?.attempts ?? 0) + 1;
      const claimToken = `${consumer}:${now}:${event.id}`;
      const leaseUntil = now + leaseMs;
      if (prior === null) {
        await ctx.db.insert("contextEventClaims", {
          workspaceId: access.workspaceId,
          eventId: event._id,
          consumer,
          status: "claimed",
          claimToken,
          leaseUntil,
          attempts,
          claimedAt: now,
        });
      } else {
        await ctx.db.patch(prior._id, { status: "claimed", claimToken, leaseUntil, attempts, claimedAt: now, ackedAt: undefined });
      }
      claimed.push({ event, claimToken, attempts, leaseUntil });
    }
    const cursor = await ctx.db
      .query("contextConsumers")
      .withIndex("by_workspace_consumer", (q) => q.eq("workspaceId", access.workspaceId).eq("consumer", consumer))
      .unique();
    if (cursor === null) {
      await ctx.db.insert("contextConsumers", { workspaceId: access.workspaceId, consumer, cursor: 0, updatedAt: now });
    }
    return claimed;
  },
});

export const ack = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    consumer: v.string(),
    eventIds: v.array(v.string()),
    claimToken: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const consumer = nonEmpty(args.consumer, "consumer");
    const claimToken = nonEmpty(args.claimToken, "claimToken");
    let acknowledged = 0;
    let cursor = 0;
    const now = Date.now();
    for (const eventId of args.eventIds) {
      const event = await ctx.db
        .query("contextEvents")
        .withIndex("by_event_id", (q) => q.eq("id", eventId))
        .unique();
      if (event === null || event.workspaceId !== access.workspaceId) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Context event not found" });
      }
      const claim = await ctx.db
        .query("contextEventClaims")
        .withIndex("by_event_consumer", (q) => q.eq("eventId", event._id).eq("consumer", consumer))
        .unique();
      if (claim === null) {
        throw new ConvexError({ code: "CONFLICT", message: "Context event is not claimed by this consumer" });
      }
      if (claim.claimToken !== claimToken) {
        throw new ConvexError({ code: "CONFLICT", message: "Context claim token is invalid" });
      }
      if (claim.status === "claimed" && claim.leaseUntil <= now) {
        throw new ConvexError({ code: "CONFLICT", message: "Context claim token is expired" });
      }
      if (claim.status !== "acked") {
        await ctx.db.patch(claim._id, { status: "acked", ackedAt: now, leaseUntil: now });
        acknowledged += 1;
      }
      cursor = Math.max(cursor, event.occurredAt);
    }
    const consumerRow = await ctx.db
      .query("contextConsumers")
      .withIndex("by_workspace_consumer", (q) => q.eq("workspaceId", access.workspaceId).eq("consumer", consumer))
      .unique();
    if (consumerRow === null) {
      await ctx.db.insert("contextConsumers", { workspaceId: access.workspaceId, consumer, cursor, updatedAt: now });
    } else if (cursor > consumerRow.cursor) {
      await ctx.db.patch(consumerRow._id, { cursor, updatedAt: now });
    }
    return { acknowledged, cursor };
  },
});

export const saveSummary = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    scope,
    summary: v.string(),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { access, info } = await accessForScope(ctx, args.workspaceId, args.scope);
    const summary = nonEmpty(args.summary, "summary");
    const now = args.updatedAt ?? Date.now();
    const visibilityValue = info.kind === "owner" ? "private" as const : "shared" as const;
    const existing = await ctx.db
      .query("contextSummaries")
      .withIndex("by_scope", (q) => q.eq("workspaceId", access.workspaceId).eq("scopeKind", info.kind).eq("scopeId", info.scopeId))
      .unique();
    const value = {
      workspaceId: access.workspaceId,
      ownerId: access.userId,
      scopeKind: info.kind,
      scopeId: info.scopeId,
      visibility: visibilityValue,
      channelId: info.channelId,
      summary,
      updatedAt: now,
    };
    if (existing === null) {
      return { summaryId: await ctx.db.insert("contextSummaries", value), inserted: true };
    }
    await ctx.db.patch(existing._id, value);
    return { summaryId: existing._id, inserted: false };
  },
});

export const compile = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    scope,
    query: v.optional(v.string()),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { access, info } = await accessForScope(ctx, args.workspaceId, args.scope);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 50), 1), 200);
    const [summaries, events] = await Promise.all([
      summariesForScope(ctx, access.workspaceId, info, access, limit),
      workspaceEvents(ctx, access.workspaceId, info, access, args.since, limit),
    ]);
    const queryText = args.query?.trim();
    const wikiPages: Array<{ pageId: Id<"wikiPages">; path: string; title: string }> = [];
    if (queryText) {
      const documents = await ctx.db
        .query("wikiSearchDocuments")
        .withSearchIndex("search_content", (q) =>
          q.search("searchText", queryText)
            .eq("workspaceId", access.workspaceId)
            .eq("status", "active"),
        )
        .take(limit);
      for (const document of documents) {
        const page = await ctx.db.get(document.pageId);
        if (page === null || page.workspaceId !== access.workspaceId || page.status !== "active") continue;
        if (info.kind !== "owner" && page.visibility !== "shared") continue;
        wikiPages.push({ pageId: page._id, path: page.path, title: page.title });
      }
    } else {
      const pages = await ctx.db
        .query("wikiPages")
        .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", access.workspaceId))
        .order("desc")
        .collect();
      for (const page of pages) {
        if (page.status !== "active" || (info.kind !== "owner" && page.visibility !== "shared")) continue;
        wikiPages.push({ pageId: page._id, path: page.path, title: page.title });
        if (wikiPages.length >= limit) break;
      }
    }
    return { scope: info, summaries, events, wikiPages };
  },
});

export const enqueueOutbound = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.string(),
    destination,
    text: v.string(),
    attachments,
    replyToId: v.optional(v.string()),
    nextAttemptAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const id = nonEmpty(args.id, "id");
    const text = nonEmpty(args.text, "text");
    const existing = await ctx.db
      .query("contextOutboundMessages")
      .withIndex("by_outbound_id", (q) => q.eq("id", id))
      .unique();
    if (existing !== null) {
      if (existing.workspaceId !== access.workspaceId) {
        throw new ConvexError({ code: "CONFLICT", message: "Outbound id is already used by another workspace" });
      }
      return { id: existing.id, messageId: existing._id, inserted: false };
    }
    const now = Date.now();
    const messageId = await ctx.db.insert("contextOutboundMessages", {
      id,
      workspaceId: access.workspaceId,
      ownerId: access.userId,
      destination: args.destination,
      text,
      attachments: args.attachments,
      replyToId: args.replyToId,
      status: "queued",
      attempts: 0,
      nextAttemptAt: args.nextAttemptAt ?? now,
      createdAt: now,
      updatedAt: now,
    });
    return { id, messageId, inserted: true };
  },
});

export const claimOutbound = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    consumer: v.string(),
    limit: v.optional(v.number()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const consumer = nonEmpty(args.consumer, "consumer");
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 20), 1), 100);
    const leaseMs = Math.min(Math.max(Math.floor(args.leaseMs ?? 30_000), 1_000), 86_400_000);
    const now = Date.now();
    const [queued, leased] = await Promise.all([
      ctx.db.query("contextOutboundMessages")
        .withIndex("by_workspace_owner_status_attempt", (q) =>
          q.eq("workspaceId", access.workspaceId).eq("ownerId", access.userId).eq("status", "queued"),
        )
        .order("asc")
        .take(limit),
      ctx.db.query("contextOutboundMessages")
        .withIndex("by_workspace_owner_status_attempt", (q) =>
          q.eq("workspaceId", access.workspaceId).eq("ownerId", access.userId).eq("status", "claimed"),
        )
        .order("asc")
        .take(limit),
    ]);
    const candidates = [...queued, ...leased].sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);
    const claimed: Array<Doc<"contextOutboundMessages"> & { claimToken: string; leaseUntil: number }> = [];
    for (const message of candidates) {
      if (claimed.length >= limit || message.nextAttemptAt > now) break;
      const leaseExpired = message.status === "claimed" && (message.leaseUntil ?? 0) <= now;
      if (message.status !== "queued" && !leaseExpired) continue;
      const claimToken = `${consumer}:${now}:${message.id}`;
      const leaseUntil = now + leaseMs;
      await ctx.db.patch(message._id, { status: "claimed", claimedBy: consumer, claimToken, leaseUntil, attempts: message.attempts + 1, updatedAt: now });
      claimed.push({ ...message, status: "claimed", claimedBy: consumer, claimToken, leaseUntil, attempts: message.attempts + 1, updatedAt: now });
    }
    return claimed;
  },
});

export const completeOutbound = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.string()),
    messageId: v.optional(v.string()),
    consumer: v.optional(v.string()),
    claimToken: v.optional(v.string()),
    success: v.optional(v.boolean()),
    ok: v.optional(v.boolean()),
    retryable: v.optional(v.boolean()),
    error: v.optional(v.string()),
    retryAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const now = Date.now();
    const key = args.id ?? args.messageId;
    if (key === undefined || key.trim() === "") invalid("id or messageId is required");
    const message = await ctx.db
      .query("contextOutboundMessages")
      .withIndex("by_outbound_id", (q) => q.eq("id", key))
      .unique();
    if (message === null || message.workspaceId !== access.workspaceId || message.ownerId !== access.userId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Outbound message not found" });
    }
    if (args.consumer !== undefined && message.claimedBy !== args.consumer) throw new ConvexError({ code: "CONFLICT", message: "Outbound message is claimed by another consumer" });
    if (args.claimToken !== undefined && message.claimToken !== args.claimToken) throw new ConvexError({ code: "CONFLICT", message: "Outbound claim token is invalid" });
    if (message.status === "claimed" && (args.consumer === undefined || args.claimToken === undefined)) {
      throw new ConvexError({ code: "CONFLICT", message: "Outbound claim token is required" });
    }
    if (message.status === "claimed" && (message.leaseUntil ?? 0) <= now) {
      throw new ConvexError({ code: "CONFLICT", message: "Outbound claim token is expired" });
    }
    if (message.status === "completed") return { id: message.id, status: message.status, attempts: message.attempts };
    const success = args.success ?? args.ok ?? !(args.retryable ?? false);
    if (success) {
      await ctx.db.patch(message._id, { status: "completed", leaseUntil: undefined, claimToken: undefined, claimedBy: undefined, completedAt: now, updatedAt: now });
      return { id: message.id, status: "completed", attempts: message.attempts };
    }
    const retryable = args.retryable ?? true;
    await ctx.db.patch(message._id, {
      status: retryable ? "queued" : "failed",
      leaseUntil: undefined,
      claimToken: undefined,
      claimedBy: undefined,
      lastError: args.error,
      nextAttemptAt: args.retryAt ?? now,
      updatedAt: now,
    });
    return { id: message.id, status: retryable ? "queued" : "failed", attempts: message.attempts };
  },
});
