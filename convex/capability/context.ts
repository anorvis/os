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
type CreationBound = { op: "gt" | "eq"; value: number } | undefined;

function claimEventQuery(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  surfaceFilter: ContextSurface | undefined,
  kindFilter: ContextKind | undefined,
  bound: CreationBound,
) {
  if (surfaceFilter !== undefined && kindFilter !== undefined) {
    return ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_surface_kind_created", (q) => {
        const indexed = q
          .eq("workspaceId", workspaceId)
          .eq("source.surface", surfaceFilter)
          .eq("kind", kindFilter);
        return bound === undefined
          ? indexed
          : bound.op === "gt"
            ? indexed.gt("createdAt", bound.value)
            : indexed.eq("createdAt", bound.value);
      });
  }
  if (surfaceFilter !== undefined) {
    return ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_surface_created", (q) => {
        const indexed = q.eq("workspaceId", workspaceId).eq("source.surface", surfaceFilter);
        return bound === undefined
          ? indexed
          : bound.op === "gt"
            ? indexed.gt("createdAt", bound.value)
            : indexed.eq("createdAt", bound.value);
      });
  }
  if (kindFilter !== undefined) {
    return ctx.db
      .query("contextEvents")
      .withIndex("by_workspace_kind_created", (q) => {
        const indexed = q.eq("workspaceId", workspaceId).eq("kind", kindFilter);
        return bound === undefined
          ? indexed
          : bound.op === "gt"
            ? indexed.gt("createdAt", bound.value)
            : indexed.eq("createdAt", bound.value);
      });
  }
  return ctx.db
    .query("contextEvents")
    .withIndex("by_workspace_created", (q) => {
      const indexed = q.eq("workspaceId", workspaceId);
      return bound === undefined
        ? indexed
        : bound.op === "gt"
          ? indexed.gt("createdAt", bound.value)
          : indexed.eq("createdAt", bound.value);
    });
}


async function claimScanEvents(
  ctx: Parameters<typeof requireWorkspace>[0],
  workspaceId: Id<"workspaces">,
  surfaceFilter: ContextSurface | undefined,
  kindFilter: ContextKind | undefined,
  cursorCreatedAt: number | undefined,
  cursorEventId: Id<"contextEvents"> | undefined,
): Promise<ContextEvent[]> {
  if (cursorCreatedAt === undefined) {
    return (await claimEventQuery(ctx, workspaceId, surfaceFilter, kindFilter, undefined)
      .order("asc")
      .take(CLAIM_SCAN_PAGE_SIZE));
  }

  const later = await claimEventQuery(
    ctx,
    workspaceId,
    surfaceFilter,
    kindFilter,
    { op: "gt", value: cursorCreatedAt },
  )
    .order("asc")
    .take(CLAIM_SCAN_PAGE_SIZE);
  const sameQuery = claimEventQuery(
    ctx,
    workspaceId,
    surfaceFilter,
    kindFilter,
    { op: "eq", value: cursorCreatedAt },
  ).order("asc");
  const same = cursorEventId === undefined
    ? await sameQuery.take(CLAIM_SCAN_PAGE_SIZE)
    : await sameQuery
      .filter((q) => q.gt(q.field("_id"), cursorEventId))
      .take(CLAIM_SCAN_PAGE_SIZE);
  return [...same, ...later]
    .sort((left, right) =>
      left.createdAt - right.createdAt || (left._id < right._id ? -1 : left._id > right._id ? 1 : 0),
    )
    .slice(0, CLAIM_SCAN_PAGE_SIZE);
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
    .sort((left, right) =>
      right.occurredAt - left.occurredAt || (right._id < left._id ? -1 : right._id > left._id ? 1 : 0),
    )
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
    const page = await claimScanEvents(
      ctx,
      access.workspaceId,
      args.surface,
      args.kind,
      consumerRow?.cursorCreatedAt,
      consumerRow?.cursorEventId,
    );
    const claimed: Array<{ event: ContextEvent; claimToken: string; attempts: number; leaseUntil: number }> = [];
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
        await ctx.db.patch(prior._id, {
          status: "claimed",
          claimToken,
          leaseUntil,
          attempts,
          claimedAt: now,
          ackedAt: undefined,
        });
      }
      claimed.push({ event, claimToken, attempts, leaseUntil });
      blocked = true;
    }

    if (!blocked && page.length > 0) safeCursor = page[page.length - 1];
    if (consumerRow === null) {
      await ctx.db.insert("contextConsumers", {
        workspaceId: access.workspaceId,
        consumer,
        surface: args.surface,
        kind: args.kind,
        cursor: safeCursor?.createdAt ?? 0,
        cursorCreatedAt: safeCursor?.createdAt,
        cursorEventId: safeCursor?._id,
        scopeKind: info.kind,
        scopeId: info.scopeId,
        updatedAt: now,
      });
    } else if (safeCursor !== undefined) {
      await ctx.db.patch(consumerRow._id, {
        cursor: safeCursor.createdAt,
        cursorCreatedAt: safeCursor.createdAt,
        cursorEventId: safeCursor._id,
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
