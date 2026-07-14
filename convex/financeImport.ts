import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation } from "./_generated/server";
import { requireWorkspace } from "./lib/auth";
import { formatDecimal, parseDecimal } from "./lib/decimal";

const mapping = v.object({
  dateColumn: v.string(),
  descriptionColumn: v.string(),
  amountColumn: v.string(),
  currencyColumn: v.optional(v.string()),
  categoryColumn: v.optional(v.string()),
  defaultCurrency: v.string(),
});
const importRow = v.object({
  rowNumber: v.number(),
  postedAt: v.number(),
  description: v.string(),
  amount: v.string(),
  currency: v.string(),
  categoryName: v.optional(v.string()),
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "CSV has an unterminated quote" });
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => value.trim() !== ""));
}

function parseDate(value: string, rowNumber: number): number {
  const input = value.trim();
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(input)
    ? Date.parse(`${input}T00:00:00.000Z`)
    : Date.parse(input);
  if (!Number.isFinite(timestamp)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `CSV row ${rowNumber} has an invalid date`,
    });
  }
  return timestamp;
}

function columnIndex(headers: string[], name: string, label: string): number {
  const index = headers.findIndex(
    (header) => header.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
  );
  if (index < 0) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} column '${name}' was not found`,
    });
  }
  return index;
}

export const generateUploadUrl = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    await requireWorkspace(ctx, args.workspaceId);
    return ctx.storage.generateUploadUrl();
  },
});

export const begin = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    accountId: v.id("financeAccounts"),
    storageId: v.optional(v.id("_storage")),
    idempotencyKey: v.string(),
    mapping: v.optional(mapping),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const account = await ctx.db.get(args.accountId);
    if (account === null || account.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Finance account not found" });
    }
    const idempotencyKey = args.idempotencyKey.trim();
    if (!idempotencyKey) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Import idempotency key is required" });
    }
    const existing = await ctx.db
      .query("financeImportJobs")
      .withIndex("by_workspace_idempotency", (q) =>
        q
          .eq("workspaceId", access.workspaceId)
          .eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    const now = Date.now();
    if (existing !== null) {
      if (existing.status !== "completed") {
        await ctx.db.patch(existing._id, {
          status: "running",
          error: undefined,
          attempt: existing.attempt + 1,
          startedAt: now,
          updatedAt: now,
        });
      }
      return {
        jobId: existing._id,
        cursor: Number.parseInt(existing.cursor ?? "0", 10) || 0,
        completed: existing.status === "completed",
      };
    }
    const jobId = await ctx.db.insert("financeImportJobs", {
      workspaceId: access.workspaceId,
      source: "csv",
      accountId: account._id,
      storageId: args.storageId,
      mapping: args.mapping,
      status: "running",
      cursor: "0",
      idempotencyKey,
      fetchedCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      attempt: 1,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { jobId, cursor: 0, completed: false };
  },
});

export const applyBatch = internalMutation({
  args: { jobId: v.id("financeImportJobs"), rows: v.array(importRow) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "running" || job.accountId === undefined) {
      throw new ConvexError({ code: "CONFLICT", message: "Import job is not running" });
    }
    let applied = 0;
    let skipped = 0;
    for (const row of args.rows) {
      const sourceId = `${job.idempotencyKey}:${row.rowNumber}`;
      const existing = await ctx.db
        .query("financeTransactions")
        .withIndex("by_workspace_source_id", (q) =>
          q
            .eq("workspaceId", job.workspaceId)
            .eq("source", "csv")
            .eq("sourceId", sourceId),
        )
        .unique();
      if (existing !== null) {
        skipped += 1;
        continue;
      }
      let categoryId;
      const categoryName = row.categoryName?.trim();
      if (categoryName) {
        const normalizedName = categoryName.toLocaleLowerCase();
        const category = await ctx.db
          .query("financeCategories")
          .withIndex("by_workspace_name", (q) =>
            q
              .eq("workspaceId", job.workspaceId)
              .eq("normalizedName", normalizedName),
          )
          .unique();
        categoryId =
          category?._id ??
          (await ctx.db.insert("financeCategories", {
            workspaceId: job.workspaceId,
            name: categoryName,
            normalizedName,
            group: "Imported",
            excludeFromSpending: false,
          }));
      }
      const amount = parseDecimal(row.amount, `CSV row ${row.rowNumber} amount`);
      const now = Date.now();
      await ctx.db.insert("financeTransactions", {
        workspaceId: job.workspaceId,
        accountId: job.accountId,
        source: "csv",
        sourceId,
        importJobId: job._id,
        fingerprint: sourceId,
        dedupeKey: `csv:${sourceId}`,
        description: row.description.trim(),
        amount,
        currency: row.currency.trim().toUpperCase(),
        postedAt: row.postedAt,
        categoryId,
        status: "posted",
        createdAt: now,
        updatedAt: now,
      });
      applied += 1;
    }
    const cursor = args.rows.length
      ? Math.max(...args.rows.map((row) => row.rowNumber))
      : Number.parseInt(job.cursor ?? "0", 10);
    await ctx.db.patch(job._id, {
      cursor: String(cursor),
      fetchedCount: job.fetchedCount + args.rows.length,
      appliedCount: job.appliedCount + applied,
      skippedCount: job.skippedCount + skipped,
      checkpoint: String(cursor),
      updatedAt: Date.now(),
    });
    return { applied, skipped };
  },
});

export const finish = internalMutation({
  args: {
    jobId: v.id("financeImportJobs"),
    storageId: v.optional(v.id("_storage")),
    totalRows: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "completed",
      fetchedCount: Math.max(job.fetchedCount, args.totalRows),
      cursor: String(args.totalRows),
      checkpoint: String(args.totalRows),
      finishedAt: now,
      updatedAt: now,
    });
    if (args.storageId !== undefined) await ctx.storage.delete(args.storageId);
  },
});

export const fail = internalMutation({
  args: { jobId: v.id("financeImportJobs"), error: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "failed",
      error: args.error.slice(0, 2_000),
      finishedAt: now,
      updatedAt: now,
    });
  },
});

export const undoImport = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    importId: v.id("financeImportJobs"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const job = await ctx.db.get(args.importId);
    if (job === null || job.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Finance import not found" });
    }
    const transactions = await ctx.db
      .query("financeTransactions")
      .withIndex("by_workspace_posted", (q) => q.eq("workspaceId", access.workspaceId))
      .collect();
    let deletedTransactions = 0;
    for (const transaction of transactions) {
      if (transaction.importJobId !== job._id) continue;
      await ctx.db.delete(transaction._id);
      deletedTransactions += 1;
    }
    await ctx.db.patch(job._id, {
      status: "cancelled",
      appliedCount: 0,
      updatedAt: Date.now(),
    });
    return {
      ok: true as const,
      importId: job._id,
      deletedTransactions,
      deletedAccountId: null,
    };
  },
});

const normalizedImportRow = v.object({
  rowNumber: v.number(),
  externalId: v.optional(v.union(v.string(), v.null())),
  fingerprint: v.string(),
  date: v.string(),
  description: v.string(),
  amount: v.number(),
  category: v.string(),
  currency: v.string(),
});

export const importCsv = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    accountId: v.id("financeAccounts"),
    storageId: v.optional(v.id("_storage")),
    idempotencyKey: v.optional(v.string()),
    mapping: v.optional(mapping),
    source: v.optional(v.string()),
    balance: v.optional(v.union(v.number(), v.null())),
    transactions: v.optional(v.array(normalizedImportRow)),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    jobId: string;
    applied: number;
    skipped: number;
    imported?: number;
    skippedDuplicates?: number;
    accountId?: string;
    importId?: string;
    status?: string;
  }> => {
    if (args.transactions !== undefined) {
      const idempotencyKey =
        args.idempotencyKey ??
        [
          args.source ?? "csv",
          args.accountId,
          ...args.transactions.map((row) => row.fingerprint),
        ].join(":");
      const started = await ctx.runMutation(internal.financeImport.begin, {
        workspaceId: args.workspaceId,
        accountId: args.accountId,
        idempotencyKey,
      });
      if (started.completed) {
        return {
          jobId: started.jobId,
          applied: 0,
          skipped: 0,
          imported: 0,
          skippedDuplicates: 0,
          accountId: args.accountId,
          importId: started.jobId,
          status: "completed",
        };
      }
      let applied = 0;
      let skipped = 0;
      try {
        const rows = args.transactions.map((row) => ({
          rowNumber: row.rowNumber,
          postedAt: parseDate(row.date, row.rowNumber),
          description: row.description,
          amount: formatDecimal(parseDecimal(String(row.amount), `CSV row ${row.rowNumber} amount`)),
          currency: row.currency,
          categoryName: row.category.trim() || undefined,
        }));
        for (let offset = started.cursor; offset < rows.length; offset += 50) {
          const result = await ctx.runMutation(internal.financeImport.applyBatch, {
            jobId: started.jobId,
            rows: rows.slice(offset, offset + 50),
          });
          applied += result.applied;
          skipped += result.skipped;
        }
        await ctx.runMutation(internal.financeImport.finish, {
          jobId: started.jobId,
          totalRows: rows.length,
        });
        return {
          jobId: started.jobId,
          applied,
          skipped,
          imported: applied,
          skippedDuplicates: skipped,
          accountId: args.accountId,
          importId: started.jobId,
          status: "completed",
        };
      } catch (error) {
        await ctx.runMutation(internal.financeImport.fail, {
          jobId: started.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (
      args.storageId === undefined ||
      args.idempotencyKey === undefined ||
      args.mapping === undefined
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "CSV upload imports require storageId, idempotencyKey, and mapping",
      });
    }
    const mapping = args.mapping;
    const started = await ctx.runMutation(internal.financeImport.begin, {
      workspaceId: args.workspaceId,
      accountId: args.accountId,
      storageId: args.storageId,
      idempotencyKey: args.idempotencyKey,
      mapping,
    });
    if (started.completed) return { jobId: started.jobId, applied: 0, skipped: 0 };
    let applied = 0;
    let skipped = 0;
    try {
      const blob = await ctx.storage.get(args.storageId);
      if (blob === null) throw new Error("Uploaded CSV file was not found");
      if (blob.size > 20 * 1024 * 1024) throw new Error("CSV file exceeds 20 MiB");
      const parsed = parseCsv(await blob.text());
      if (parsed.length === 0) throw new Error("CSV file is empty");
      const headers = parsed[0].map((header, index) =>
        index === 0 ? header.replace(/^\uFEFF/, "") : header,
      );
      const dateIndex = columnIndex(headers, mapping.dateColumn, "Date");
      const descriptionIndex = columnIndex(
        headers,
        mapping.descriptionColumn,
        "Description",
      );
      const amountIndex = columnIndex(headers, mapping.amountColumn, "Amount");
      const currencyIndex = mapping.currencyColumn
        ? columnIndex(headers, mapping.currencyColumn, "Currency")
        : undefined;
      const categoryIndex = mapping.categoryColumn
        ? columnIndex(headers, mapping.categoryColumn, "Category")
        : undefined;
      if (parsed.length - 1 > 100_000) throw new Error("CSV has more than 100,000 rows");
      const rows = parsed.slice(1).map((values, index) => {
        const rowNumber = index + 1;
        const amount = parseDecimal(values[amountIndex] ?? "", `CSV row ${rowNumber} amount`);
        const description = (values[descriptionIndex] ?? "").trim();
        if (!description) throw new Error(`CSV row ${rowNumber} has no description`);
        return {
          rowNumber,
          postedAt: parseDate(values[dateIndex] ?? "", rowNumber),
          description,
          amount: formatDecimal(amount),
          currency: (
            currencyIndex === undefined
              ? mapping.defaultCurrency
              : values[currencyIndex] || mapping.defaultCurrency
          )
            .trim()
            .toUpperCase(),
          categoryName:
            categoryIndex === undefined
              ? undefined
              : values[categoryIndex]?.trim() || undefined,
        };
      });
      for (let offset = started.cursor; offset < rows.length; offset += 50) {
        const result = await ctx.runMutation(internal.financeImport.applyBatch, {
          jobId: started.jobId,
          rows: rows.slice(offset, offset + 50),
        });
        applied += result.applied;
        skipped += result.skipped;
      }
      await ctx.runMutation(internal.financeImport.finish, {
        jobId: started.jobId,
        storageId: args.storageId,
        totalRows: rows.length,
      });
      return { jobId: started.jobId, applied, skipped };
    } catch (error) {
      await ctx.runMutation(internal.financeImport.fail, {
        jobId: started.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});
