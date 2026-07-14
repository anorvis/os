"use node";

import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

async function hashBlob(blob: Blob): Promise<string> {
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hash.update(chunk.value);
  }
  return bytesToHex(hash.digest());
}

export const registerSource = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    storageId: v.id("_storage"),
    kind: v.union(v.literal("upload"), v.literal("directory_import")),
    title: v.string(),
    origin: v.optional(v.string()),
    mimeType: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"wikiSources">> => {
    const workspaceId: Id<"workspaces"> = await ctx.runQuery(
      internal.integrations.authorizeWorkspace,
      { workspaceId: args.workspaceId },
    );
    const blob = await ctx.storage.get(args.storageId);
    if (blob === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Uploaded source not found" });
    }
    const mimeType = args.mimeType ?? blob.type;
    const text =
      blob.size <= 1_000_000 &&
      (mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/xml")
        ? await blob.text()
        : undefined;
    const stored = await ctx.runMutation(internal.wiki.storeSource, {
      workspaceId,
      storageId: args.storageId,
      kind: args.kind,
      title: args.title,
      origin: args.origin,
      extractedText: text,
      contentHash: await hashBlob(blob),
    });
    if (stored.storageId !== args.storageId) {
      await ctx.storage.delete(args.storageId);
    }
    return stored.id;
  },
});

export const registerAttachment = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    storageId: v.id("_storage"),
    pageId: v.optional(v.id("wikiPages")),
    sourceId: v.optional(v.id("wikiSources")),
    name: v.string(),
    mimeType: v.string(),
    sensitivity: v.union(v.literal("private"), v.literal("shareable")),
  },
  handler: async (ctx, args): Promise<Id<"wikiAttachments">> => {
    const workspaceId: Id<"workspaces"> = await ctx.runQuery(
      internal.integrations.authorizeWorkspace,
      { workspaceId: args.workspaceId },
    );
    const blob = await ctx.storage.get(args.storageId);
    if (blob === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Uploaded attachment not found" });
    }
    const stored = await ctx.runMutation(internal.wiki.storeAttachment, {
      workspaceId,
      storageId: args.storageId,
      pageId: args.pageId,
      sourceId: args.sourceId,
      name: args.name,
      mimeType: args.mimeType || blob.type || "application/octet-stream",
      size: blob.size,
      contentHash: await hashBlob(blob),
      sensitivity: args.sensitivity,
    });
    if (stored.storageId !== args.storageId) {
      await ctx.storage.delete(args.storageId);
    }
    return stored.id;
  },
});

export const semanticSearch = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    embedding: v.array(v.float64()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<Doc<"wikiChunks"> & { score: number }>> => {
    if (args.embedding.length !== 768 || args.embedding.some((value) => !Number.isFinite(value))) {
      throw new ConvexError({
        code: "INVALID_EMBEDDING",
        message: "Semantic search requires 768 finite embedding values",
      });
    }
    const workspaceId: Id<"workspaces"> = await ctx.runQuery(
      internal.integrations.authorizeWorkspace,
      { workspaceId: args.workspaceId },
    );
    const matches = await ctx.vectorSearch("wikiChunks", "by_embedding", {
      vector: args.embedding,
      limit: Math.min(Math.max(args.limit ?? 20, 1), 100),
      filter: (q) => q.eq("workspaceId", workspaceId),
    });
    const rows: Array<Doc<"wikiChunks">> = await ctx.runQuery(
      internal.wiki.chunksById,
      {
        workspaceId,
        ids: matches.map((match) => match._id),
      },
    );
    const scores = new Map(matches.map((match) => [match._id, match._score]));
    return rows.map((row) => ({ ...row, score: scores.get(row._id) ?? 0 }));
  },
});

