import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";

const staleAfterMs = 20 * 60 * 1000;

export type SyncProvider = "google" | "hevy" | "snaptrade";
export type SyncKind = "manual" | "scheduled" | "live";

function newerWatermark(
  current: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentNumeric = Number(current);
  const candidateNumeric = Number(candidate);
  if (
    /^-?\d+(?:\.\d+)?$/.test(current) &&
    /^-?\d+(?:\.\d+)?$/.test(candidate) &&
    Number.isFinite(currentNumeric) &&
    Number.isFinite(candidateNumeric)
  ) {
    return candidateNumeric >= currentNumeric ? candidate : current;
  }
  const currentTime = Date.parse(current);
  const candidateTime = Date.parse(candidate);
  if (Number.isFinite(currentTime) && Number.isFinite(candidateTime)) {
    return candidateTime >= currentTime ? candidate : current;
  }
  return candidate >= current ? candidate : current;
}

export async function recordProviderSyncCompletion(
  ctx: { db: MutationCtx["db"] },
  workspaceId: Id<"workspaces">,
  provider: SyncProvider,
  watermark?: string,
  changed = true,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("providerSyncStates")
    .withIndex("by_workspace_provider", (q) =>
      q.eq("workspaceId", workspaceId).eq("provider", provider),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("providerSyncStates", {
      workspaceId,
      provider,
      sequence: 1,
      lastSyncedAt: now,
      lastChangedAt: now,
      lastAttemptAt: now,
      ...(watermark ? { watermark } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  const nextWatermark = newerWatermark(existing.watermark, watermark);
  await ctx.db.patch(existing._id, {
    // The sequence is the publication revision consumers watch; bump it only
    // when synced data actually changed so no-op polls do not fan out
    // invalidations every 30 seconds.
    ...(changed ? { sequence: existing.sequence + 1, lastChangedAt: now } : {}),
    lastSyncedAt: now,
    lastAttemptAt: now,
    lastError: undefined,
    lastErrorAt: undefined,
    ...(nextWatermark !== existing.watermark
      ? { watermark: nextWatermark }
      : {}),
    updatedAt: now,
  });
}

// Terminal sync failures land on the provider state so the dashboard can
// show what broke and when, instead of the job table swallowing the error.
export async function recordProviderSyncFailure(
  ctx: { db: MutationCtx["db"] },
  workspaceId: Id<"workspaces">,
  provider: SyncProvider,
  error: string,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("providerSyncStates")
    .withIndex("by_workspace_provider", (q) =>
      q.eq("workspaceId", workspaceId).eq("provider", provider),
    )
    .unique();
  const failure = {
    lastAttemptAt: now,
    lastError: error.slice(0, 500),
    lastErrorAt: now,
    updatedAt: now,
  };
  if (existing === null) {
    await ctx.db.insert("providerSyncStates", {
      workspaceId,
      provider,
      sequence: 0,
      ...failure,
      createdAt: now,
    });
    return;
  }
  await ctx.db.patch(existing._id, failure);
}

// Single enqueue path for scheduled, manual, post-OAuth, and live syncs. A
// runner that dies before claiming leaves its job pending forever, so an
// existing pending job gets the runner rescheduled. Completed live jobs are
// recycled so the 30-second cron cannot grow syncJobs without bound.
export async function enqueueSync(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  provider: SyncProvider,
  kind: SyncKind,
): Promise<{ jobId: Id<"syncJobs">; scheduled: boolean }> {
  const now = Date.now();
  const active = async (status: "pending" | "running") =>
    ctx.db
      .query("syncJobs")
      .withIndex("by_workspace_provider_status", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("provider", provider)
          .eq("status", status),
      )
      .first();
  const pending = await active("pending");
  if (pending !== null) {
    await ctx.scheduler.runAfter(0, internal.capability.integration.runner.run, {
      jobId: pending._id,
    });
    return { jobId: pending._id, scheduled: true };
  }
  const running = await active("running");
  if (running !== null && running.updatedAt >= now - staleAfterMs) {
    return { jobId: running._id, scheduled: false };
  }
  if (running !== null) {
    await ctx.db.patch(running._id, {
      status: "pending",
      error: "Recovered stale provider sync lease",
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.capability.integration.runner.run, {
      jobId: running._id,
    });
    return { jobId: running._id, scheduled: true };
  }

  if (kind === "live") {
    const previous = await ctx.db
      .query("syncJobs")
      .withIndex("by_workspace_provider_kind_status", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("provider", provider)
          .eq("kind", "live")
          .eq("status", "completed"),
      )
      .order("desc")
      .first();
    const failed = previous === null
      ? await ctx.db
          .query("syncJobs")
          .withIndex("by_workspace_provider_kind_status", (q) =>
            q
              .eq("workspaceId", workspaceId)
              .eq("provider", provider)
              .eq("kind", "live")
              .eq("status", "failed"),
          )
          .order("desc")
          .first()
      : null;
    const reusable = previous ?? failed;
    if (reusable !== null) {
      await ctx.db.patch(reusable._id, {
        status: "pending",
        cursor: undefined,
        checkpoint: undefined,
        fetchedCount: 0,
        appliedCount: 0,
        skippedCount: 0,
        attempt: 0,
        error: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.capability.integration.runner.run, {
        jobId: reusable._id,
      });
      return { jobId: reusable._id, scheduled: true };
    }
  }

  const jobId = await ctx.db.insert("syncJobs", {
    workspaceId,
    provider,
    kind,
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
  return { jobId, scheduled: true };
}

// System-context enqueue for flows without a signed-in user, such as the
// OAuth HTTP callback finishing a connection.
export const enqueueProviderSync = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    provider: v.union(
      v.literal("google"),
      v.literal("hevy"),
      v.literal("snaptrade"),
    ),
    kind: v.union(v.literal("manual"), v.literal("scheduled"), v.literal("live")),
  },
  handler: async (ctx, args) =>
    (await enqueueSync(ctx, args.workspaceId, args.provider, args.kind)).jobId,
});

export const publishProviderSyncCompletion = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    provider: v.union(
      v.literal("google"),
      v.literal("hevy"),
      v.literal("snaptrade"),
    ),
    watermark: v.optional(v.string()),
    changed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await recordProviderSyncCompletion(
      ctx,
      args.workspaceId,
      args.provider,
      args.watermark,
      args.changed ?? true,
    );
  },
});

// Disconnecting a provider must stop its in-flight and queued work; a lease
// bump invalidates any runner step that is still executing.
export async function cancelActiveSyncs(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  provider: SyncProvider,
  reason: string,
): Promise<number> {
  const now = Date.now();
  let cancelled = 0;
  for (const status of ["pending", "running"] as const) {
    const jobs = await ctx.db
      .query("syncJobs")
      .withIndex("by_workspace_provider_status", (q) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("provider", provider)
          .eq("status", status),
      )
      .collect();
    for (const job of jobs) {
      await ctx.db.patch(job._id, {
        status: "failed",
        error: reason,
        lease: (job.lease ?? 0) + 1,
        finishedAt: now,
        updatedAt: now,
      });
      cancelled += 1;
    }
  }
  return cancelled;
}

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
    for (const connection of connections) {
      if (
        connection.provider !== "google" &&
        connection.provider !== "hevy" &&
        connection.provider !== "snaptrade"
      )
        continue;
      const result = await enqueueSync(
        ctx,
        connection.workspaceId,
        connection.provider,
        "scheduled",
      );
      if (result.scheduled) enqueued += 1;
    }
    return enqueued;
  },
});

export const enqueueLiveHevySyncs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const connections = (await ctx.db.query("providerConnections").collect()).filter(
      (connection) =>
        connection.provider === "hevy" &&
        connection.status === "connected" &&
        connection.credentials !== undefined,
    );
    let enqueued = 0;
    for (const connection of connections) {
      if (connection.status !== "connected" || connection.credentials === undefined) {
        continue;
      }
      const result = await enqueueSync(ctx, connection.workspaceId, "hevy", "live");
      if (result.scheduled) enqueued += 1;
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
      kind: job.kind,
    };
  },
});

export const advanceProviderSync = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    lease: v.number(),
    done: v.boolean(),
    cursor: v.optional(v.string()),
    watermark: v.optional(v.string()),
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
    if (
      args.done &&
      (job.provider === "google" ||
        job.provider === "hevy" ||
        job.provider === "snaptrade")
    ) {
      await recordProviderSyncCompletion(
        ctx,
        job.workspaceId,
        job.provider,
        args.watermark,
        job.appliedCount + args.applied > 0,
      );
    }
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
    retryAfterMs: v.optional(v.number()),
    permanent: v.optional(v.boolean()),
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
    // Rate-limited jobs get a longer budget: the provider told us when to
    // come back, so honoring that hint usually succeeds. Permanent errors
    // (revoked auth, invalid data) never retry — the stored message is the
    // actionable one and retrying would bury it.
    const rateLimited = args.retryAfterMs !== undefined;
    const retry = !args.permanent && attempt < (rateLimited ? 8 : 4);
    await ctx.db.patch(job._id, {
      status: retry ? "pending" : "failed",
      attempt,
      error: args.error.slice(0, 2_000),
      finishedAt: retry ? undefined : now,
      updatedAt: now,
    });
    if (retry) {
      const backoff = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
      // Never wait less than the provider's requested window (bounded so a
      // nonsense hint cannot park the job for hours).
      await ctx.scheduler.runAfter(
        Math.min(900_000, Math.max(backoff, args.retryAfterMs ?? 0)),
        internal.capability.integration.runner.run,
        { jobId: args.jobId },
      );
      return;
    }
    if (
      job.provider === "google" ||
      job.provider === "hevy" ||
      job.provider === "snaptrade"
    ) {
      await recordProviderSyncFailure(
        ctx,
        job.workspaceId,
        job.provider,
        args.error,
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
