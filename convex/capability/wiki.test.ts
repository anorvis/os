import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "wiki-owner@example.test" }),
  );
  const client = t.withIdentity({ subject: userId });
  const workspaceId = await client.mutation(api.platform.workspace.ensureDefault, {});
  return { t, client, workspaceId };
}

afterEach(() => vi.useRealTimers());

describe("native Wiki", () => {
  it("keeps append-only revisions and rejects stale edits", async () => {
    const { t, client } = await owner();
    const created = await client.mutation(api.capability.wiki.save, {
      path: "Architecture/Backend",
      markdown: "# Backend\n\nConvex.",
    });
    await expect(
      client.mutation(api.capability.wiki.save, {
        pageId: created.pageId,
        path: "Architecture/Backend.md",
        markdown: "# Backend\n\nStale edit.",
      }),
    ).rejects.toThrow("Wiki page changed since it was loaded");
    const updated = await client.mutation(api.capability.wiki.save, {
      pageId: created.pageId,
      baseRevisionId: created.revisionId,
      path: "Architecture/Backend.md",
      markdown: "# Backend\n\nConvex is canonical.",
      summary: "Clarify persistence",
    });
    const history = await client.query(api.capability.wiki.history, {
      pageId: created.pageId,
    });
    expect(history.map((revision) => revision._id)).toEqual([
      updated.revisionId,
      created.revisionId,
    ]);
    expect(history[1].markdown).toContain("Convex.");
    expect(await t.run((ctx) => ctx.db.query("wikiRevisions").collect())).toHaveLength(2);
  });

  it("preserves rename aliases and rejects path collisions", async () => {
    const { client } = await owner();
    const first = await client.mutation(api.capability.wiki.save, {
      path: "Notes/First",
      aliases: ["First Note"],
      markdown: "# First",
    });
    await client.mutation(api.capability.wiki.rename, {
      pageId: first.pageId,
      path: "Notes/Renamed",
    });
    const oldPath = await client.query(api.capability.wiki.get, { path: "Notes/First" });
    const explicitAlias = await client.query(api.capability.wiki.get, { path: "First Note" });
    expect(oldPath?._id).toBe(first.pageId);
    expect(explicitAlias?._id).toBe(first.pageId);
    const second = await client.mutation(api.capability.wiki.save, {
      path: "Notes/Second",
      markdown: "# Second",
    });
    await expect(
      client.mutation(api.capability.wiki.rename, {
        pageId: second.pageId,
        path: "Notes/First",
      }),
    ).rejects.toThrow("Wiki path is already in use");
  });

  it("repairs unresolved graph edges when a target appears", async () => {
    vi.useFakeTimers();
    const { t, client } = await owner();
    const source = await client.mutation(api.capability.wiki.save, {
      path: "Source",
      markdown: "See [[Future Target|the future]].",
    });
    expect(await client.query(api.capability.wiki.unresolvedLinks, {})).toHaveLength(1);
    const target = await client.mutation(api.capability.wiki.save, {
      path: "Future Target",
      markdown: "# Future Target",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await client.query(api.capability.wiki.unresolvedLinks, {})).toHaveLength(0);
    const backlinks = await client.query(api.capability.wiki.backlinks, {
      pageId: target.pageId,
    });
    expect(backlinks).toMatchObject([
      { pageId: source.pageId, targetPageId: target.pageId, label: "the future" },
    ]);
  });

  it("validates attachment tenancy and reuses bytes without merging owners", async () => {
    const { t, client, workspaceId } = await owner();
    const first = await client.mutation(api.capability.wiki.save, {
      path: "Files/First",
      markdown: "# First",
    });
    const second = await client.mutation(api.capability.wiki.save, {
      path: "Files/Second",
      markdown: "# Second",
    });
    const [firstStorageId, secondStorageId] = await Promise.all([
      t.run((ctx) => ctx.storage.store(new Blob(["same bytes"], { type: "text/plain" }))),
      t.run((ctx) => ctx.storage.store(new Blob(["same bytes"], { type: "text/plain" }))),
    ]);
    const input = {
      workspaceId,
      name: "same.txt",
      mimeType: "text/plain",
      size: 10,
      contentHash: "same-content-hash",
      sensitivity: "private" as const,
    };
    const firstAttachment = await t.mutation(internal.capability.wiki.storeAttachment, {
      ...input,
      pageId: first.pageId,
      storageId: firstStorageId,
    });
    const secondAttachment = await t.mutation(internal.capability.wiki.storeAttachment, {
      ...input,
      pageId: second.pageId,
      storageId: secondStorageId,
    });
    expect(secondAttachment.id).not.toBe(firstAttachment.id);
    expect(secondAttachment.storageId).toBe(firstAttachment.storageId);

    const otherUserId = await t.run((ctx) =>
      ctx.db.insert("users", { email: "other@example.test" }),
    );
    const other = t.withIdentity({ subject: otherUserId });
    const otherWorkspaceId = await other.mutation(api.platform.workspace.ensureDefault, {});
    await expect(
      t.mutation(internal.capability.wiki.storeAttachment, {
        ...input,
        workspaceId: otherWorkspaceId,
        pageId: first.pageId,
        storageId: secondStorageId,
      }),
    ).rejects.toThrow("Wiki page not found");
  });

  it("authorizes file delivery, supports ranges, and downloads active content", async () => {
    const { t, client, workspaceId } = await owner();
    const page = await client.mutation(api.capability.wiki.save, {
      path: "Files/Delivery",
      markdown: "# Delivery",
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["<script>alert(1)</script>"], { type: "text/html" })),
    );
    const stored = await t.mutation(internal.capability.wiki.storeAttachment, {
      workspaceId,
      pageId: page.pageId,
      storageId,
      name: "unsafe.html",
      mimeType: "text/html",
      size: 25,
      contentHash: "unsafe-html-hash",
      sensitivity: "private",
    });
    const unauthorized = await t.fetch(`/files/${stored.id}`);
    expect(unauthorized.status).toBe(401);
    const response = await client.fetch(`/files/${stored.id}`, {
      headers: { Range: "bytes=1-6" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-6/25");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("script");
  });
});
