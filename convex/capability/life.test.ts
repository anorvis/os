import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test" }),
  );
  const client = t.withIdentity({ subject: userId });
  const workspaceId = await client.mutation(api.platform.workspace.ensureDefault, {});
  return { t, client, workspaceId };
}

describe("Life capabilities", () => {
  it("persists task state transitions and removes child sessions atomically", async () => {
    const { t, client } = await owner();
    const taskId = await client.mutation(api.capability.task.create, {
      title: "  Ship Convex migration  ",
      durationMinutes: 90,
      priority: "high",
    });
    await client.mutation(api.capability.task.complete, { id: taskId });
    const completed = await client.query(api.capability.task.get, { id: taskId });
    expect(completed).toMatchObject({
      title: "Ship Convex migration",
      status: "completed",
      durationMinutes: 90,
    });
    expect(completed.completedAt).toBeTypeOf("number");

    await client.mutation(api.capability.task.saveSession, {
      taskId,
      startAt: 100,
      endAt: 200,
    });
    await client.mutation(api.capability.task.remove, { id: taskId });
    const childCount = await t.run(async (ctx) =>
      (await ctx.db.query("taskSessions").collect()).length,
    );
    expect(childCount).toBe(0);
  });

  it("returns sessions that overlap a half-open time range", async () => {
    const { client } = await owner();
    const taskId = await client.mutation(api.capability.task.create, { title: "Focus" });
    const overlappingId = await client.mutation(api.capability.task.saveSession, {
      taskId,
      startAt: 50,
      endAt: 150,
    });
    await client.mutation(api.capability.task.saveSession, {
      taskId,
      startAt: 200,
      endAt: 250,
    });

    const sessions = await client.query(api.capability.task.listSessions, {
      startAt: 100,
      endAt: 200,
    });
    expect(sessions.map((session) => session._id)).toEqual([overlappingId]);
  });

  it("preserves all-day dates and derives timed event days in their timezone", async () => {
    const { client } = await owner();
    const allDayId = await client.mutation(api.capability.calendar.create, {
      summary: "Conference",
      schedule: {
        kind: "all_day",
        startDate: "2026-01-01",
        endDateExclusive: "2026-01-03",
      },
    });
    const timedId = await client.mutation(api.capability.calendar.create, {
      summary: "Late call",
      schedule: {
        kind: "timed",
        startAt: Date.parse("2026-01-02T02:00:00.000Z"),
        endAt: Date.parse("2026-01-02T03:00:00.000Z"),
        timezone: "America/New_York",
      },
    });

    const januaryFirst = await client.query(api.capability.calendar.list, {
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
    const firstId = await client.mutation(api.capability.life.upsertTag, {
      name: "Training",
      color: "red",
    });
    await client.mutation(api.capability.life.updateTag, { id: firstId, hidden: true });
    const secondId = await client.mutation(api.capability.life.upsertTag, {
      name: " training ",
      color: "blue",
    });
    expect(secondId).toBe(firstId);
    const tags = await client.query(api.capability.life.listTags, {});
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ name: "training", color: "blue", hidden: false });
  });
});

describe("system life tags", () => {
  async function withGoogleTag() {
    const { t, client, workspaceId } = await owner();
    const tagId = await t.run((ctx) =>
      ctx.db.insert("lifeTags", {
        workspaceId,
        name: "Google Calendar",
        normalizedName: "google calendar",
        color: "#4285f4",
        hidden: false,
        systemKey: "google-calendar",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    return { t, client, workspaceId, tagId };
  }

  it("rejects deleting (hiding) an automatic tag", async () => {
    const { client, tagId } = await withGoogleTag();
    await expect(
      client.mutation(api.capability.life.updateTag, { id: tagId, hidden: true }),
    ).rejects.toThrow("cannot be deleted");
  });

  it("rejects renames of an automatic tag, including case changes", async () => {
    const { client, tagId } = await withGoogleTag();
    await expect(
      client.mutation(api.capability.life.updateTag, { id: tagId, name: "google calendar" }),
    ).rejects.toThrow("cannot be renamed");
    // Exact-name no-op payloads (color saves) must still succeed.
    await client.mutation(api.capability.life.updateTag, {
      id: tagId,
      name: "Google Calendar",
      color: "#123456",
    });
    const tags = await client.query(api.capability.life.listTags, {});
    expect(tags[0]).toMatchObject({ name: "Google Calendar", color: "#123456" });
  });

  it("keeps the canonical name when a user upserts a case variant", async () => {
    const { client } = await withGoogleTag();
    await client.mutation(api.capability.life.upsertTag, { name: "GOOGLE CALENDAR" });
    const tags = await client.query(api.capability.life.listTags, {});
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe("Google Calendar");
  });
});

describe("workout calendar surface", () => {
  it("returns overlapping workouts in the snapshot window and seeds the Hevy tag", async () => {
    const { t, client, workspaceId } = await owner();
    await t.mutation(internal.capability.integration.upsertHevyWorkouts, {
      system: true,
      workspaceId,
      workouts: [
        {
          sourceId: "w-1",
          title: "push day",
          startedAt: Date.parse("2026-07-13T17:00:00Z"),
          durationSeconds: 3600,
          exercises: [],
        },
        {
          sourceId: "w-2",
          title: "ancient session",
          startedAt: Date.parse("2026-01-01T17:00:00Z"),
          durationSeconds: 3600,
          exercises: [],
        },
      ],
    });

    const snapshot = await client.query(api.capability.life.snapshot, {
      startDay: "2026-07-12",
      endDay: "2026-07-19",
      startAt: Date.parse("2026-07-12T00:00:00Z"),
      endAt: Date.parse("2026-07-19T00:00:00Z"),
    });
    expect(snapshot.workouts).toHaveLength(1);
    expect(snapshot.workouts[0]).toMatchObject({ title: "push day", source: "hevy" });
    // The integration tag is seeded undeletable alongside the workouts.
    const hevy = snapshot.tags.find((tag) => tag.systemKey === "hevy");
    expect(hevy).toMatchObject({ name: "Hevy", hidden: false });
    await expect(
      client.mutation(api.capability.life.updateTag, { id: hevy!._id, hidden: true }),
    ).rejects.toThrow("cannot be deleted");
  });
});
