import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireWorkspace } from "./lib/auth";
import {
  addDecimal,
  formatDecimal,
  parseDecimal,
  type Decimal,
  zeroDecimal,
} from "./lib/decimal";

const source = v.union(
  v.literal("manual"),
  v.literal("agent"),
  v.literal("import"),
  v.literal("snaptrade"),
  v.literal("csv"),
);
const accountStatus = v.union(
  v.literal("active"),
  v.literal("hidden"),
  v.literal("closed"),
);

type DatabaseCtx = QueryCtx | MutationCtx;

function cleanRequired(value: string, label: string): string {
  const result = value.trim();
  if (!result) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} is required` });
  }
  return result;
}

function cleanOptional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function currency(value: string): string {
  const result = cleanRequired(value, "Currency").toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(result)) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Currency is invalid" });
  }
  return result;
}

async function ownedAccount(
  ctx: DatabaseCtx,
  id: Id<"financeAccounts">,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"financeAccounts">> {
  const account = await ctx.db.get(id);
  if (account === null || account.workspaceId !== workspaceId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Finance account not found" });
  }
  return account;
}

async function ownedCategory(
  ctx: DatabaseCtx,
  id: Id<"financeCategories">,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"financeCategories">> {
  const category = await ctx.db.get(id);
  if (category === null || category.workspaceId !== workspaceId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Finance category not found" });
  }
  return category;
}

function accountView(account: Doc<"financeAccounts">) {
  return {
    ...account,
    balance: account.balance === undefined ? undefined : formatDecimal(account.balance),
  };
}

function transactionView(transaction: Doc<"financeTransactions">) {
  return { ...transaction, amount: formatDecimal(transaction.amount) };
}

function positionView(position: Doc<"financePositions">) {
  return {
    ...position,
    quantity: formatDecimal(position.quantity),
    marketValue:
      position.marketValue === undefined
        ? undefined
        : formatDecimal(position.marketValue),
    averageCost:
      position.averageCost === undefined
        ? undefined
        : formatDecimal(position.averageCost),
  };
}

function activityView(activity: Doc<"financeActivities">) {
  return {
    ...activity,
    amount: activity.amount === undefined ? undefined : formatDecimal(activity.amount),
    quantity:
      activity.quantity === undefined ? undefined : formatDecimal(activity.quantity),
    price: activity.price === undefined ? undefined : formatDecimal(activity.price),
  };
}

export const listAccounts = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    includeClosed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const accounts = await ctx.db
      .query("financeAccounts")
      .withIndex("by_workspace_updated", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .order("desc")
      .collect();
    return accounts
      .filter((account) => args.includeClosed || account.status !== "closed")
      .map(accountView);
  },
});

export const saveAccount = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("financeAccounts")),
    source: v.optional(source),
    sourceId: v.optional(v.string()),
    sourceVariant: v.optional(v.string()),
    name: v.string(),
    institution: v.optional(v.string()),
    mask: v.optional(v.string()),
    type: v.string(),
    currency: v.string(),
    balance: v.optional(v.string()),
    clearBalance: v.optional(v.boolean()),
    status: v.optional(accountStatus),
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const inputSource = args.source ?? "manual";
    const sourceId = cleanOptional(args.sourceId);
    let accountId = args.id;
    if (accountId === undefined && sourceId !== undefined) {
      const existing = await ctx.db
        .query("financeAccounts")
        .withIndex("by_workspace_source_id", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("source", inputSource)
            .eq("sourceId", sourceId),
        )
        .unique();
      accountId = existing?._id;
    }
    const now = Date.now();
    const value = {
      sourceId,
      sourceVariant: cleanOptional(args.sourceVariant),
      name: cleanRequired(args.name, "Account name"),
      institution: cleanOptional(args.institution),
      mask: cleanOptional(args.mask),
      type: cleanRequired(args.type, "Account type"),
      currency: currency(args.currency),
      balance: args.clearBalance
        ? undefined
        : args.balance === undefined
          ? undefined
          : parseDecimal(args.balance, "Account balance"),
      observedAt: args.observedAt,
      updatedAt: now,
    };
    if (accountId === undefined) {
      return ctx.db.insert("financeAccounts", {
        workspaceId: access.workspaceId,
        source: inputSource,
        ...value,
        status: args.status ?? "active",
        createdAt: now,
      });
    }
    const account = await ownedAccount(ctx, accountId, access.workspaceId);
    await ctx.db.patch(account._id, {
      ...value,
      source: args.source ?? account.source,
      sourceId: sourceId ?? account.sourceId,
      sourceVariant: value.sourceVariant ?? account.sourceVariant,
      balance: args.clearBalance ? undefined : (value.balance ?? account.balance),
      observedAt: value.observedAt ?? account.observedAt,
      status: args.status ?? account.status,
    });
    return account._id;
  },
});

export const removeAccount = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    accountId: v.id("financeAccounts"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const account = await ownedAccount(ctx, args.accountId, access.workspaceId);
    const groups = await Promise.all([
      ctx.db.query("financeBalances").withIndex("by_account_currency", (q) => q.eq("accountId", account._id)).collect(),
      ctx.db.query("financeTransactions").withIndex("by_account_posted", (q) => q.eq("accountId", account._id)).collect(),
      ctx.db.query("financePositions").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect(),
      ctx.db.query("financeActivities").withIndex("by_account_occurred", (q) => q.eq("accountId", account._id)).collect(),
      ctx.db.query("financeAccountValueHistory").withIndex("by_account_date", (q) => q.eq("accountId", account._id)).collect(),
      ctx.db.query("financeAccountReturnRates").withIndex("by_account_timeframe", (q) => q.eq("accountId", account._id)).collect(),
      ctx.db.query("financeAccountLinks").withIndex("by_account", (q) => q.eq("accountId", account._id)).collect(),
      ctx.db.query("financeAccountLinks").withIndex("by_canonical", (q) => q.eq("canonicalAccountId", account._id)).collect(),
    ]);
    const deletedTransactions = groups[1].length;
    const ids = new Set(groups.flat().map((row) => row._id));
    for (const id of ids) await ctx.db.delete(id);
    await ctx.db.delete(account._id);
    return { ok: true as const, accountId: account._id, deletedTransactions };
  },
});

export const setAccountStatus = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("financeAccounts"),
    status: accountStatus,
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const account = await ownedAccount(ctx, args.id, access.workspaceId);
    await ctx.db.patch(account._id, { status: args.status, updatedAt: Date.now() });
    return account._id;
  },
});

export const listCategories = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    return ctx.db
      .query("financeCategories")
      .withIndex("by_workspace_name", (q) =>
        q.eq("workspaceId", access.workspaceId),
      )
      .collect();
  },
});

export const upsertCategory = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    name: v.string(),
    group: v.string(),
    excludeFromSpending: v.optional(v.boolean()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const name = cleanRequired(args.name, "Category name");
    const normalizedName = name.toLocaleLowerCase();
    const existing = await ctx.db
      .query("financeCategories")
      .withIndex("by_workspace_name", (q) =>
        q
          .eq("workspaceId", access.workspaceId)
          .eq("normalizedName", normalizedName),
      )
      .unique();
    const value = {
      name,
      normalizedName,
      group: cleanRequired(args.group, "Category group"),
      excludeFromSpending: args.excludeFromSpending ?? false,
      color: cleanOptional(args.color),
    };
    if (existing !== null) {
      await ctx.db.patch(existing._id, value);
      return existing._id;
    }
    return ctx.db.insert("financeCategories", {
      workspaceId: access.workspaceId,
      ...value,
    });
  },
});

export const listTransactions = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    accountId: v.optional(v.id("financeAccounts")),
    startAt: v.optional(v.number()),
    endAt: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.accountId !== undefined) {
      await ownedAccount(ctx, args.accountId, access.workspaceId);
    }
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 250), 1), 1000);
    const rows = args.accountId
      ? await ctx.db
          .query("financeTransactions")
          .withIndex("by_account_posted", (q) =>
            q.eq("accountId", args.accountId!),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("financeTransactions")
          .withIndex("by_workspace_posted", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(limit);
    return rows
      .filter(
        (row) =>
          (args.startAt === undefined || row.postedAt >= args.startAt) &&
          (args.endAt === undefined || row.postedAt < args.endAt),
      )
      .map(transactionView);
  },
});

export const saveTransaction = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("financeTransactions")),
    accountId: v.optional(v.id("financeAccounts")),
    source: v.optional(source),
    sourceId: v.optional(v.string()),
    dedupeKey: v.optional(v.string()),
    description: v.string(),
    amount: v.string(),
    currency: v.string(),
    postedAt: v.number(),
    categoryId: v.optional(v.id("financeCategories")),
    status: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    if (args.accountId !== undefined) {
      await ownedAccount(ctx, args.accountId, access.workspaceId);
    }
    if (args.categoryId !== undefined) {
      await ownedCategory(ctx, args.categoryId, access.workspaceId);
    }
    const inputSource = args.source ?? "manual";
    const amount = parseDecimal(args.amount, "Transaction amount");
    const description = cleanRequired(args.description, "Transaction description");
    const sourceId = cleanOptional(args.sourceId);
    const dedupeKey = cleanOptional(args.dedupeKey);
    const fingerprint = [
      inputSource,
      args.accountId ?? "unassigned",
      args.postedAt,
      formatDecimal(amount),
      currency(args.currency),
      description.toLocaleLowerCase(),
    ].join("|");
    let transactionId = args.id;
    if (transactionId === undefined && sourceId !== undefined) {
      transactionId = (
        await ctx.db
          .query("financeTransactions")
          .withIndex("by_workspace_source_id", (q) =>
            q
              .eq("workspaceId", access.workspaceId)
              .eq("source", inputSource)
              .eq("sourceId", sourceId),
          )
          .unique()
      )?._id;
    }
    if (transactionId === undefined && dedupeKey !== undefined) {
      transactionId = (
        await ctx.db
          .query("financeTransactions")
          .withIndex("by_workspace_dedupe", (q) =>
            q
              .eq("workspaceId", access.workspaceId)
              .eq("dedupeKey", dedupeKey),
          )
          .unique()
      )?._id;
    }
    const now = Date.now();
    const value = {
      accountId: args.accountId,
      sourceId,
      fingerprint,
      dedupeKey,
      description,
      amount,
      currency: currency(args.currency),
      postedAt: args.postedAt,
      categoryId: args.categoryId,
      status: cleanOptional(args.status) ?? "posted",
      notes: cleanOptional(args.notes),
      updatedAt: now,
    };
    if (transactionId === undefined) {
      return ctx.db.insert("financeTransactions", {
        workspaceId: access.workspaceId,
        source: inputSource,
        ...value,
        createdAt: now,
      });
    }
    const transaction = await ctx.db.get(transactionId);
    if (transaction === null || transaction.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Transaction not found" });
    }
    await ctx.db.patch(transaction._id, {
      ...value,
      source: args.source ?? transaction.source,
      accountId: args.accountId ?? transaction.accountId,
      sourceId: sourceId ?? transaction.sourceId,
      dedupeKey: dedupeKey ?? transaction.dedupeKey,
      categoryId: args.categoryId ?? transaction.categoryId,
    });
    return transaction._id;
  },
});

export const removeTransaction = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("financeTransactions"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const transaction = await ctx.db.get(args.id);
    if (transaction === null || transaction.workspaceId !== access.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Transaction not found" });
    }
    await ctx.db.delete(transaction._id);
    return transaction._id;
  },
});

export const linkAccount = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    accountId: v.id("financeAccounts"),
    canonicalAccountId: v.id("financeAccounts"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const [account] = await Promise.all([
      ownedAccount(ctx, args.accountId, access.workspaceId),
      ownedAccount(ctx, args.canonicalAccountId, access.workspaceId),
    ]);
    if (args.accountId === args.canonicalAccountId) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "An account cannot link to itself" });
    }
    const [existing, duplicateTransactions, canonicalTransactions] = await Promise.all([
      ctx.db
        .query("financeAccountLinks")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .unique(),
      ctx.db
        .query("financeTransactions")
        .withIndex("by_account_posted", (q) => q.eq("accountId", args.accountId))
        .collect(),
      ctx.db
        .query("financeTransactions")
        .withIndex("by_account_posted", (q) => q.eq("accountId", args.canonicalAccountId))
        .collect(),
    ]);
    const canonicalKeys = new Set(canonicalTransactions.map((row) => row.dedupeKey ?? row.fingerprint));
    let transactionsMerged = 0;
    let transactionsRekeyed = 0;
    for (const transaction of duplicateTransactions) {
      const key = transaction.dedupeKey ?? transaction.fingerprint;
      if (canonicalKeys.has(key)) {
        await ctx.db.delete(transaction._id);
        transactionsMerged += 1;
      } else {
        await ctx.db.patch(transaction._id, { accountId: args.canonicalAccountId });
        canonicalKeys.add(key);
        transactionsRekeyed += 1;
      }
    }
    const now = Date.now();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        canonicalAccountId: args.canonicalAccountId,
        method: "manual",
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("financeAccountLinks", {
        workspaceId: access.workspaceId,
        accountId: args.accountId,
        canonicalAccountId: args.canonicalAccountId,
        method: "manual",
        createdAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.patch(account._id, { status: "hidden", updatedAt: now });
    return {
      linked: true as const,
      canonicalAccountId: args.canonicalAccountId,
      duplicateAccountId: args.accountId,
      transactionsMerged,
      transactionsRekeyed,
    };
  },
});

export const unlinkAccount = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    accountId: v.id("financeAccounts"),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    await ownedAccount(ctx, args.accountId, access.workspaceId);
    const link = await ctx.db
      .query("financeAccountLinks")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (link !== null) await ctx.db.delete(link._id);
    return args.accountId;
  },
});

export const dashboard = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    activityStartAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const accounts = (
      await ctx.db
        .query("financeAccounts")
        .withIndex("by_workspace_updated", (q) =>
          q.eq("workspaceId", access.workspaceId),
        )
        .order("desc")
        .collect()
    ).filter((account) => account.status !== "closed");
    const [transactions, activities, histories, imports, categories, links] =
      await Promise.all([
        ctx.db
          .query("financeTransactions")
          .withIndex("by_workspace_posted", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(500),
        ctx.db
          .query("financeActivities")
          .withIndex("by_workspace_occurred", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(500),
        ctx.db
          .query("financeAccountValueHistory")
          .withIndex("by_workspace_date", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(1000),
        ctx.db
          .query("financeImportJobs")
          .withIndex("by_workspace_created", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .order("desc")
          .take(50),
        ctx.db
          .query("financeCategories")
          .withIndex("by_workspace_name", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .collect(),
        ctx.db
          .query("financeAccountLinks")
          .withIndex("by_workspace", (q) =>
            q.eq("workspaceId", access.workspaceId),
          )
          .collect(),
      ]);
    const positions = (
      await Promise.all(
        accounts.map((account) =>
          ctx.db
            .query("financePositions")
            .withIndex("by_account", (q) => q.eq("accountId", account._id))
            .collect(),
        ),
      )
    ).flat();
    const balances = (
      await Promise.all(
        accounts.map((account) =>
          ctx.db
            .query("financeBalances")
            .withIndex("by_account_currency", (q) =>
              q.eq("accountId", account._id),
            )
            .collect(),
        ),
      )
    ).flat();
    const returns = (
      await Promise.all(
        accounts.map((account) =>
          ctx.db
            .query("financeAccountReturnRates")
            .withIndex("by_account_timeframe", (q) =>
              q.eq("accountId", account._id),
            )
            .collect(),
        ),
      )
    ).flat();

    const totals = new Map<string, Decimal>();
    for (const account of accounts) {
      if (account.balance === undefined || account.status === "hidden") continue;
      totals.set(
        account.currency,
        addDecimal(totals.get(account.currency) ?? zeroDecimal(), account.balance),
      );
    }
    return {
      accounts: accounts.map(accountView),
      balances: balances.map((balance) => ({
        ...balance,
        cash: balance.cash === undefined ? undefined : formatDecimal(balance.cash),
        buyingPower:
          balance.buyingPower === undefined
            ? undefined
            : formatDecimal(balance.buyingPower),
      })),
      positions: positions.map(positionView),
      transactions: transactions.map(transactionView),
      activities: activities
        .filter(
          (activity) =>
            args.activityStartAt === undefined ||
            activity.occurredAt >= args.activityStartAt,
        )
        .map(activityView),
      valueHistory: histories.map((entry) => ({
        ...entry,
        equity: formatDecimal(entry.equity),
        cash: entry.cash === undefined ? undefined : formatDecimal(entry.cash),
      })),
      returnRates: returns,
      imports,
      categories,
      links,
      totalsByCurrency: [...totals.entries()].map(([code, value]) => ({
        currency: code,
        balance: formatDecimal(value),
      })),
    };
  },
});
