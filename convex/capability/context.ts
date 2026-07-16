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
const eventAttachments = v.optional(v.array(v.object({
  id: v.string(),
  name: v.string(),
  mediaType: v.optional(v.string()),
  url: v.optional(v.string()),
})));
const eventContent = v.object({
  text: v.optional(v.string()),
  prompt: v.optional(v.string()),
  assistant: v.optional(v.any()),
  toolResults: v.optional(v.any()),
  resource: v.optional(v.string()),
  resourceId: v.optional(v.string()),
  attachments: eventAttachments,
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

const MAX_CONTEXT_ATTACHMENTS = 16;
const MAX_CONTEXT_ATTACHMENT_ID = 256;
const MAX_CONTEXT_ATTACHMENT_NAME = 256;
const MAX_CONTEXT_ATTACHMENT_MEDIA_TYPE = 128;
const MAX_CONTEXT_ATTACHMENT_URL = 4_096;

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_INPUT", message });
}

function nonEmpty(value: string, name: string): string {
  const result = value.trim();
  if (!result) invalid(`${name} is required`);
  return result;
}

type ContextAttachment = NonNullable<ContextEvent["content"]["attachments"]>[number];

function boundedAttachments(value: ContextEvent["content"]["attachments"]): ContextAttachment[] | undefined {
  if (value === undefined) return undefined;
  return value.slice(0, MAX_CONTEXT_ATTACHMENTS).flatMap((attachment, index) => {
    const id = attachment.id.trim().slice(0, MAX_CONTEXT_ATTACHMENT_ID) || `attachment-${index + 1}`;
    const name = attachment.name.trim().slice(0, MAX_CONTEXT_ATTACHMENT_NAME) || `attachment-${index + 1}`;
    if (!id || !name) return [];
    const mediaType = attachment.mediaType?.trim().slice(0, MAX_CONTEXT_ATTACHMENT_MEDIA_TYPE);
    const url = attachment.url?.trim().slice(0, MAX_CONTEXT_ATTACHMENT_URL);
    return [{
      id,
      name,
      ...(mediaType ? { mediaType } : {}),
      ...(url ? { url } : {}),
    }];
  });
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
const CLAIM_SCAN_PAGE_SIZE = 200;

type ContextSurface = ContextEvent["source"]["surface"];
type ContextKind = ContextEvent["kind"];
type ConsumerScope = Pick<ScopeInfo, "kind" | "scopeId"> & {
  surface?: ContextSurface;
  eventKind?: ContextKind;
};
type ContextConsumer = Doc<"contextConsumers">;

async function consumerForScope(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  consumer: string,
  scopeInfo: ConsumerScope,
): Promise<ContextConsumer | null> {
  let scoped: ContextConsumer | null | undefined;
  if (scopeInfo.surface !== undefined && scopeInfo.eventKind !== undefined) {
    scoped = await ctx.db
      .query("contextConsumers")
      .withIndex("by_workspace_consumer_surface_kind_scope", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("consumer", consumer)
          .eq("surface", scopeInfo.surface)
          .eq("kind", scopeInfo.eventKind)
          .eq("scopeKind", scopeInfo.kind)
          .eq("scopeId", scopeInfo.scopeId),
      )
      .unique();
  } else if (scopeInfo.surface !== undefined) {
    scoped = await ctx.db
      .query("contextConsumers")
      .withIndex("by_workspace_consumer_surface_scope", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("consumer", consumer)
          .eq("surface", scopeInfo.surface)
          .eq("scopeKind", scopeInfo.kind)
          .eq("scopeId", scopeInfo.scopeId),
      )
      .unique();
  } else if (scopeInfo.eventKind !== undefined) {
    scoped = await ctx.db
      .query("contextConsumers")
      .withIndex("by_workspace_consumer_kind_scope", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("consumer", consumer)
          .eq("kind", scopeInfo.eventKind)
          .eq("scopeKind", scopeInfo.kind)
          .eq("scopeId", scopeInfo.scopeId),
      )
      .unique();
  } else {
    scoped = (await ctx.db
      .query("contextConsumers")
      .withIndex("by_workspace_consumer", (q) =>
        q.eq("workspaceId", workspaceId).eq("consumer", consumer),
      )
      .take(CLAIM_SCAN_PAGE_SIZE)).find((row) =>
        row.surface === undefined &&
        row.kind === undefined &&
        row.scopeKind === scopeInfo.kind &&
        row.scopeId === scopeInfo.scopeId);
  }
  if (scoped !== undefined && scoped !== null) return scoped;

  // A legacy row has no scope or filter fields. Adopt it only for the
  // unfiltered monitor cursor; filtered cursors must remain independent.
  if (scopeInfo.surface !== undefined || scopeInfo.eventKind !== undefined) return null;
  return (await ctx.db
    .query("contextConsumers")
    .withIndex("by_workspace_consumer", (q) =>
      q.eq("workspaceId", workspaceId).eq("consumer", consumer),
    )
    .take(CLAIM_SCAN_PAGE_SIZE)).find((row) =>
      row.surface === undefined &&
      row.kind === undefined &&
      row.scopeKind === undefined &&
      row.scopeId === undefined) ?? null;
}
function claimEventQuery(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  surfaceFilter: ContextSurface | undefined,
  kindFilter: ContextKind | undefined,
) {
  if (surfaceFilter !== undefined && kindFilter !== undefined) {
    return ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_surface_kind_created", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("source.surface", surfaceFilter)
          .eq("kind", kindFilter),
      );
  }
  if (surfaceFilter !== undefined) {
    return ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_surface_created", (q) =>
        q.eq("workspaceId", workspaceId).eq("source.surface", surfaceFilter),
      );
  }
  if (kindFilter !== undefined) {
    return ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_kind_created", (q) =>
        q.eq("workspaceId", workspaceId).eq("kind", kindFilter),
      );
  }
  return ctx.db
    .query("contextEvents")
    .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId));
}

type ClaimScanPage = {
  page: ContextEvent[];
  continueCursor: string;
  isDone: boolean;
};

async function claimScanEvents(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  surfaceFilter: ContextSurface | undefined,
  kindFilter: ContextKind | undefined,
  scanCursor: string | undefined,
): Promise<ClaimScanPage> {
  return claimEventQuery(ctx, workspaceId, surfaceFilter, kindFilter)
    .order("asc")
    .paginate({ cursor: scanCursor ?? null, numItems: CLAIM_SCAN_PAGE_SIZE });
}

async function workspaceEvents(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  info: ScopeInfo,
  access: Access,
  since: number | undefined,
  limit: number,
): Promise<ContextEvent[]> {
  const scanLimit = Math.min(Math.max(limit * 20, limit), 1_000);
  let events: ContextEvent[];
  if (info.kind === "owner") {
    const [owned, shared] = await Promise.all([
      ctx.db
        .query("contextEvents")
        .withIndex("by_workspace_owner_occurred", (q) => {
          const indexed = q.eq("workspaceId", workspaceId).eq("ownerId", access.userId);
          return since === undefined ? indexed : indexed.gt("occurredAt", since);
        })
        .order("desc")
        .take(scanLimit),
      ctx.db
        .query("contextEvents")
        .withIndex("by_workspace_visibility_occurred", (q) => {
          const indexed = q.eq("workspaceId", workspaceId).eq("source.visibility", "shared");
          return since === undefined ? indexed : indexed.gt("occurredAt", since);
        })
        .order("desc")
        .take(scanLimit),
    ]);
    events = [...owned, ...shared];
  } else if (info.kind === "workspace") {
    events = await ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_visibility_occurred", (q) => {
        const indexed = q.eq("workspaceId", workspaceId).eq("source.visibility", "shared");
        return since === undefined ? indexed : indexed.gt("occurredAt", since);
      })
      .order("desc")
      .take(scanLimit);
  } else {
    events = await ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_visibility_channel_occurred", (q) => {
        const indexed = q
          .eq("workspaceId", workspaceId)
          .eq("source.visibility", "shared")
          .eq("source.channelId", info.channelId);
        return since === undefined ? indexed : indexed.gt("occurredAt", since);
      })
      .order("desc")
      .take(scanLimit);
  }
  const unique = new Map<string, ContextEvent>();
  for (const event of events) unique.set(String(event._id), event);
  return [...unique.values()]
    .sort((left, right) => right.occurredAt - left.occurredAt)
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
  const scanLimit = Math.min(Math.max(limit * 20, limit), 1_000);
  let summaries: Doc<"contextSummaries">[];
  if (info.kind === "owner") {
    const [owned, shared] = await Promise.all([
      ctx.db
        .query("contextSummaries")
        .withIndex("by_workspace_owner_updated", (q) =>
          q.eq("workspaceId", workspaceId).eq("ownerId", access.userId),
        )
        .order("desc")
        .take(scanLimit),
      ctx.db
        .query("contextSummaries")
        .withIndex("by_workspace_visibility_updated", (q) =>
          q.eq("workspaceId", workspaceId).eq("visibility", "shared"),
        )
        .order("desc")
        .take(scanLimit),
    ]);
    summaries = [...owned, ...shared];
  } else if (info.kind === "workspace") {
    summaries = await ctx.db
      .query("contextSummaries")
      .withIndex("by_workspace_visibility_updated", (q) =>
        q.eq("workspaceId", workspaceId).eq("visibility", "shared"),
      )
      .order("desc")
      .take(scanLimit);
  } else {
    summaries = await ctx.db
      .query("contextSummaries")
      .withIndex("by_workspace_visibility_channel_updated", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("visibility", "shared")
          .eq("channelId", info.channelId),
      )
      .order("desc")
      .take(scanLimit);
  }
  const unique = new Map<string, Doc<"contextSummaries">>();
  for (const summary of summaries) unique.set(String(summary._id), summary);
  return [...unique.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
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
    const normalizedAttachments = boundedAttachments(args.content.attachments);
    const content = normalizedAttachments === undefined
      ? args.content
      : { ...args.content, attachments: normalizedAttachments };
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
      content,
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
    surface: v.optional(surface),
    kind: v.optional(eventKind),
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
    const now = Date.now();
    // Convex mutations must be deterministic: derive the fresh batch identity
    // from the first newly claimed row's unique _id instead of randomness.
    let freshBatchId: string | undefined;
    const consumerScope: ConsumerScope = {
      kind: info.kind,
      scopeId: info.scopeId,
      surface: args.surface,
      eventKind: args.kind,
    };
    const consumerRow = await consumerForScope(ctx, access.workspaceId, consumer, consumerScope);
    if (
      consumerRow !== null &&
      consumerRow.surface === undefined &&
      consumerRow.kind === undefined &&
      consumerRow.scopeKind === undefined &&
      consumerRow.scopeId === undefined
    ) {
      await ctx.db.patch(consumerRow._id, {
        scopeKind: info.kind,
        scopeId: info.scopeId,
      });
    }
    const scanPage = await claimScanEvents(
      ctx,
      access.workspaceId,
      args.surface,
      args.kind,
      consumerRow?.scanCursor,
    );
    const page = scanPage.page;
    const claimed: Array<{ event: ContextEvent; claimToken: string; batchId: string; attempts: number; leaseUntil: number }> = [];
    let blocked = false;
    let safeCursor: ContextEvent | undefined;
    for (const event of page) {
      if (claimed.length >= limit) break;
      if (args.since !== undefined && event.occurredAt <= args.since) {
        if (!blocked) safeCursor = event;
        continue;
      }
      if (!visibleEvent(event, info, access)) {
        if (!blocked) safeCursor = event;
        continue;
      }
      const prior = await ctx.db
        .query("contextEventClaims")
        .withIndex("by_event_consumer", (q) => q.eq("eventId", event._id).eq("consumer", consumer))
        .unique();
      if (prior?.status === "acked") {
        if (!blocked) safeCursor = event;
        continue;
      }
      if (prior !== null && prior.leaseUntil > now) {
        blocked = true;
        continue;
      }
      const attempts = (prior?.attempts ?? 0) + 1;
      const claimToken = `${consumer}:${now}:${event.id}`;
      const eventBatchId = prior?.batchId ?? (freshBatchId ??= `${consumer}:batch:${event._id}`);
      const leaseUntil = now + leaseMs;
      if (prior === null) {
        await ctx.db.insert("contextEventClaims", {
          workspaceId: access.workspaceId,
          eventId: event._id,
          consumer,
          status: "claimed",
          claimToken,
          batchId: eventBatchId,
          leaseUntil,
          attempts,
          claimedAt: now,
        });
      } else {
        await ctx.db.patch(prior._id, {
          status: "claimed",
          claimToken,
          batchId: eventBatchId,
          leaseUntil,
          attempts,
          claimedAt: now,
          ackedAt: undefined,
        });
      }
      claimed.push({ event, claimToken, batchId: eventBatchId, attempts, leaseUntil });
      blocked = true;
    }

    if (!blocked && page.length > 0) safeCursor = page[page.length - 1];
    const scanCursor = blocked
      ? consumerRow?.scanCursor
      : scanPage.isDone
        ? consumerRow?.scanCursor
        : scanPage.continueCursor;
    if (consumerRow === null) {
      await ctx.db.insert("contextConsumers", {
        workspaceId: access.workspaceId,
        consumer,
        surface: args.surface,
        kind: args.kind,
        cursor: safeCursor?.createdAt ?? 0,
        cursorCreatedAt: safeCursor?.createdAt,
        scopeKind: info.kind,
        scopeId: info.scopeId,
        scanCursor,
        updatedAt: now,
      });
    } else if (!blocked) {
      await ctx.db.patch(consumerRow._id, {
        cursor: safeCursor?.createdAt ?? consumerRow.cursor,
        cursorCreatedAt: safeCursor?.createdAt ?? consumerRow.cursorCreatedAt,
        scanCursor,
        updatedAt: now,
      });
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
    if (args.eventIds.length !== 1) invalid("ack requires exactly one eventId");
    let acknowledged = 0;
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
    }
    const consumerRows = await ctx.db
      .query("contextConsumers")
      .withIndex("by_workspace_consumer", (q) => q.eq("workspaceId", access.workspaceId).eq("consumer", consumer))
      .take(CLAIM_SCAN_PAGE_SIZE);
    const consumerRow = consumerRows[0];
    const cursor = consumerRow?.cursor ?? 0;
    if (consumerRow === undefined) {
      await ctx.db.insert("contextConsumers", { workspaceId: access.workspaceId, consumer, cursor: 0, updatedAt: now });
    }
    return { acknowledged, cursor };
  },
});
const monitorClaim = v.object({ eventId: v.string(), claimToken: v.string() });

export const renewClaim = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    consumer: v.string(),
    claims: v.array(monitorClaim),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const consumer = nonEmpty(args.consumer, "consumer");
    const claims = args.claims;
    if (claims.length === 0) invalid("claims are required");
    const leaseMs = Math.min(Math.max(Math.floor(args.leaseMs ?? 300_000), 1_000), 86_400_000);
    const now = Date.now();
    const leaseUntil = now + leaseMs;
    for (const item of claims) {
      const event = await ctx.db
        .query("contextEvents")
        .withIndex("by_event_id", (q) => q.eq("id", nonEmpty(item.eventId, "eventId")))
        .unique();
      if (event === null || event.workspaceId !== access.workspaceId) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Context event not found" });
      }
      const claim = await ctx.db
        .query("contextEventClaims")
        .withIndex("by_event_consumer", (q) => q.eq("eventId", event._id).eq("consumer", consumer))
        .unique();
      if (claim === null || claim.claimToken !== item.claimToken || claim.status !== "claimed" || claim.leaseUntil <= now) {
        throw new ConvexError({ code: "CONFLICT", message: "Context claim token is invalid or expired" });
      }
    }
    for (const item of claims) {
      const event = await ctx.db
        .query("contextEvents")
        .withIndex("by_event_id", (q) => q.eq("id", item.eventId))
        .unique();
      if (event === null) continue;
      const claim = await ctx.db
        .query("contextEventClaims")
        .withIndex("by_event_consumer", (q) => q.eq("eventId", event._id).eq("consumer", consumer))
        .unique();
      if (claim !== null) await ctx.db.patch(claim._id, { leaseUntil });
    }
    return { claims, leaseUntil };
  },
});

export const commitMonitorEffect = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    consumer: v.string(),
    effectKey: v.string(),
    kind: v.union(v.literal("summary"), v.literal("wiki"), v.literal("notification")),
    claims: v.array(monitorClaim),
    scope,
    summary: v.optional(v.string()),
    wikiTask: v.optional(v.string()),
    notification: v.optional(v.object({
      destination,
      text: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const consumer = nonEmpty(args.consumer, "consumer");
    const effectKey = nonEmpty(args.effectKey, "effectKey");
    if (args.claims.length === 0) invalid("claims are required");
    const now = Date.now();
    for (const item of args.claims) {
      const event = await ctx.db
        .query("contextEvents")
        .withIndex("by_event_id", (q) => q.eq("id", nonEmpty(item.eventId, "eventId")))
        .unique();
      if (event === null || event.workspaceId !== access.workspaceId) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Context event not found" });
      }
      const claim = await ctx.db
        .query("contextEventClaims")
        .withIndex("by_event_consumer", (q) => q.eq("eventId", event._id).eq("consumer", consumer))
        .unique();
      if (claim === null || claim.claimToken !== item.claimToken || claim.status !== "claimed" || claim.leaseUntil <= now) {
        throw new ConvexError({ code: "CONFLICT", message: "Context claim token is invalid or expired" });
      }
    }
    const existing = await ctx.db
      .query("contextMonitorEffects")
      .withIndex("by_workspace_effect_key", (q) => q.eq("workspaceId", access.workspaceId).eq("effectKey", effectKey))
      .unique();
    if (existing !== null) {
      if (existing.status === "completed") return { effectKey, status: "replayed" as const };
      return { effectKey, status: existing.status };
    }
    const payload = {
      scope: args.scope,
      summary: args.summary,
      wikiTask: args.wikiTask,
      notification: args.notification,
    };
    await ctx.db.insert("contextMonitorEffects", {
      workspaceId: access.workspaceId,
      ownerId: access.userId,
      effectKey,
      consumer,
      kind: args.kind,
      eventIds: args.claims.map((item) => item.eventId),
      status: args.kind === "wiki" ? "pending" as const : "completed" as const,
      payload,
      createdAt: now,
    });
    if (args.kind === "summary") {
      const summary = nonEmpty(args.summary ?? "", "summary");
      const { info } = await accessForScope(ctx, access.workspaceId, args.scope);
      const existingSummary = await ctx.db
        .query("contextSummaries")
        .withIndex("by_scope", (q) => q.eq("workspaceId", access.workspaceId).eq("scopeKind", info.kind).eq("scopeId", info.scopeId))
        .unique();
      const value = {
        workspaceId: access.workspaceId,
        ownerId: access.userId,
        scopeKind: info.kind,
        scopeId: info.scopeId,
        visibility: info.kind === "owner" ? "private" as const : "shared" as const,
        channelId: info.channelId,
        summary,
        updatedAt: now,
      };
      if (existingSummary === null) await ctx.db.insert("contextSummaries", value);
      else await ctx.db.patch(existingSummary._id, value);
    } else if (args.kind === "notification") {
      const note = args.notification;
      if (note === undefined) invalid("notification is required");
      const text = nonEmpty(note.text, "notification.text");
      const existingOutbound = await ctx.db
        .query("contextOutboundMessages")
        .withIndex("by_outbound_id", (q) => q.eq("id", effectKey))
        .unique();
      if (existingOutbound !== null && existingOutbound.workspaceId !== access.workspaceId) {
        throw new ConvexError({ code: "CONFLICT", message: "Monitor notification key belongs to another workspace" });
      }
      if (existingOutbound === null) {
        await ctx.db.insert("contextOutboundMessages", {
          id: effectKey,
          workspaceId: access.workspaceId,
          ownerId: access.userId,
          destination: note.destination,
          text,
          status: "queued",
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return { effectKey, status: args.kind === "wiki" ? "pending" as const : "completed" as const };
  },
});

export const claimMonitorWikiEffects = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    consumer: v.string(),
    limit: v.optional(v.number()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const consumer = nonEmpty(args.consumer, "consumer");
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 20), 1), 200);
    const leaseMs = Math.min(Math.max(Math.floor(args.leaseMs ?? 300_000), 1_000), 86_400_000);
    const now = Date.now();
    const stale = await ctx.db
      .query("contextMonitorEffects")
      .withIndex("by_workspace_owner_status", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("ownerId", access.userId).eq("status", "running"),
      )
      .take(limit);
    for (const row of stale) {
      if ((row.jobLeaseUntil ?? 0) <= now) {
        await ctx.db.patch(row._id, {
          status: "needs_reconciliation",
          error: "Wiki task lease expired; manual reconciliation required.",
          completedAt: now,
          jobConsumer: undefined,
          jobClaimToken: undefined,
          jobLeaseUntil: undefined,
        });
      }
    }
    const pending = await ctx.db
      .query("contextMonitorEffects")
      .withIndex("by_workspace_owner_status", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("ownerId", access.userId).eq("status", "pending"),
      )
      .order("asc")
      .take(limit);
    const jobs: Array<{ effectKey: string; wikiTask: string; jobClaimToken: string; leaseUntil: number }> = [];
    for (const row of pending) {
      const rawPayload: unknown = row.payload;
      const payload = rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? rawPayload as Record<string, unknown>
        : {};
      const task = typeof payload.wikiTask === "string" ? payload.wikiTask.trim() : "";
      if (!task) {
        await ctx.db.patch(row._id, {
          status: "needs_reconciliation",
          error: "Wiki task payload is missing.",
          completedAt: now,
        });
        continue;
      }
      const jobClaimToken = `${consumer}:${now}:${row.effectKey}`;
      const leaseUntil = now + leaseMs;
      await ctx.db.patch(row._id, {
        status: "running",
        startedAt: now,
        jobConsumer: consumer,
        jobClaimToken,
        jobLeaseUntil: leaseUntil,
      });
      jobs.push({ effectKey: row.effectKey, wikiTask: task, jobClaimToken, leaseUntil });
    }
    return jobs;
  },
});

export const completeMonitorWikiEffect = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    consumer: v.string(),
    effectKey: v.string(),
    jobClaimToken: v.string(),
    success: v.boolean(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const consumer = nonEmpty(args.consumer, "consumer");
    const effectKey = nonEmpty(args.effectKey, "effectKey");
    const token = nonEmpty(args.jobClaimToken, "jobClaimToken");
    const row = await ctx.db
      .query("contextMonitorEffects")
      .withIndex("by_workspace_effect_key", (q) => q.eq("workspaceId", access.workspaceId).eq("effectKey", effectKey))
      .unique();
    if (row === null || row.kind !== "wiki" || row.ownerId !== access.userId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Wiki effect not found" });
    }
    if (row.jobConsumer !== consumer || row.status !== "running" || row.jobClaimToken !== token) {
      throw new ConvexError({ code: "CONFLICT", message: "Wiki effect claim token is invalid" });
    }
    const rawPayload: unknown = row.payload;
    const payload = rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? rawPayload as Record<string, unknown>
      : {};
    const now = Date.now();
    const boundedResult = args.result?.slice(-2_000);
    const boundedError = args.error?.slice(-2_000);
    await ctx.db.patch(row._id, args.success
      ? {
        status: "completed",
        completedAt: now,
        payload: { ...payload, result: boundedResult },
        jobConsumer: undefined,
        jobClaimToken: undefined,
        jobLeaseUntil: undefined,
      }
      : {
        status: "needs_reconciliation",
        completedAt: now,
        error: boundedError ?? "Wiki task failed; manual reconciliation required.",
        jobConsumer: undefined,
        jobClaimToken: undefined,
        jobLeaseUntil: undefined,
      });
    return { effectKey, status: args.success ? "completed" as const : "needs_reconciliation" as const };
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
      const pages = info.kind === "owner"
        ? await ctx.db
          .query("wikiPages")
          .withIndex("by_workspace_status_updated", (q) =>
            q.eq("workspaceId", access.workspaceId).eq("status", "active"),
          )
          .order("desc")
          .take(limit)
        : await ctx.db
          .query("wikiPages")
          .withIndex("by_workspace_status_visibility_updated", (q) =>
            q
              .eq("workspaceId", access.workspaceId)
              .eq("status", "active")
              .eq("visibility", "shared"),
          )
          .order("desc")
          .take(limit);
      for (const page of pages) {
        wikiPages.push({ pageId: page._id, path: page.path, title: page.title });
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
