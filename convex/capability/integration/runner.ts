"use node";

import { ConvexError, v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalAction } from "../../_generated/server";

// Errors that will not recover on their own; retrying only spams the
// provider and buries the actionable message under later failures.
const PERMANENT_CODES = new Set(["NOT_CONNECTED", "REAUTH_REQUIRED", "INVALID_INPUT"]);

type SyncErrorInfo = {
  message: string;
  retryAfterMs?: number;
  permanent: boolean;
};

// Providers throw ConvexError({ code, message, retryAfterMs? }); the data
// object survives nested action boundaries even when the message string gets
// wrapped in "Uncaught ConvexError:" prefixes.
function classifySyncError(error: unknown): SyncErrorInfo {
  const fallback = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ConvexError)) {
    return { message: fallback, permanent: false };
  }
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) {
    return {
      message: typeof data === "string" ? data : fallback,
      permanent: false,
    };
  }
  const message =
    "message" in data && typeof data.message === "string"
      ? data.message
      : fallback;
  const code = "code" in data && typeof data.code === "string" ? data.code : "";
  const hint =
    "retryAfterMs" in data &&
    typeof data.retryAfterMs === "number" &&
    Number.isFinite(data.retryAfterMs) &&
    data.retryAfterMs > 0
      ? data.retryAfterMs
      : undefined;
  return {
    message,
    ...(hint !== undefined ? { retryAfterMs: hint } : {}),
    permanent: PERMANENT_CODES.has(code),
  };
}

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
      let hevyMode: "full" | "live" = "full";
      if (claim.provider === "hevy" && claim.cursor?.includes("\"mode\":\"live\"")) {
        hevyMode = "live";
      } else if (
        claim.provider === "hevy" &&
        claim.cursor === undefined &&
        claim.kind === "live"
      ) {
        const state = await ctx.runQuery(
          internal.capability.integration.providerSyncState,
          { workspaceId: claim.workspaceId, provider: "hevy" },
        );
        hevyMode = state?.watermark ? "live" : "full";
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
                mode: hevyMode,
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
        watermark: "watermark" in result ? result.watermark : undefined,
        skipped: result.skipped,
      });
    } catch (error) {
      const info = classifySyncError(error);
      await ctx.runMutation(internal.capability.integration.jobs.failProviderSync, {
        jobId: args.jobId,
        lease: claim.lease,
        error: info.message,
        retryAfterMs: info.retryAfterMs,
        permanent: info.permanent,
      });
    }
  },
});
