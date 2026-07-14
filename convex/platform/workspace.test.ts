import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

describe("workspace authorization", () => {
  it("creates one owner workspace and default preferences", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "owner@example.test" }),
    );
    const asOwner = t.withIdentity({ subject: userId });

    const firstId = await asOwner.mutation(api.platform.workspace.ensureDefault, {});
    const secondId = await asOwner.mutation(api.platform.workspace.ensureDefault, {});
    expect(secondId).toBe(firstId);

    const viewer = await asOwner.query(api.platform.workspace.viewer, {});
    expect(viewer.workspace._id).toBe(firstId);
    expect(viewer.role).toBe("owner");
    expect(viewer.preferences).toMatchObject({
      unitSystem: "metric",
      reportingCurrency: "CAD",
    });
  });

  it("rejects anonymous and cross-workspace reads", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.platform.workspace.list, {})).rejects.toThrow(
      "Sign in is required",
    );

    const [ownerId, outsiderId] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("users", { email: "owner@example.test" }),
        ctx.db.insert("users", { email: "outsider@example.test" }),
      ]),
    );
    const workspaceId = await t
      .withIdentity({ subject: ownerId })
      .mutation(api.platform.workspace.ensureDefault, {});

    await expect(
      t
        .withIdentity({ subject: outsiderId })
        .query(api.platform.workspace.viewer, { workspaceId }),
    ).rejects.toThrow("You do not have access to this workspace");
  });
});

describe("local owner resolution", () => {
  it("reuses the existing account instead of creating a second owner", async () => {
    const t = convexTest(schema, modules);
    const existingId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "owner@example.test" }),
    );

    const resolved = await t.mutation(
      internal.platform.workspace.ensureLocalOwnerUser,
      {},
    );
    expect(resolved).toBe(existingId);

    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  it("creates the owner on first sign-in for an empty deployment", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(
      internal.platform.workspace.ensureLocalOwnerUser,
      {},
    );
    const again = await t.mutation(
      internal.platform.workspace.ensureLocalOwnerUser,
      {},
    );
    expect(again).toBe(created);

    const owner = await t.run((ctx) => ctx.db.query("users").unique());
    expect(owner?.email).toBe("owner@anorvis.local");
  });
});
