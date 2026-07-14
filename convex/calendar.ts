import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireWorkspace } from "./lib/auth";

const schedule = v.union(
  v.object({
    kind: v.literal("timed"),
    startAt: v.number(),
    endAt: v.number(),
    timezone: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("all_day"),
    startDate: v.string(),
    endDateExclusive: v.string(),
  }),
);

type Schedule = Doc<"calendarEvents">["schedule"];

function dateOnly(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} must use YYYY-MM-DD`,
    });
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} is not a valid date` });
  }
  return value;
}

function previousDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function timedDay(value: number, timezone?: string): string {
  if (!Number.isFinite(value)) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Event time must be finite" });
  }
  if (!timezone) return new Date(value).toISOString().slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Event timezone is invalid" });
  }
}

function normalizeSchedule(value: Schedule): {
  schedule: Schedule;
  startDay: string;
  endDay: string;
} {
  if (value.kind === "all_day") {
    const startDate = dateOnly(value.startDate, "Event start date");
    const endDateExclusive = dateOnly(value.endDateExclusive, "Event end date");
    if (endDateExclusive <= startDate) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "All-day event end date must be after its start date",
      });
    }
    return {
      schedule: { kind: "all_day", startDate, endDateExclusive },
      startDay: startDate,
      endDay: previousDay(endDateExclusive),
    };
  }

  if (value.endAt <= value.startAt) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Timed event end must be after its start",
    });
  }
  return {
    schedule: value,
    startDay: timedDay(value.startAt, value.timezone),
    endDay: timedDay(value.endAt - 1, value.timezone),
  };
}

function cleanSummary(value: string): string {
  const summary = value.trim();
  if (!summary) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Event summary is required" });
  }
  return summary;
}

function cleanOptional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

async function getEvent(
  ctx: Parameters<typeof requireWorkspace>[0],
  id: Id<"calendarEvents">,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"calendarEvents">> {
  const event = await ctx.db.get(id);
  if (event === null || event.workspaceId !== workspaceId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Calendar event not found" });
  }
  return event;
}

export const list = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    startDay: v.string(),
    endDay: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const startDay = dateOnly(args.startDay, "Range start");
    const endDay = dateOnly(args.endDay, "Range end");
    if (endDay < startDay) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Range end precedes range start" });
    }
    const events = await ctx.db
      .query("calendarEvents")
      .withIndex("by_workspace_start_day", (q) =>
        q.eq("workspaceId", access.workspaceId).lte("startDay", endDay),
      )
      .collect();
    return events.filter((event) => event.endDay >= startDay);
  },
});

export const create = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    summary: v.string(),
    schedule,
    location: v.optional(v.string()),
    description: v.optional(v.string()),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const normalized = normalizeSchedule(args.schedule);
    const now = Date.now();
    return ctx.db.insert("calendarEvents", {
      workspaceId: access.workspaceId,
      summary: cleanSummary(args.summary),
      ...normalized,
      location: cleanOptional(args.location),
      description: cleanOptional(args.description),
      tag: cleanOptional(args.tag),
      source: "manual",
      readOnly: false,
      provider: "local",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("calendarEvents"),
    summary: v.optional(v.string()),
    schedule: v.optional(schedule),
    location: v.optional(v.string()),
    description: v.optional(v.string()),
    tag: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const event = await getEvent(ctx, args.id, access.workspaceId);
    if (event.readOnly) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Provider calendar events are read-only",
      });
    }
    const normalized = normalizeSchedule(args.schedule ?? event.schedule);
    await ctx.db.patch(event._id, {
      summary: args.summary === undefined ? event.summary : cleanSummary(args.summary),
      ...normalized,
      location: args.location === undefined ? event.location : cleanOptional(args.location),
      description:
        args.description === undefined
          ? event.description
          : cleanOptional(args.description),
      tag: args.tag === undefined ? event.tag : cleanOptional(args.tag),
      updatedAt: Date.now(),
    });
    return event._id;
  },
});

export const remove = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("calendarEvents"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const event = await getEvent(ctx, args.id, access.workspaceId);
    if (event.readOnly) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Provider calendar events are read-only",
      });
    }
    await ctx.db.delete(event._id);
    return event._id;
  },
});
