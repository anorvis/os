import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type DatabaseCtx = QueryCtx | MutationCtx;
type WorkspaceRole = "owner" | "member";

export type WorkspaceAccess = {
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
  role: WorkspaceRole;
};

export async function requireUser(ctx: DatabaseCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in is required" });
  }
  return userId;
}

export async function requireWorkspace(
  ctx: DatabaseCtx,
  workspaceId?: Id<"workspaces">,
): Promise<WorkspaceAccess> {
  const userId = await requireUser(ctx);
  const membership = workspaceId
    ? await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", userId),
        )
        .unique()
    : await ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();

  if (membership === null) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: workspaceId
        ? "You do not have access to this workspace"
        : "Create a workspace before using Anorvis",
    });
  }

  return {
    userId,
    workspaceId: membership.workspaceId,
    role: membership.role,
  };
}

export async function requireOwner(
  ctx: DatabaseCtx,
  workspaceId?: Id<"workspaces">,
): Promise<WorkspaceAccess> {
  const access = await requireWorkspace(ctx, workspaceId);
  if (access.role !== "owner") {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Workspace owner access is required",
    });
  }
  return access;
}
