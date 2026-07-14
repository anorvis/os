import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireWorkspace } from "./lib/auth";

const status = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("cancelled"),
);
const priority = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("urgent"),
);
const source = v.union(v.literal("manual"), v.literal("agent"));
const sessionStatus = v.union(
  v.literal("planned"),
  v.literal("completed"),
  v.literal("cancelled"),
);

function cleanTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Task title is required" });
  }
  return title;
}

function cleanOptional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function validateDuration(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Task duration must be a positive whole number of minutes",
    });
  }
}

async function getTask(
  ctx: Parameters<typeof requireWorkspace>[0],
  id: Id<"tasks">,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"tasks">> {
  const task = await ctx.db.get(id);
  if (task === null || task.workspaceId !== workspaceId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Task not found" });
  }
  return task;
}

export const list = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    status: v.optional(status),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.status !== undefined) {
      return ctx.db
        .query("tasks")
        .withIndex("by_workspace_status_due", (q) =>
          q.eq("workspaceId", access.workspaceId).eq("status", args.status!),
        )
        .collect();
    }
    return ctx.db
      .query("tasks")
      .withIndex("by_workspace_updated", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("tasks") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    return getTask(ctx, args.id, access.workspaceId);
  },
});

export const create = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    title: v.string(),
    notes: v.optional(v.string()),
    priority: v.optional(priority),
    dueAt: v.optional(v.number()),
    durationMinutes: v.optional(v.number()),
    links: v.optional(v.array(v.string())),
    multiSession: v.optional(v.boolean()),
    source: v.optional(source),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    validateDuration(args.durationMinutes);
    const now = Date.now();
    return ctx.db.insert("tasks", {
      workspaceId: access.workspaceId,
      title: cleanTitle(args.title),
      notes: cleanOptional(args.notes),
      status: "open",
      priority: args.priority,
      dueAt: args.dueAt,
      source: args.source ?? "manual",
      durationMinutes: args.durationMinutes,
      links: args.links?.map((link) => link.trim()).filter(Boolean) ?? [],
      multiSession: args.multiSession ?? false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("tasks"),
    title: v.optional(v.string()),
    notes: v.optional(v.string()),
    clearNotes: v.optional(v.boolean()),
    status: v.optional(status),
    priority: v.optional(priority),
    dueAt: v.optional(v.number()),
    clearDueAt: v.optional(v.boolean()),
    durationMinutes: v.optional(v.number()),
    clearDuration: v.optional(v.boolean()),
    links: v.optional(v.array(v.string())),
    multiSession: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const task = await getTask(ctx, args.id, access.workspaceId);
    validateDuration(args.durationMinutes);
    const now = Date.now();
    const nextStatus = args.status ?? task.status;
    await ctx.db.patch(task._id, {
      title: args.title === undefined ? task.title : cleanTitle(args.title),
      notes: args.clearNotes
        ? undefined
        : args.notes === undefined
          ? task.notes
          : cleanOptional(args.notes),
      status: nextStatus,
      priority: args.priority ?? task.priority,
      dueAt: args.clearDueAt ? undefined : (args.dueAt ?? task.dueAt),
      durationMinutes: args.clearDuration
        ? undefined
        : (args.durationMinutes ?? task.durationMinutes),
      links:
        args.links?.map((link) => link.trim()).filter(Boolean) ?? task.links,
      multiSession: args.multiSession ?? task.multiSession,
      completedAt:
        nextStatus === "completed"
          ? (task.completedAt ?? now)
          : nextStatus === task.status
            ? task.completedAt
            : undefined,
      updatedAt: now,
    });
    return task._id;
  },
});

export const complete = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("tasks") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const task = await getTask(ctx, args.id, access.workspaceId);
    const now = Date.now();
    await ctx.db.patch(task._id, {
      status: "completed",
      completedAt: task.completedAt ?? now,
      updatedAt: now,
    });
    return task._id;
  },
});

export const remove = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("tasks") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const task = await getTask(ctx, args.id, access.workspaceId);
    const sessions = await ctx.db
      .query("taskSessions")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    for (const session of sessions) await ctx.db.delete(session._id);
    await ctx.db.delete(task._id);
    return task._id;
  },
});

export const listSessions = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    taskId: v.optional(v.id("tasks")),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.taskId !== undefined) {
      await getTask(ctx, args.taskId, access.workspaceId);
      const sessions = await ctx.db
        .query("taskSessions")
        .withIndex("by_task", (q) => q.eq("taskId", args.taskId!))
        .collect();
      return sessions.filter(
        (session) =>
          (args.startAt === undefined || session.endAt > args.startAt) &&
          (args.endAt === undefined || session.startAt < args.endAt),
      );
    }
    const sessions =
      args.endAt === undefined
        ? await ctx.db
            .query("taskSessions")
            .withIndex("by_workspace_start", (q) =>
              q.eq("workspaceId", access.workspaceId),
            )
            .collect()
        : await ctx.db
            .query("taskSessions")
            .withIndex("by_workspace_start", (q) =>
              q
                .eq("workspaceId", access.workspaceId)
                .lt("startAt", args.endAt!),
            )
            .collect();
    return sessions.filter(
      (session) => args.startAt === undefined || session.endAt > args.startAt,
    );
  },
});

export const saveSession = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("taskSessions")),
    taskId: v.id("tasks"),
    startAt: v.number(),
    endAt: v.number(),
    status: v.optional(sessionStatus),
    source: v.optional(source),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    await getTask(ctx, args.taskId, access.workspaceId);
    if (args.endAt <= args.startAt) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Task session end must be after its start",
      });
    }
    const now = Date.now();
    if (args.id === undefined) {
      return ctx.db.insert("taskSessions", {
        workspaceId: access.workspaceId,
        taskId: args.taskId,
        startAt: args.startAt,
        endAt: args.endAt,
        status: args.status ?? "planned",
        source: args.source ?? "manual",
        createdAt: now,
        updatedAt: now,
      });
    }
    const session = await ctx.db.get(args.id);
    if (session === null || session.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Task session not found" });
    }
    await ctx.db.patch(session._id, {
      taskId: args.taskId,
      startAt: args.startAt,
      endAt: args.endAt,
      status: args.status ?? session.status,
      updatedAt: now,
    });
    return session._id;
  },
});

export const moveSession = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("taskSessions"),
    startAt: v.number(),
    endAt: v.number(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const session = await ctx.db.get(args.id);
    if (session === null || session.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Task session not found" });
    }
    if (args.endAt <= args.startAt) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Task session end must be after its start",
      });
    }
    await ctx.db.patch(session._id, {
      startAt: args.startAt,
      endAt: args.endAt,
      updatedAt: Date.now(),
    });
    return session._id;
  },
});

export const removeSession = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("taskSessions"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const session = await ctx.db.get(args.id);
    if (session === null || session.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Task session not found" });
    }
    await ctx.db.delete(session._id);
    return session._id;
  },
});
