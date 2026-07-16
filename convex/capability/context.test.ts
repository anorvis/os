import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function owner(email = "context-owner@example.test") {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
  const client = t.withIdentity({ subject: userId });
  const workspaceId = await client.mutation(api.platform.workspace.ensureDefault, {});
  return { t, client, workspaceId, userId };
}

function event(id: string, visibility: "private" | "shared" = "private", resource?: string) {
  return {
    id,
    kind: "conversation_turn" as const,
    occurredAt: Date.now(),
    source: {
      surface: "pi" as const,
      conversationId: `conversation-${id}`,
      visibility,
      channelId: visibility === "shared" ? "general" : undefined,
    },
    content: { text: `text-${id}`, resource },
  };
}

afterEach(() => vi.useRealTimers());

describe("shared context capability", () => {
  it("appends idempotently and isolates workspaces", async () => {
    const first = await owner();
    const inserted = await first.client.mutation(api.capability.context.append, {
      workspaceId: first.workspaceId,
      ...event("same-event"),
    });
    const replay = await first.client.mutation(api.capability.context.append, {
      workspaceId: first.workspaceId,
      ...event("same-event"),
    });
    expect(inserted.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    const secondUser = await first.t.run((ctx) => ctx.db.insert("users", { email: "context-other@example.test" }));
    const secondClient = first.t.withIdentity({ subject: secondUser });
    const secondWorkspaceId = await secondClient.mutation(api.platform.workspace.ensureDefault, {});
    await expect(secondClient.query(api.capability.context.list, {
      workspaceId: secondWorkspaceId,
      scope: { kind: "owner" },
    })).resolves.toEqual([]);
    await expect(secondClient.mutation(api.capability.context.append, {
      workspaceId: secondWorkspaceId,
      ...event("other-event"),
    })).resolves.toMatchObject({ inserted: true });
  });

  it("bounds and durably stores inbound attachment metadata", async () => {
    const { t, client, workspaceId } = await owner("context-attachments@example.test");
    const inserted = await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("attachment-event"),
      content: {
        text: "attachment text",
        attachments: Array.from({ length: 20 }, (_, index) => ({
          id: ` id-${index} `.repeat(40),
          name: ` name-${index} `.repeat(40),
          mediaType: "text/plain".repeat(50),
          url: `https://example.test/${index}`.repeat(500),
        })),
      },
    });
    const stored = await t.run((ctx) => ctx.db.get("contextEvents", inserted.eventId));
    expect(stored?.content.attachments).toHaveLength(16);
    expect(stored?.content.attachments?.[0]).toMatchObject({
      id: ` id-0 `.repeat(40).trim().slice(0, 256),
      name: ` name-0 `.repeat(40).trim().slice(0, 256),
      mediaType: "text/plain".repeat(50).slice(0, 128),
      url: `https://example.test/0`.repeat(500).slice(0, 4_096),
    });
  });

  it("isolates owner-private context and outbound payloads within a workspace", async () => {
    const first = await owner();
    const secondUser = await first.t.run((ctx) =>
      ctx.db.insert("users", { email: "context-member@example.test" }),
    );
    await first.t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId: first.workspaceId,
        userId: secondUser,
        role: "member",
        createdAt: Date.now(),
      }),
    );
    await first.client.mutation(api.capability.context.append, {
      workspaceId: first.workspaceId,
      ...event("owner-private"),
    });
    await first.client.mutation(api.capability.context.enqueueOutbound, {
      workspaceId: first.workspaceId,
      id: "owner-outbound",
      destination: { surface: "discord", channelId: "owner-dm" },
      text: "owner secret",
      attachments: [{ id: "secret-file", name: "secret.txt", url: "https://private.test/secret.txt" }],
    });

    const member = first.t.withIdentity({ subject: secondUser });
    await expect(member.query(api.capability.context.list, {
      workspaceId: first.workspaceId,
      scope: { kind: "owner" },
    })).resolves.toEqual([]);
    await expect(member.query(api.capability.context.list, {
      workspaceId: first.workspaceId,
      scope: { kind: "workspace" },
    })).resolves.toEqual([]);
    await expect(member.mutation(api.capability.context.claimOutbound, {
      workspaceId: first.workspaceId,
      consumer: "member-sender",
    })).resolves.toEqual([]);
    await expect(member.mutation(api.capability.context.completeOutbound, {
      workspaceId: first.workspaceId,
      id: "owner-outbound",
      success: true,
    })).rejects.toThrow("Outbound message not found");
  });

  it("reclaims an unacknowledged event after its lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const { client, workspaceId } = await owner();
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("lease-event"),
    });
    const first = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "pi-mailbox",
      leaseMs: 1_000,
    });
    expect(first).toHaveLength(1);
    vi.advanceTimersByTime(1_001);
    const retry = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "pi-mailbox",
      leaseMs: 1_000,
    });
    expect(retry).toHaveLength(1);
    expect(retry[0]?.attempts).toBe(2);
  });

  it("preserves a batch identity across partial acknowledgements", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const { client, workspaceId } = await owner("batch-identity@example.test");
    await client.mutation(api.capability.context.append, { workspaceId, ...event("batch-first") });
    await client.mutation(api.capability.context.append, { workspaceId, ...event("batch-second") });
    const first = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "batch-consumer",
      limit: 2,
      leaseMs: 1_000,
    });
    expect(first).toHaveLength(2);
    expect(first[0]?.batchId).toBe(first[1]?.batchId);
    await client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "batch-consumer",
      eventIds: [first[0].event.id],
      claimToken: first[0].claimToken,
    });
    vi.advanceTimersByTime(1_001);
    const retry = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "batch-consumer",
      limit: 2,
      leaseMs: 1_000,
    });
    expect(retry).toHaveLength(1);
    expect(retry[0]?.event.id).toBe(first[1].event.id);
    expect(retry[0]?.batchId).toBe(first[0].batchId);
  });

  it("acknowledges a claim and does not redeliver it", async () => {
    const { client, workspaceId } = await owner();
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("ack-event"),
    });
    const claimed = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "ack-consumer",
    });
    await expect(client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "ack-consumer",
      eventIds: ["ack-event", "ack-event"],
      claimToken: claimed[0].claimToken,
    })).rejects.toThrow("ack requires exactly one eventId");
    const result = await client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "ack-consumer",
      eventIds: ["ack-event"],
      claimToken: claimed[0].claimToken,
    });
    expect(result.acknowledged).toBe(1);
    await expect(client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "ack-consumer",
    })).resolves.toEqual([]);
  });

  it("filters durable claims by surface and kind", async () => {
    const { client, workspaceId } = await owner();
    const discordTurn = {
      ...event("discord-turn"),
      source: { ...event("discord-turn").source, surface: "discord" as const },
    };
    const discordReply = {
      ...event("discord-reply"),
      kind: "agent_action" as const,
      source: { ...event("discord-reply").source, surface: "discord" as const },
    };
    const webTurn = {
      ...event("web-turn"),
      source: { ...event("web-turn").source, surface: "web" as const },
    };
    await client.mutation(api.capability.context.append, { workspaceId, ...discordTurn });
    await client.mutation(api.capability.context.append, { workspaceId, ...discordReply });
    await client.mutation(api.capability.context.append, { workspaceId, ...webTurn });

    const filtered = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "discord-responder",
      surface: "discord",
      kind: "conversation_turn",
    });
    expect(filtered.map((item) => item.event.id)).toEqual(["discord-turn"]);
    await client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "discord-responder",
      eventIds: ["discord-turn"],
      claimToken: filtered[0].claimToken,
    });
    await expect(client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "discord-responder",
      surface: "discord",
      kind: "conversation_turn",
    })).resolves.toEqual([]);

    const monitor = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "context-monitor",
      limit: 3,
    });
    expect(new Set(monitor.map((item) => item.event.id))).toEqual(
      new Set(["discord-turn", "discord-reply", "web-turn"]),
    );
  });

  it("rejects missing and stale event claim tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const { client, workspaceId } = await owner();
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("token-event"),
    });
    const first = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "token-consumer",
      leaseMs: 1_000,
    });
    const firstToken = first[0].claimToken;
    await expect(client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "token-consumer",
      eventIds: ["token-event"],
    } as never)).rejects.toThrow();
    vi.advanceTimersByTime(1_001);
    await expect(client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "token-consumer",
      eventIds: ["token-event"],
      claimToken: firstToken,
    })).rejects.toThrow("Context claim token is expired");
    const second = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "token-consumer",
      leaseMs: 1_000,
    });
    expect(second[0].claimToken).not.toBe(firstToken);
    await expect(client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "token-consumer",
      eventIds: ["token-event"],
      claimToken: firstToken,
    })).rejects.toThrow("Context claim token is invalid");
  });

  it("returns the newest events while honoring a bounded limit", async () => {
    const { client, workspaceId } = await owner();
    for (let index = 1; index <= 5; index += 1) {
      await client.mutation(api.capability.context.append, {
        workspaceId,
        ...event(`bounded-${index}`, "shared"),
        occurredAt: index,
      });
    }
    const listed = await client.query(api.capability.context.list, {
      workspaceId,
      scope: { kind: "workspace" },
      limit: 2,
    });
    expect(listed.map((item) => item.id)).toEqual(["bounded-5", "bounded-4"]);
  });

  it("drains an append-ordered backlog without losing old-occurredAt appends", async () => {
    vi.useFakeTimers();
    const { t, client, workspaceId, userId } = await owner();
    const total = 1_105;
    const ids = Array.from({ length: total }, (_, index) => `drain-${index}`);
    await t.run(async (ctx) => {
      for (let index = 0; index < total; index += 1) {
        await ctx.db.insert("contextEvents", {
          id: ids[index],
          workspaceId,
          ownerId: userId,
          kind: "conversation_turn",
          occurredAt: index,
          source: {
            surface: "system",
            principalId: String(userId),
            conversationId: `drain-conversation-${index}`,
            visibility: "private",
            workspaceId: String(workspaceId),
          },
          content: { text: ids[index] },
          createdAt: index + 1,
        });
      }
    });

    const first = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "drain-consumer",
      limit: 1,
      leaseMs: 1_000,
    });
    expect(first[0]?.event.id).toBe(ids[0]);
    const second = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "drain-consumer",
      limit: 1,
      leaseMs: 1_000,
    });
    expect(second[0]?.event.id).toBe(ids[1]);
    await client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "drain-consumer",
      eventIds: [ids[1]],
      claimToken: second[0].claimToken,
    });
    vi.advanceTimersByTime(1_001);
    const retry = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "drain-consumer",
      limit: 1,
      leaseMs: 1_000,
    });
    expect(retry[0]?.event.id).toBe(ids[0]);
    expect(retry[0]?.attempts).toBe(2);
    await client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "drain-consumer",
      eventIds: [ids[0]],
      claimToken: retry[0].claimToken,
    });

    const claimedIds = new Set([ids[0], ids[1]]);
    let scans = 0;
    while (claimedIds.size < total) {
      scans += 1;
      expect(scans).toBeLessThan(total);
      const batch = await client.mutation(api.capability.context.claim, {
        workspaceId,
        consumer: "drain-consumer",
        limit: 50,
        leaseMs: 1_000,
      });
      if (batch.length === 0) continue;
      for (const item of batch) {
        claimedIds.add(item.event.id);
        await client.mutation(api.capability.context.ack, {
          workspaceId,
          consumer: "drain-consumer",
          eventIds: [item.event.id],
          claimToken: item.claimToken,
        });
      }
    }
    expect(claimedIds).toEqual(new Set(ids));
    await expect(client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "drain-consumer",
      limit: 1,
    })).resolves.toEqual([]);

    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("late-old-occurredAt"),
      occurredAt: -1,
    });
    const late = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "drain-consumer",
      limit: 1,
    });
    expect(late.map((item) => item.event.id)).toEqual(["late-old-occurredAt"]);
  });

  it("drains same-timestamp rows with adversarial event ids across restarts", async () => {
    const { t, client, workspaceId, userId } = await owner("adversarial-context@example.test");
    const total = 450;
    const ids = Array.from({ length: total }, (_, index) =>
      `adversarial-${String(total - index - 1).padStart(4, "0")}`,
    );
    const createdAt = 7_000;
    await t.run(async (ctx) => {
      for (const id of ids) {
        await ctx.db.insert("contextEvents", {
          id,
          workspaceId,
          ownerId: userId,
          kind: "conversation_turn",
          occurredAt: createdAt,
          source: {
            surface: "system",
            principalId: String(userId),
            conversationId: `conversation-${id}`,
            visibility: "private",
            workspaceId: String(workspaceId),
          },
          content: { text: id },
          createdAt,
        });
      }
      const first = await ctx.db
        .query("contextEvents")
        .withIndex("by_workspace_created", (q) => q.eq("workspaceId", workspaceId))
        .first();
      await ctx.db.insert("contextConsumers", {
        workspaceId,
        consumer: "adversarial-consumer",
        cursor: createdAt,
        cursorCreatedAt: createdAt,
        cursorEventId: first?._id,
        scopeKind: "owner",
        scopeId: String(userId),
        updatedAt: createdAt,
      });
    });

    const claimedIds = new Set<string>();
    let claimant = client;
    let scans = 0;
    while (claimedIds.size < total) {
      scans += 1;
      expect(scans).toBeLessThan(total);
      const batch = await claimant.mutation(api.capability.context.claim, {
        workspaceId,
        consumer: "adversarial-consumer",
        limit: 50,
      });
      for (const item of batch) {
        expect(claimedIds.has(item.event.id)).toBe(false);
        claimedIds.add(item.event.id);
        await claimant.mutation(api.capability.context.ack, {
          workspaceId,
          consumer: "adversarial-consumer",
          eventIds: [item.event.id],
          claimToken: item.claimToken,
        });
      }
      if (scans === 4) claimant = t.withIdentity({ subject: userId });
    }
    expect(claimedIds).toEqual(new Set(ids));
  });

  it("accepts legacy maintenance wiki-agent-run rows", async () => {
    const { t, workspaceId } = await owner();
    const runId = await t.run((ctx) =>
      ctx.db.insert("wikiAgentRuns", {
        workspaceId,
        kind: "maintenance",
        task: "legacy maintenance",
        status: "completed",
        allowWeb: false,
        createdAt: Date.now(),
        finishedAt: Date.now(),
      }),
    );
    await expect(t.run((ctx) => ctx.db.get(runId))).resolves.toMatchObject({
      kind: "maintenance",
    });
  });

  it("requeues retryable outbound delivery", async () => {
    const { client, workspaceId } = await owner();
    await client.mutation(api.capability.context.enqueueOutbound, {
      workspaceId,
      id: "outbound-1",
      destination: { surface: "discord", channelId: "general" },
      text: "hello",
    });
    const first = await client.mutation(api.capability.context.claimOutbound, {
      workspaceId,
      consumer: "discord-sender",
    });
    expect(first).toHaveLength(1);
    await client.mutation(api.capability.context.completeOutbound, {
      workspaceId,
      id: "outbound-1",
      consumer: "discord-sender",
      claimToken: first[0].claimToken,
      success: false,
      retryable: true,
      error: "temporary",
    });
    const retry = await client.mutation(api.capability.context.claimOutbound, {
      workspaceId,
      consumer: "discord-sender",
    });
    expect(retry).toHaveLength(1);
    expect(retry[0]?.attempts).toBe(2);
  });

  it("keeps private and sensitive context out of channel compilation", async () => {
    const { client, workspaceId } = await owner();
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("private-note"),
    });
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("shared-note", "shared"),
    });
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("shared-health", "shared", "health"),
    });
    const compiled = await client.query(api.capability.context.compile, {
      workspaceId,
      scope: { kind: "channel", channelId: "general" },
    });
    expect(compiled.events.map((item) => item.id)).toEqual(["shared-note"]);
    expect(compiled.events.map((item) => item.id)).not.toContain("private-note");
    expect(compiled.events.map((item) => item.id)).not.toContain("shared-health");
  });
  it("creates and replays a bounded Monitor plan within workspace scope", async () => {
    const { t, client, workspaceId } = await owner("monitor-plan@example.test");
    const result = {
      summaries: [{ conversationId: "conversation", visibility: "private" as const, summary: "durable note" }],
      wikiTasks: [{ task: "curate this" }],
      notifications: [{ text: "owner notice", reason: "timely" }],
      notes: "compact notes",
    };
    const created = await client.mutation(api.capability.context.getOrCreateMonitorPlan, {
      workspaceId,
      consumer: "os-monitor",
      batchId: "batch-1",
      planKey: "plan-1",
      result,
    });
    const replayed = await client.mutation(api.capability.context.getOrCreateMonitorPlan, {
      workspaceId,
      consumer: "os-monitor",
      batchId: "batch-1",
      planKey: "plan-1",
      result: {
        ...result,
        notes: "different retry output",
      },
    });
    expect(created).toEqual({ planKey: "plan-1", batchId: "batch-1", result });
    expect(replayed).toEqual(created);

    const otherUser = await t.run((ctx) => ctx.db.insert("users", { email: "monitor-plan-other@example.test" }));
    const otherClient = t.withIdentity({ subject: otherUser });
    const otherWorkspaceId = await otherClient.mutation(api.platform.workspace.ensureDefault, {});
    expect(otherWorkspaceId).not.toBe(workspaceId);
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("monitor-plan-cleanup"),
    });
    const cleanupClaim = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "cleanup-monitor",
      scope: { kind: "owner" },
      limit: 1,
    });
    expect(cleanupClaim).toHaveLength(1);
    await client.mutation(api.capability.context.getOrCreateMonitorPlan, {
      workspaceId,
      consumer: "cleanup-monitor",
      batchId: cleanupClaim[0].batchId,
      planKey: "cleanup-plan",
      result,
    });
    await client.mutation(api.capability.context.ack, {
      workspaceId,
      consumer: "cleanup-monitor",
      eventIds: [cleanupClaim[0].event.id],
      claimToken: cleanupClaim[0].claimToken,
    });
    await expect(t.run((ctx) => ctx.db.query("contextMonitorPlans")
      .withIndex("by_workspace_consumer_plan", (q) =>
        q.eq("workspaceId", workspaceId).eq("consumer", "cleanup-monitor").eq("planKey", "cleanup-plan"),
      )
      .unique())).resolves.toBeNull();

    await expect(otherClient.mutation(api.capability.context.getOrCreateMonitorPlan, {
      workspaceId,
      consumer: "os-monitor",
      batchId: "batch-2",
      planKey: "plan-2",
      result,
    })).rejects.toThrow("access to this workspace");
  });

  it("claims and completes Monitor Wiki jobs exactly once", async () => {
    const { t, client, workspaceId } = await owner("wiki-monitor@example.test");
    await client.mutation(api.capability.context.append, {
      workspaceId,
      ...event("wiki-effect"),
    });
    const claimed = await client.mutation(api.capability.context.claim, {
      workspaceId,
      consumer: "os-monitor",
      scope: { kind: "owner" },
    });
    expect(claimed).toHaveLength(1);
    const committed = await client.mutation(api.capability.context.commitMonitorEffect, {
      workspaceId,
      consumer: "os-monitor",
      effectKey: "wiki-effect-key",
      kind: "wiki",
      claims: [{ eventId: claimed[0].event.id, claimToken: claimed[0].claimToken }],
      scope: { kind: "owner" },
      wikiTask: "curate the durable task",
    });
    expect(committed).toEqual({ effectKey: "wiki-effect-key", status: "pending" });
    const secondUser = await t.run((ctx) => ctx.db.insert("users", { email: "wiki-member@example.test" }));
    await t.run((ctx) => ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: secondUser,
      role: "member",
      createdAt: Date.now(),
    }));
    const member = t.withIdentity({ subject: secondUser });
    await expect(member.mutation(api.capability.context.claimMonitorWikiEffects, {
      workspaceId,
      consumer: "member-wiki",
    })).resolves.toEqual([]);
    await expect(member.mutation(api.capability.context.completeMonitorWikiEffect, {
      workspaceId,
      consumer: "member-wiki",
      effectKey: "wiki-effect-key",
      jobClaimToken: "not-owner-token",
      success: true,
    })).rejects.toThrow("Wiki effect not found");
    const jobs = await client.mutation(api.capability.context.claimMonitorWikiEffects, {
      workspaceId,
      consumer: "os-monitor:wiki",
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ effectKey: "wiki-effect-key", wikiTask: "curate the durable task" });
    const completed = await client.mutation(api.capability.context.completeMonitorWikiEffect, {
      workspaceId,
      consumer: "os-monitor:wiki",
      effectKey: "wiki-effect-key",
      jobClaimToken: jobs[0].jobClaimToken,
      success: true,
      result: "done",
    });
    expect(completed).toEqual({ effectKey: "wiki-effect-key", status: "completed" });
    await expect(client.mutation(api.capability.context.claimMonitorWikiEffects, {
      workspaceId,
      consumer: "os-monitor:wiki",
    })).resolves.toEqual([]);
  });

  it("reconciles a stale running Monitor Wiki job without rerunning it", async () => {
    const { t, client, workspaceId, userId } = await owner("wiki-stale@example.test");
    await t.run((ctx) => ctx.db.insert("contextMonitorEffects", {
      workspaceId,
      ownerId: userId,
      effectKey: "stale-wiki",
      consumer: "os-monitor",
      kind: "wiki",
      eventIds: [],
      status: "running",
      payload: { wikiTask: "already possibly executed" },
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 10_000,
      jobConsumer: "os-monitor:wiki",
      jobClaimToken: "stale-token",
      jobLeaseUntil: Date.now() - 1,
    }));
    const jobs = await client.mutation(api.capability.context.claimMonitorWikiEffects, {
      workspaceId,
      consumer: "os-monitor:wiki",
    });
    expect(jobs).toEqual([]);
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("contextMonitorEffects").withIndex("by_workspace_effect_key", (q) =>
        q.eq("workspaceId", workspaceId).eq("effectKey", "stale-wiki"),
      ).unique())?.status,
    )).resolves.toBe("needs_reconciliation");
  });
});
