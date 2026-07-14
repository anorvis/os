import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test" }),
  );
  const client = t.withIdentity({ subject: userId });
  const workspaceId = await client.mutation(api.workspaces.ensureDefault, {});
  return { t, client, workspaceId };
}

describe("Life capabilities", () => {
  it("persists task state transitions and removes child sessions atomically", async () => {
    const { t, client } = await owner();
    const taskId = await client.mutation(api.tasks.create, {
      title: "  Ship Convex migration  ",
      durationMinutes: 90,
      priority: "high",
    });
    await client.mutation(api.tasks.complete, { id: taskId });
    const completed = await client.query(api.tasks.get, { id: taskId });
    expect(completed).toMatchObject({
      title: "Ship Convex migration",
      status: "completed",
      durationMinutes: 90,
    });
    expect(completed.completedAt).toBeTypeOf("number");

    await client.mutation(api.tasks.saveSession, {
      taskId,
      startAt: 100,
      endAt: 200,
    });
    await client.mutation(api.tasks.remove, { id: taskId });
    const childCount = await t.run(async (ctx) =>
      (await ctx.db.query("taskSessions").collect()).length,
    );
    expect(childCount).toBe(0);
  });

  it("returns sessions that overlap a half-open time range", async () => {
    const { client } = await owner();
    const taskId = await client.mutation(api.tasks.create, { title: "Focus" });
    const overlappingId = await client.mutation(api.tasks.saveSession, {
      taskId,
      startAt: 50,
      endAt: 150,
    });
    await client.mutation(api.tasks.saveSession, {
      taskId,
      startAt: 200,
      endAt: 250,
    });

    const sessions = await client.query(api.tasks.listSessions, {
      startAt: 100,
      endAt: 200,
    });
    expect(sessions.map((session) => session._id)).toEqual([overlappingId]);
  });

  it("preserves all-day dates and derives timed event days in their timezone", async () => {
    const { client } = await owner();
    const allDayId = await client.mutation(api.calendar.create, {
      summary: "Conference",
      schedule: {
        kind: "all_day",
        startDate: "2026-01-01",
        endDateExclusive: "2026-01-03",
      },
    });
    const timedId = await client.mutation(api.calendar.create, {
      summary: "Late call",
      schedule: {
        kind: "timed",
        startAt: Date.parse("2026-01-02T02:00:00.000Z"),
        endAt: Date.parse("2026-01-02T03:00:00.000Z"),
        timezone: "America/New_York",
      },
    });

    const januaryFirst = await client.query(api.calendar.list, {
      startDay: "2026-01-01",
      endDay: "2026-01-01",
    });
    expect(new Set(januaryFirst.map((event) => event._id))).toEqual(
      new Set<Id<"calendarEvents">>([allDayId, timedId]),
    );
    expect(januaryFirst.find((event) => event._id === allDayId)?.schedule).toEqual({
      kind: "all_day",
      startDate: "2026-01-01",
      endDateExclusive: "2026-01-03",
    });
  });

  it("upserts tags by normalized name and restores hidden tags", async () => {
    const { client } = await owner();
    const firstId = await client.mutation(api.life.upsertTag, {
      name: "Training",
      color: "red",
    });
    await client.mutation(api.life.updateTag, { id: firstId, hidden: true });
    const secondId = await client.mutation(api.life.upsertTag, {
      name: " training ",
      color: "blue",
    });
    expect(secondId).toBe(firstId);
    const tags = await client.query(api.life.listTags, {});
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ name: "training", color: "blue", hidden: false });
  });
});
