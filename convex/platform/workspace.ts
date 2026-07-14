import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireUser, requireWorkspace } from "./auth/access";

export const ensureDefault = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing !== null) return existing.workspaceId;

    const now = Date.now();
    const baseSlug = `anorvis-${String(userId).slice(-8).toLowerCase()}`;
    const slugExists = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", baseSlug))
      .unique();
    if (slugExists !== null) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "A workspace already exists for this account identifier",
      });
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Anorvis",
      slug: baseSlug,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId,
      role: "owner",
      createdAt: now,
    });
    await ctx.db.insert("userPreferences", {
      workspaceId,
      userId,
      unitSystem: "metric",
      reportingCurrency: "CAD",
      updatedAt: now,
    });
    return workspaceId;
  },
});

export const viewer = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const [user, workspace, preferences] = await Promise.all([
      ctx.db.get(access.userId),
      ctx.db.get(access.workspaceId),
      ctx.db
        .query("userPreferences")
        .withIndex("by_workspace_user", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("userId", access.userId),
        )
        .unique(),
    ]);
    if (user === null || workspace === null) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "The authenticated workspace no longer exists",
      });
    }
    return { user, workspace, role: access.role, preferences };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return Promise.all(
      memberships.map(async (membership) => ({
        role: membership.role,
        workspace: await ctx.db.get(membership.workspaceId),
      })),
    );
  },
});
