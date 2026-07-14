import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { requireWorkspace } from "./lib/auth";

const authorKind = v.union(v.literal("user"), v.literal("import"));
const pageStatus = v.union(
  v.literal("active"),
  v.literal("archived"),
  v.literal("deleted"),
);
const runKind = v.union(
  v.literal("orient"),
  v.literal("research"),
  v.literal("compile"),
  v.literal("interaction_memory"),
  v.literal("maintenance"),
);

function contentHash(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function path(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  if (!normalized || normalized === "." || normalized.split("/").includes("..")) {
    throw new ConvexError({ code: "INVALID_PATH", message: "Wiki path is invalid" });
  }
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

function strings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
}

function aliases(values: string[] | undefined): string[] {
  return strings(values).map(path);
}

function titleFromPath(value: string): string {
  const name = value.split("/").at(-1)?.replace(/\.md$/i, "") ?? "Untitled";
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function pageByPath(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
  input: string,
): Promise<Doc<"wikiPages"> | null> {
  const normalized = path(input);
  const page = await ctx.db
    .query("wikiPages")
    .withIndex("by_workspace_path", (q) =>
      q.eq("workspaceId", workspaceId).eq("path", normalized),
    )
    .unique();
  if (page !== null) return page;
  const alias = await ctx.db
    .query("wikiPageAliases")
    .withIndex("by_workspace_path", (q) =>
      q.eq("workspaceId", workspaceId).eq("path", normalized),
    )
    .unique();
  return alias === null ? null : ctx.db.get(alias.pageId);
}

function links(markdown: string): Array<{
  targetPath: string;
  label?: string;
  kind: "wiki" | "markdown" | "embed";
}> {
  const found: Array<{
    targetPath: string;
    label?: string;
    kind: "wiki" | "markdown" | "embed";
  }> = [];
  const wiki = /(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  for (const match of markdown.matchAll(wiki)) {
    try {
      found.push({
        targetPath: path(match[2]),
        label: match[3]?.trim() || undefined,
        kind: match[1] ? "embed" : "wiki",
      });
    } catch {
      // Malformed link targets remain plain Markdown.
    }
  }
  const markdownLink = /\[([^\]]+)\]\((?![a-z]+:|#)([^)#]+)(?:#[^)]+)?\)/gi;
  for (const match of markdown.matchAll(markdownLink)) {
    try {
      found.push({
        targetPath: path(match[2]),
        label: match[1].trim() || undefined,
        kind: "markdown",
      });
    } catch {
      // External and malformed targets are not Wiki graph edges.
    }
  }
  return found.slice(0, 500);
}

async function ensurePathsAvailable(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  pageId: Id<"wikiPages"> | undefined,
  paths: string[],
): Promise<void> {
  for (const value of paths) {
    const existing = await pageByPath(ctx, workspaceId, value);
    if (existing !== null && existing._id !== pageId) {
      throw new ConvexError({
        code: "PATH_CONFLICT",
        message: `Wiki path is already in use: ${value}`,
      });
    }
  }
}

async function addAliases(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  pageId: Id<"wikiPages">,
  values: string[],
  now: number,
): Promise<void> {
  for (const value of values) {
    const existing = await ctx.db
      .query("wikiPageAliases")
      .withIndex("by_workspace_path", (q) =>
        q.eq("workspaceId", workspaceId).eq("path", value),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("wikiPageAliases", {
        workspaceId,
        path: value,
        pageId,
        createdAt: now,
      });
    }
  }
}

async function resolveLinks(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  pageId: Id<"wikiPages">,
  paths: string[],
): Promise<void> {
  if (!paths.length) return;
  await ctx.scheduler.runAfter(0, internal.wiki.resolveLinksToPage, {
    workspaceId,
    pageId,
    paths: [...new Set(paths)],
    pathIndex: 0,
  });
}

type SaveRevision = {
  page: Doc<"wikiPages">;
  markdown: string;
  title: string;
  aliases: string[];
  tags: string[];
  authorKind: "user" | "agent" | "import" | "system";
  authorUserId?: Id<"users">;
  agentRunId?: Id<"wikiAgentRuns">;
  summary?: string;
};

async function appendRevision(
  ctx: MutationCtx,
  input: SaveRevision,
): Promise<Id<"wikiRevisions">> {
  const now = Date.now();
  const revisionNumber = input.page.revisionNumber + 1;
  const revisionId = await ctx.db.insert("wikiRevisions", {
    workspaceId: input.page.workspaceId,
    pageId: input.page._id,
    revisionNumber,
    parentRevisionId: input.page.currentRevisionId,
    markdown: input.markdown,
    contentHash: contentHash(input.markdown),
    authorKind: input.authorKind,
    authorUserId: input.authorUserId,
    agentRunId: input.agentRunId,
    summary: input.summary?.trim() || undefined,
    createdAt: now,
  });
  await ctx.db.patch(input.page._id, {
    title: input.title,
    aliases: input.aliases,
    tags: input.tags,
    currentRevisionId: revisionId,
    revisionNumber,
    status: "active",
    updatedAt: now,
  });
  const projection = await ctx.db
    .query("wikiSearchDocuments")
    .withIndex("by_page", (q) => q.eq("pageId", input.page._id))
    .unique();
  const value = {
    workspaceId: input.page.workspaceId,
    pageId: input.page._id,
    currentRevisionId: revisionId,
    path: input.page.path,
    title: input.title,
    aliases: input.aliases,
    tags: input.tags,
    markdown: input.markdown,
    searchText: [input.title, input.page.path, ...input.aliases, ...input.tags, input.markdown].join("\n"),
    contentHash: contentHash(input.markdown),
    status: "active" as const,
    updatedAt: now,
  };
  if (projection === null) await ctx.db.insert("wikiSearchDocuments", value);
  else await ctx.db.replace(projection._id, value);

  for (const link of links(input.markdown)) {
    const target = await pageByPath(ctx, input.page.workspaceId, link.targetPath);
    await ctx.db.insert("wikiLinks", {
      workspaceId: input.page.workspaceId,
      pageId: input.page._id,
      revisionId,
      targetPageId: target?._id,
      ...link,
    });
  }
  await ctx.scheduler.runAfter(0, internal.wiki.indexRevision, {
    pageId: input.page._id,
    revisionId,
  });
  return revisionId;
}

export const list = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    status: v.optional(pageStatus),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const status = args.status ?? "active";
    return ctx.db
      .query("wikiPages")
      .withIndex("by_workspace_status_updated", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("status", status),
      )
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 100, 1), 500));
  },
});

export const get = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("wikiPages")),
    path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const page = args.id
      ? await ctx.db.get(args.id)
      : args.path
        ? await pageByPath(ctx, access.workspaceId, args.path)
        : null;
    if (page === null || page.workspaceId !== access.workspaceId) return null;
    const revision = page.currentRevisionId
      ? await ctx.db.get(page.currentRevisionId)
      : null;
    return {
      ...page,
      aliases: page.aliases ?? [],
      tags: page.tags ?? [],
      revision,
    };
  },
});

export const search = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const queryText = args.query.trim();
    if (!queryText) return [];
    return ctx.db
      .query("wikiSearchDocuments")
      .withSearchIndex("search_content", (q) =>
        q
          .search("searchText", queryText)
          .eq("workspaceId", access.workspaceId)
          .eq("status", "active"),
      )
      .take(Math.min(Math.max(args.limit ?? 20, 1), 100));
  },
});

export const history = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    pageId: v.id("wikiPages"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const page = await ctx.db.get(args.pageId);
    if (page === null || page.workspaceId !== access.workspaceId) return [];
    return ctx.db
      .query("wikiRevisions")
      .withIndex("by_page_revision", (q) => q.eq("pageId", page._id))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 50, 1), 200));
  },
});

export const backlinks = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    pageId: v.id("wikiPages"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const target = await ctx.db.get(args.pageId);
    if (target === null || target.workspaceId !== access.workspaceId) return [];
    const rows = await ctx.db
      .query("wikiLinks")
      .withIndex("by_target_page", (q) => q.eq("targetPageId", target._id))
      .collect();
    const current = [];
    for (const row of rows) {
      const source = await ctx.db.get(row.pageId);
      if (source?.workspaceId === access.workspaceId && source.currentRevisionId === row.revisionId) {
        current.push({ ...row, sourcePath: source.path, sourceTitle: source.title });
      }
    }
    return current;
  },
});

export const unresolvedLinks = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const pages = await ctx.db
      .query("wikiPages")
      .withIndex("by_workspace_updated", (q) => q.eq("workspaceId", access.workspaceId))
      .take(500);
    const unresolved = [];
    for (const page of pages) {
      if (!page.currentRevisionId) continue;
      const rows = await ctx.db
        .query("wikiLinks")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      unresolved.push(
        ...rows.filter(
          (row) => row.revisionId === page.currentRevisionId && row.targetPageId === undefined,
        ),
      );
    }
    return unresolved.slice(0, 500);
  },
});

export const save = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    pageId: v.optional(v.id("wikiPages")),
    path: v.string(),
    title: v.optional(v.string()),
    markdown: v.string(),
    aliases: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    baseRevisionId: v.optional(v.id("wikiRevisions")),
    summary: v.optional(v.string()),
    authorKind: v.optional(authorKind),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const normalizedPath = path(args.path);
    const aliasPaths = aliases(args.aliases).filter((value) => value !== normalizedPath);
    if (!args.markdown.trim()) {
      throw new ConvexError({ code: "INVALID_CONTENT", message: "Wiki content is required" });
    }
    let page = args.pageId ? await ctx.db.get(args.pageId) : null;
    if (page !== null && page.workspaceId !== access.workspaceId) page = null;
    if (args.pageId && page === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Wiki page not found" });
    }
    const pageTitle = args.title?.trim() || page?.title || titleFromPath(normalizedPath);
    const pageTags =
      args.tags === undefined ? (page?.tags ?? []) : strings(args.tags);
    if (page === null) {
      await ensurePathsAvailable(ctx, access.workspaceId, undefined, [normalizedPath, ...aliasPaths]);
      const now = Date.now();
      const pageId = await ctx.db.insert("wikiPages", {
        workspaceId: access.workspaceId,
        path: normalizedPath,
        title: pageTitle,
        aliases: aliasPaths,
        tags: pageTags,
        revisionNumber: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      page = (await ctx.db.get(pageId))!;
      await addAliases(ctx, access.workspaceId, pageId, aliasPaths, now);
      await resolveLinks(ctx, access.workspaceId, pageId, [normalizedPath, ...aliasPaths]);
    } else {
      if (page.path !== normalizedPath) {
        throw new ConvexError({
          code: "PATH_MISMATCH",
          message: "Use rename to change a Wiki path",
        });
      }
      if (page.currentRevisionId !== args.baseRevisionId) {
        throw new ConvexError({
          code: "REVISION_CONFLICT",
          message: "Wiki page changed since it was loaded",
        });
      }
      const mergedAliases = [...new Set([...(page.aliases ?? []), ...aliasPaths])];
      await ensurePathsAvailable(ctx, access.workspaceId, page._id, mergedAliases);
      await addAliases(ctx, access.workspaceId, page._id, mergedAliases, Date.now());
      await resolveLinks(ctx, access.workspaceId, page._id, mergedAliases);
      aliasPaths.splice(0, aliasPaths.length, ...mergedAliases);
    }
    const revisionId = await appendRevision(ctx, {
      page,
      markdown: args.markdown,
      title: pageTitle,
      aliases: aliasPaths,
      tags: pageTags,
      authorKind: args.authorKind ?? "user",
      authorUserId: access.userId,
      summary: args.summary,
    });
    return { pageId: page._id, revisionId, revisionNumber: page.revisionNumber + 1 };
  },
});

export const rename = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    pageId: v.id("wikiPages"),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const page = await ctx.db.get(args.pageId);
    if (page === null || page.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Wiki page not found" });
    }
    const nextPath = path(args.path);
    if (nextPath === page.path) return page._id;
    await ensurePathsAvailable(ctx, access.workspaceId, page._id, [nextPath]);
    const nextAliases = [...new Set([...(page.aliases ?? []), page.path])];
    await addAliases(ctx, access.workspaceId, page._id, [page.path], Date.now());
    await resolveLinks(ctx, access.workspaceId, page._id, [nextPath, page.path]);
    await ctx.db.patch(page._id, {
      path: nextPath,
      aliases: nextAliases,
      updatedAt: Date.now(),
    });
    const projection = await ctx.db
      .query("wikiSearchDocuments")
      .withIndex("by_page", (q) => q.eq("pageId", page._id))
      .unique();
    if (projection !== null) {
      await ctx.db.patch(projection._id, {
        path: nextPath,
        aliases: nextAliases,
        searchText: [projection.title, nextPath, ...nextAliases, ...projection.tags, projection.markdown].join("\n"),
        updatedAt: Date.now(),
      });
    }
    return page._id;
  },
});

export const setStatus = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    pageId: v.id("wikiPages"),
    status: pageStatus,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const page = await ctx.db.get(args.pageId);
    if (page === null || page.workspaceId !== access.workspaceId) return false;
    await ctx.db.patch(page._id, { status: args.status, updatedAt: Date.now() });
    const projection = await ctx.db
      .query("wikiSearchDocuments")
      .withIndex("by_page", (q) => q.eq("pageId", page._id))
      .unique();
    if (projection !== null) {
      await ctx.db.patch(projection._id, {
        status: args.status,
        updatedAt: Date.now(),
      });
    }
    return true;
  },
});

export const rollback = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    pageId: v.id("wikiPages"),
    revisionId: v.id("wikiRevisions"),
    baseRevisionId: v.id("wikiRevisions"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const page = await ctx.db.get(args.pageId);
    const revision = await ctx.db.get(args.revisionId);
    if (
      page === null ||
      revision === null ||
      page.workspaceId !== access.workspaceId ||
      revision.pageId !== page._id
    ) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Wiki revision not found" });
    }
    if (page.currentRevisionId !== args.baseRevisionId) {
      throw new ConvexError({ code: "REVISION_CONFLICT", message: "Wiki page changed" });
    }
    const revisionId = await appendRevision(ctx, {
      page,
      markdown: revision.markdown,
      title: page.title,
      aliases: page.aliases ?? [],
      tags: page.tags ?? [],
      authorKind: "user",
      authorUserId: access.userId,
      summary: `Rollback to revision ${revision.revisionNumber}`,
    });
    return revisionId;
  },
});

export const beginAgentRun = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    kind: runKind,
    task: v.string(),
    model: v.optional(v.string()),
    allowWeb: v.boolean(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const now = Date.now();
    return ctx.db.insert("wikiAgentRuns", {
      workspaceId: access.workspaceId,
      kind: args.kind,
      task: args.task.trim(),
      status: "running",
      model: args.model,
      allowWeb: args.allowWeb,
      startedAt: now,
      createdAt: now,
    });
  },
});

export const finishAgentRun = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    runId: v.id("wikiAgentRuns"),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const run = await ctx.db.get(args.runId);
    if (run === null || run.workspaceId !== access.workspaceId) return false;
    await ctx.db.patch(run._id, {
      status: args.error ? "failed" : "completed",
      error: args.error?.slice(0, 4_000),
      finishedAt: Date.now(),
    });
    return true;
  },
});

export const generateUploadUrl = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return ctx.storage.generateUploadUrl();
  },
});

export const listSources = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    return ctx.db
      .query("wikiSources")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", access.workspaceId))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 100, 1), 500));
  },
});

export const listAttachments = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    pageId: v.optional(v.id("wikiPages")),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.pageId) {
      const page = await ctx.db.get(args.pageId);
      if (page?.workspaceId !== access.workspaceId) return [];
      return ctx.db
        .query("wikiAttachments")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .order("desc")
        .take(500);
    }
    return ctx.db
      .query("wikiAttachments")
      .withIndex("by_workspace_created", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .order("desc")
      .take(500);
  },
});

export const storeSource = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    kind: v.union(
      v.literal("upload"),
      v.literal("directory_import"),
      v.literal("url"),
      v.literal("interaction"),
      v.literal("provider"),
      v.literal("agent_research"),
    ),
    title: v.string(),
    origin: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    extractedText: v.optional(v.string()),
    contentHash: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wikiSources")
      .withIndex("by_workspace_hash", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("contentHash", args.contentHash),
      )
      .first();
    if (existing !== null) {
      return { id: existing._id, storageId: existing.storageId };
    }
    const now = Date.now();
    const sourceId = await ctx.db.insert("wikiSources", {
      ...args,
      title: args.title.trim(),
      status: args.extractedText ? "indexed" : "pending",
      createdAt: now,
      updatedAt: now,
    });
    if (args.extractedText) {
      await ctx.scheduler.runAfter(0, internal.wiki.indexSource, { sourceId });
    }
    return { id: sourceId, storageId: args.storageId };
  },
});

export const storeAttachment = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    pageId: v.optional(v.id("wikiPages")),
    sourceId: v.optional(v.id("wikiSources")),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    contentHash: v.string(),
    sensitivity: v.union(v.literal("private"), v.literal("shareable")),
  },
  handler: async (ctx, args) => {
    if (!args.pageId && !args.sourceId) {
      throw new ConvexError({
        code: "INVALID_ATTACHMENT",
        message: "Attachment must belong to a page or source",
      });
    }
    if (args.pageId) {
      const page = await ctx.db.get(args.pageId);
      if (page?.workspaceId !== args.workspaceId) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Wiki page not found" });
      }
    }
    if (args.sourceId) {
      const source = await ctx.db.get(args.sourceId);
      if (source?.workspaceId !== args.workspaceId) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Wiki source not found" });
      }
    }
    const owned = args.pageId
      ? await ctx.db
          .query("wikiAttachments")
          .withIndex("by_page_hash", (q) =>
            q.eq("pageId", args.pageId).eq("contentHash", args.contentHash),
          )
          .first()
      : await ctx.db
          .query("wikiAttachments")
          .withIndex("by_source_hash", (q) =>
            q.eq("sourceId", args.sourceId).eq("contentHash", args.contentHash),
          )
          .first();
    if (owned !== null) return { id: owned._id, storageId: owned.storageId };
    const canonical = await ctx.db
      .query("wikiAttachments")
      .withIndex("by_workspace_hash", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("contentHash", args.contentHash),
      )
      .first();
    const storageId = canonical?.storageId ?? args.storageId;
    const id = await ctx.db.insert("wikiAttachments", {
      ...args,
      storageId,
      name: args.name.trim(),
      createdAt: Date.now(),
    });
    return { id, storageId };
  },
});

export const attachmentForDelivery = internalQuery({
  args: { attachmentId: v.id("wikiAttachments") },
  handler: async (ctx, args) => {
    const attachment = await ctx.db.get(args.attachmentId);
    if (attachment === null) return null;
    const access = await requireWorkspace(ctx, attachment.workspaceId);
    return attachment.workspaceId === access.workspaceId ? attachment : null;
  },
});

export const chunksById = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    ids: v.array(v.id("wikiChunks")),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const rows = [];
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row?.workspaceId === access.workspaceId) rows.push(row);
    }
    return rows;
  },
});

export const indexSource = internalMutation({
  args: {
    sourceId: v.id("wikiSources"),
    offset: v.optional(v.number()),
    ordinal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (source?.extractedText === undefined) return 0;
    const text = source.extractedText;
    const start = args.offset ?? 0;
    let ordinal = args.ordinal ?? 0;
    let offset = start;
    for (let batch = 0; batch < 50 && offset < text.length; batch += 1) {
      const chunk = text.slice(offset, offset + 2_000).trim();
      offset += 2_000;
      if (!chunk) continue;
      const existing = await ctx.db
        .query("wikiChunks")
        .withIndex("by_source_ordinal", (q) =>
          q.eq("sourceId", source._id).eq("ordinal", ordinal),
        )
        .unique();
      if (existing === null) {
        await ctx.db.insert("wikiChunks", {
          workspaceId: source.workspaceId,
          sourceId: source._id,
          ordinal,
          headingPath: [],
          text: chunk,
          contentHash: contentHash(chunk),
          embeddingState: "pending",
        });
      }
      ordinal += 1;
    }
    if (offset < text.length && ordinal < 500) {
      await ctx.scheduler.runAfter(0, internal.wiki.indexSource, {
        sourceId: source._id,
        offset,
        ordinal,
      });
    }
    return ordinal;
  },
});

export const pendingEmbeddings = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    return ctx.db
      .query("wikiChunks")
      .withIndex("by_workspace_embedding_state", (q) =>
        q.eq("workspaceId", access.workspaceId).eq("embeddingState", "pending"),
      )
      .take(Math.min(Math.max(args.limit ?? 25, 1), 50));
  },
});

export const saveEmbeddings = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    model: v.string(),
    version: v.string(),
    items: v.array(
      v.object({
        id: v.id("wikiChunks"),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.items.length > 50) {
      throw new ConvexError({ code: "BATCH_TOO_LARGE", message: "Embedding batch limit is 50" });
    }
    let applied = 0;
    for (const item of args.items) {
      if (
        item.embedding.length !== 768 ||
        item.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new ConvexError({
          code: "INVALID_EMBEDDING",
          message: "Each embedding must contain 768 finite values",
        });
      }
      const chunk = await ctx.db.get(item.id);
      if (chunk?.workspaceId !== access.workspaceId) {
        throw new ConvexError({ code: "NOT_FOUND", message: "Wiki chunk not found" });
      }
      if (chunk.pageId && chunk.revisionId) {
        const page = await ctx.db.get(chunk.pageId);
        if (page?.currentRevisionId !== chunk.revisionId) continue;
      }
      await ctx.db.patch(chunk._id, {
        embedding: item.embedding,
        embeddingState: "ready",
        embeddingModel: args.model.trim(),
        embeddingVersion: args.version.trim(),
        embeddingError: undefined,
      });
      applied += 1;
    }
    return applied;
  },
});

export const failEmbeddings = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    ids: v.array(v.id("wikiChunks")),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    for (const id of args.ids.slice(0, 50)) {
      const chunk = await ctx.db.get(id);
      if (chunk?.workspaceId === access.workspaceId) {
        await ctx.db.patch(chunk._id, {
          embeddingState: "failed",
          embeddingError: args.error.slice(0, 1_000),
        });
      }
    }
    return Math.min(args.ids.length, 50);
  },
});

export const resolveLinksToPage = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    pageId: v.id("wikiPages"),
    paths: v.array(v.string()),
    pathIndex: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const targetPath = args.paths[args.pathIndex];
    if (!targetPath) return;
    const page = await ctx.db.get(args.pageId);
    if (page?.workspaceId !== args.workspaceId) return;
    const result = await ctx.db
      .query("wikiLinks")
      .withIndex("by_workspace_target_path", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("targetPath", targetPath),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: 100 });
    for (const row of result.page) {
      if (row.targetPageId === undefined) {
        await ctx.db.patch(row._id, { targetPageId: page._id });
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.wiki.resolveLinksToPage, {
        ...args,
        cursor: result.continueCursor,
      });
    } else if (args.pathIndex + 1 < args.paths.length) {
      await ctx.scheduler.runAfter(0, internal.wiki.resolveLinksToPage, {
        workspaceId: args.workspaceId,
        pageId: args.pageId,
        paths: args.paths,
        pathIndex: args.pathIndex + 1,
      });
    }
  },
});

export const indexRevision = internalMutation({
  args: {
    pageId: v.id("wikiPages"),
    revisionId: v.id("wikiRevisions"),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    const revision = await ctx.db.get(args.revisionId);
    if (page === null || revision === null || page.currentRevisionId !== revision._id) return 0;
    const existing = await ctx.db
      .query("wikiChunks")
      .withIndex("by_revision", (q) => q.eq("revisionId", revision._id))
      .collect();
    if (existing.length) return existing.length;
    const chunks: Array<{ headingPath: string[]; text: string }> = [];
    let headings: string[] = [];
    let text = "";
    const flush = () => {
      const value = text.trim();
      if (value) chunks.push({ headingPath: headings, text: value });
      text = "";
    };
    for (const line of revision.markdown.split("\n")) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        flush();
        const level = heading[1].length;
        headings = [...headings.slice(0, level - 1), heading[2].trim()];
      }
      if (text.length + line.length > 2_000) flush();
      text += `${line}\n`;
      if (chunks.length >= 199) break;
    }
    flush();
    const stale = await ctx.db
      .query("wikiChunks")
      .withIndex("by_page", (q) => q.eq("pageId", page._id))
      .take(500);
    for (const chunk of stale) await ctx.db.delete(chunk._id);
    for (const [ordinal, chunk] of chunks.entries()) {
      await ctx.db.insert("wikiChunks", {
        workspaceId: page.workspaceId,
        pageId: page._id,
        revisionId: revision._id,
        ordinal,
        headingPath: chunk.headingPath,
        text: chunk.text,
        contentHash: contentHash(chunk.text),
        embeddingState: "pending",
      });
    }
    return chunks.length;
  },
});
