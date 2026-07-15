"use node";

import { v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";

export const run = internalAction({
  args: { jobId: v.id("syncJobs") },
  handler: async (ctx, args): Promise<void> => {
    const claim = await ctx.runMutation(internal.capability.integration.jobs.claimProviderSync, {
      jobId: args.jobId,
    });
    if (claim === null) return;
    try {
      if (
        claim.provider !== "google" &&
        claim.provider !== "hevy" &&
        claim.provider !== "snaptrade"
      ) {
        throw new Error(`Unsupported sync provider: ${claim.provider}`);
      }
      const result =
        claim.provider === "google"
          ? await ctx.runAction(internal.capability.integration.google.syncScheduledStep, {
              workspaceId: claim.workspaceId,
              cursor: claim.cursor,
            })
          : claim.provider === "hevy"
            ? await ctx.runAction(internal.capability.integration.hevy.syncScheduledStep, {
                workspaceId: claim.workspaceId,
                cursor: claim.cursor,
              })
            : await ctx.runAction(internal.capability.finance.snaptrade.syncScheduledStep, {
                workspaceId: claim.workspaceId,
                cursor: claim.cursor,
              });
      // Steps may return provider-specific extras (e.g. Hevy's created and
      // updated); the progress contract is exactly these counters.
      await ctx.runMutation(internal.capability.integration.jobs.advanceProviderSync, {
        jobId: args.jobId,
        lease: claim.lease,
        done: result.done,
        cursor: result.cursor,
        fetched: result.fetched,
        applied: result.applied,
        skipped: result.skipped,
      });
    } catch (error) {
      await ctx.runMutation(internal.capability.integration.jobs.failProviderSync, {
        jobId: args.jobId,
        lease: claim.lease,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
