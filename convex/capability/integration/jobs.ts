import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalMutation } from "../../_generated/server";

const staleAfterMs = 20 * 60 * 1000;

export const enqueueProviderSyncs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const connections = (
      await ctx.db.query("providerConnections").collect()
    ).filter(
      (connection) =>
        connection.status === "connected" &&
        connection.credentials !== undefined,
    );
    let enqueued = 0;
    const now = Date.now();
    for (const connection of connections) {
      const pending = await ctx.db
        .query("syncJobs")
        .withIndex("by_workspace_provider_status", (q) =>
          q
            .eq("workspaceId", connection.workspaceId)
            .eq("provider", connection.provider)
            .eq("status", "pending"),
        )
        .first();
      if (pending !== null) continue;
      const running = await ctx.db
        .query("syncJobs")
        .withIndex("by_workspace_provider_status", (q) =>
          q
            .eq("workspaceId", connection.workspaceId)
            .eq("provider", connection.provider)
            .eq("status", "running"),
        )
        .first();
      if (running !== null && running.updatedAt >= now - staleAfterMs) continue;
      if (running !== null) {
        await ctx.db.patch(running._id, {
          status: "pending",
          error: "Recovered stale provider sync lease",
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(0, internal.capability.integration.runner.run, {
          jobId: running._id,
        });
        enqueued += 1;
        continue;
      }
      const provider = connection.provider as "google" | "hevy" | "snaptrade";
      const jobId = await ctx.db.insert("syncJobs", {
        workspaceId: connection.workspaceId,
        provider,
        kind: "scheduled",
        status: "pending",
        fetchedCount: 0,
        appliedCount: 0,
        skippedCount: 0,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.capability.integration.runner.run, {
        jobId,
      });
      enqueued += 1;
    }
    return enqueued;
  },
});

export const claimProviderSync = internalMutation({
  args: { jobId: v.id("syncJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "pending") return null;
    const now = Date.now();
    const lease = (job.lease ?? 0) + 1;
    await ctx.db.patch(job._id, {
      status: "running",
      lease,
      startedAt: job.startedAt ?? now,
      error: undefined,
      updatedAt: now,
    });
    return {
      cursor: job.cursor,
      lease,
      workspaceId: job.workspaceId,
      provider: job.provider,
    };
  },
});

export const advanceProviderSync = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    lease: v.number(),
    done: v.boolean(),
    cursor: v.optional(v.string()),
    fetched: v.number(),
    applied: v.number(),
    skipped: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.status !== "running" ||
      job.lease !== args.lease
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: args.done ? "completed" : "pending",
      cursor: args.cursor,
      checkpoint: args.cursor,
      fetchedCount: job.fetchedCount + args.fetched,
      appliedCount: job.appliedCount + args.applied,
      skippedCount: job.skippedCount + args.skipped,
      finishedAt: args.done ? now : undefined,
      updatedAt: now,
    });
    if (!args.done) {
      await ctx.scheduler.runAfter(0, internal.capability.integration.runner.run, {
        jobId: args.jobId,
      });
    }
    return true;
  },
});

export const failProviderSync = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    lease: v.number(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.status !== "running" ||
      job.lease !== args.lease
    ) {
      return;
    }
    const now = Date.now();
    const attempt = job.attempt + 1;
    const retry = attempt < 4;
    await ctx.db.patch(job._id, {
      status: retry ? "pending" : "failed",
      attempt,
      error: args.error.slice(0, 2_000),
      finishedAt: retry ? undefined : now,
      updatedAt: now,
    });
    if (retry) {
      await ctx.scheduler.runAfter(
        Math.min(60_000, 1_000 * 2 ** (attempt - 1)),
        internal.capability.integration.runner.run,
        { jobId: args.jobId },
      );
    }
  },
});

export const cleanupOAuthStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const workspaces = await ctx.db.query("workspaces").collect();
    let removed = 0;
    for (const workspace of workspaces) {
      const states = await ctx.db
        .query("oauthStates")
        .withIndex("by_workspace_expires", (q) =>
          q.eq("workspaceId", workspace._id).lt("expiresAt", now),
        )
        .take(500 - removed);
      for (const state of states) await ctx.db.delete(state._id);
      removed += states.length;
      if (removed >= 500) break;
    }
    return removed;
  },
});
