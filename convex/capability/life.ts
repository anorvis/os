import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireWorkspace } from "../platform/auth/access";

function normalizeName(value: string): { name: string; normalizedName: string } {
  const name = value.trim();
  if (!name) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Tag name is required" });
  }
  return { name, normalizedName: name.toLocaleLowerCase() };
}

function cleanOptional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export const listTags = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    includeHidden: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const tags = await ctx.db
      .query("lifeTags")
      .withIndex("by_workspace_name", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .collect();
    return args.includeHidden ? tags : tags.filter((tag) => !tag.hidden);
  },
});

export const upsertTag = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    name: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const value = normalizeName(args.name);
    const existing = await ctx.db
      .query("lifeTags")
      .withIndex("by_workspace_name", (q) =>
        q
          .eq("workspaceId", access.workspaceId)
          .eq("normalizedName", value.normalizedName),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        // Integration-owned tags keep their canonical name; a case-variant
        // upsert must not rename them.
        name: existing.systemKey === undefined ? value.name : existing.name,
        color: args.color === undefined ? existing.color : cleanOptional(args.color),
        hidden: false,
        updatedAt: now,
      });
      return existing._id;
    }
    return ctx.db.insert("lifeTags", {
      workspaceId: access.workspaceId,
      ...value,
      color: cleanOptional(args.color),
      hidden: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateTag = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("lifeTags"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    clearColor: v.optional(v.boolean()),
    hidden: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const tag = await ctx.db.get(args.id);
    if (tag === null || tag.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Life tag not found" });
    }
    const system = tag.systemKey !== undefined;
    if (system && args.hidden === true) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Automatic integration tags cannot be deleted",
      });
    }
    let names = { name: tag.name, normalizedName: tag.normalizedName };
    if (args.name !== undefined) {
      names = normalizeName(args.name);
      // Events match tags by exact name, so even a case change would orphan
      // every synced event carrying the canonical name.
      if (system && names.name !== tag.name) {
        throw new ConvexError({
          code: "FORBIDDEN",
          message: "Automatic integration tags cannot be renamed",
        });
      }
      const conflict = await ctx.db
        .query("lifeTags")
        .withIndex("by_workspace_name", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("normalizedName", names.normalizedName),
        )
        .unique();
      if (conflict !== null && conflict._id !== tag._id) {
        throw new ConvexError({ code: "CONFLICT", message: "A tag with this name exists" });
      }
    }
    await ctx.db.patch(tag._id, {
      ...names,
      color: args.clearColor
        ? undefined
        : args.color === undefined
          ? tag.color
          : cleanOptional(args.color),
      hidden: args.hidden ?? tag.hidden,
      updatedAt: Date.now(),
    });
    return tag._id;
  },
});

export const savePreferences = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    unitSystem: v.optional(v.union(v.literal("metric"), v.literal("imperial"))),
    reportingCurrency: v.optional(
      v.union(v.literal("CAD"), v.literal("USD"), v.literal("BTC")),
    ),
    inspiration: v.optional(
      v.object({
        boardUrl: v.string(),
        cadenceMinutes: v.number(),
        imageUrls: v.array(v.string()),
      }),
    ),
    clearInspiration: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const preferences = await ctx.db
      .query("userPreferences")
      .withIndex("by_workspace_user", (q) =>
        q
          .eq("workspaceId", access.workspaceId)
          .eq("userId", access.userId),
      )
      .unique();
    if (preferences === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "User preferences not found" });
    }
    if (
      args.inspiration !== undefined &&
      (!Number.isFinite(args.inspiration.cadenceMinutes) ||
        args.inspiration.cadenceMinutes <= 0)
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Inspiration cadence must be positive",
      });
    }
    await ctx.db.patch(preferences._id, {
      unitSystem: args.unitSystem ?? preferences.unitSystem,
      reportingCurrency:
        args.reportingCurrency ?? preferences.reportingCurrency,
      inspiration: args.clearInspiration
        ? undefined
        : (args.inspiration ?? preferences.inspiration),
      updatedAt: Date.now(),
    });
    return preferences._id;
  },
});

export const snapshot = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    startDay: v.string(),
    endDay: v.string(),
    startAt: v.number(),
    endAt: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const [tasks, sessions, events, tags, workouts] = await Promise.all([
      ctx.db
        .query("tasks")
        .withIndex("by_workspace_updated", (q) =>
          q.eq("workspaceId", access.workspaceId),
        )
        .order("desc")
        .collect(),
      ctx.db
        .query("taskSessions")
        .withIndex("by_workspace_start", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .lt("startAt", args.endAt),
        )
        .collect(),
      ctx.db
        .query("calendarEvents")
        .withIndex("by_workspace_start_day", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .lte("startDay", args.endDay),
        )
        .collect(),
      ctx.db
        .query("lifeTags")
        .withIndex("by_workspace_name", (q) =>
          q.eq("workspaceId", access.workspaceId),
        )
        .collect(),
      ctx.db
        .query("workouts")
        .withIndex("by_workspace_started", (q) =>
          q.eq("workspaceId", access.workspaceId).lt("startedAt", args.endAt),
        )
        .collect(),
    ]);
    return {
      tasks,
      sessions: sessions.filter((session) => session.endAt > args.startAt),
      events: events.filter((event) => event.endDay >= args.startDay),
      tags: tags.filter((tag) => !tag.hidden),
      workouts: workouts.filter(
        (workout) =>
          workout.startedAt + Math.max(workout.durationSeconds, 1) * 1000 >
          args.startAt,
      ),
    };
  },
});
