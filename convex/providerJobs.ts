"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const run = internalAction({
  args: { jobId: v.id("syncJobs") },
  handler: async (ctx, args): Promise<void> => {
    const claim = await ctx.runMutation(internal.maintenance.claimProviderSync, {
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
          ? await ctx.runAction(internal.google.syncScheduledStep, {
              workspaceId: claim.workspaceId,
              cursor: claim.cursor,
            })
          : claim.provider === "hevy"
            ? await ctx.runAction(internal.hevy.syncScheduledStep, {
                workspaceId: claim.workspaceId,
                cursor: claim.cursor,
              })
            : await ctx.runAction(internal.snaptrade.syncScheduledStep, {
                workspaceId: claim.workspaceId,
                cursor: claim.cursor,
              });
      await ctx.runMutation(internal.maintenance.advanceProviderSync, {
        jobId: args.jobId,
        lease: claim.lease,
        ...result,
      });
    } catch (error) {
      await ctx.runMutation(internal.maintenance.failProviderSync, {
        jobId: args.jobId,
        lease: claim.lease,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
