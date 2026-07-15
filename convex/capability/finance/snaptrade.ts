"use node";

import { createHash, createHmac } from "node:crypto";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { action, type ActionCtx, internalAction } from "../../_generated/server";
import { decryptCredentials, encryptCredentials } from "../../platform/auth/credentials";
type SnapTradeConnection = Extract<
  Doc<"providerConnections">,
  { provider: "snaptrade" }
>;

const baseUrl = "https://api.snaptrade.com";
const apiPrefix = "/api/v1";

type Credentials = { clientId: string; consumerKey: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decimal(value: unknown): string | undefined {
  if (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function timestamp(value: unknown): number | undefined {
  const parsed = Date.parse(text(value) ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function currency(value: unknown, fallback?: string): string | undefined {
  const direct = text(value)?.toUpperCase();
  return direct && /^[A-Z0-9]{2,12}$/.test(direct) ? direct : fallback;
}

function jsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return jsonString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${fields.map(([name, field]) => `${jsonString(name)}:${canonicalJson(field)}`).join(",")}}`;
  }
  return "null";
}

async function request(
  credentials: Credentials,
  method: "GET" | "POST",
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  const fullPath = `${apiPrefix}${path}`;
  const params = new URLSearchParams({
    clientId: credentials.clientId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  for (const [name, value] of Object.entries(options.query ?? {})) {
    params.set(name, value);
  }
  const query = params.toString();
  const content = options.body ?? null;
  const signature = createHmac("sha256", credentials.consumerKey)
    .update(canonicalJson({ content, path: fullPath, query }), "utf8")
    .digest("base64");
  const headers: Record<string, string> = {
    Accept: "application/json",
    Signature: signature,
  };
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = canonicalJson(options.body);
  }
  const response = await fetch(`${baseUrl}${fullPath}?${query}`, init);
  const responseText = await response.text();
  const payload = responseText ? (JSON.parse(responseText) as unknown) : null;
  if (!response.ok) {
    throw new Error(`SnapTrade request failed (${response.status}): ${responseText.slice(0, 300)}`);
  }
  return payload;
}

function credentials(value: Record<string, string>): Credentials {
  if (!value.clientId || !value.consumerKey) {
    throw new Error("SnapTrade credentials are missing");
  }
  return { clientId: value.clientId, consumerKey: value.consumerKey };
}

function accountType(account: Record<string, unknown>): string {
  const category = text(account.account_category)?.toUpperCase();
  if (category === "DEPOSIT") return "checking";
  if (category === "LOC") return "credit";
  if (category === "INVESTMENT") return "investment";
  const hint = `${text(account.raw_type) ?? ""} ${text(account.name) ?? ""}`.toUpperCase();
  if (/\b(SAVINGS?|HISA)\b/.test(hint)) return "savings";
  if (/\b(MSB|CHEQUING|CHECKING)\b/.test(hint)) return "checking";
  if (/\bCRYPTO\b/.test(hint)) return "crypto";
  return "investment";
}

function parseAccount(value: unknown, observedAt: number) {
  const account = record(value);
  const sourceId = text(account?.id);
  const total = record(record(account?.balance)?.total);
  const code = currency(total?.currency);
  if (!account || !sourceId || !code) return undefined;
  return {
    sourceId,
    name: text(account.name) ?? text(account.institution_name) ?? "SnapTrade account",
    institution: text(account.institution_name),
    type: accountType(account),
    currency: code,
    balance: decimal(total?.amount),
    observedAt,
  };
}

function parseBalance(value: unknown, fallback: string, observedAt: number) {
  const balance = record(value);
  if (!balance) return undefined;
  const code = currency(record(balance.currency)?.code, fallback);
  if (!code) return undefined;
  return {
    currency: code,
    cash: decimal(balance.cash),
    buyingPower: decimal(balance.buying_power),
    observedAt,
  };
}

function decimalProduct(left: string | undefined, right: string | undefined) {
  if (!left || !right) return undefined;
  const parse = (value: string) => {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) return undefined;
    const scale = match[3]?.length ?? 0;
    let units = BigInt(`${match[2]}${match[3] ?? ""}`);
    if (match[1] === "-") units = -units;
    return { units, scale };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  const scale = a.scale + b.scale;
  const negative = a.units * b.units < 0n;
  let digits = (negative ? -(a.units * b.units) : a.units * b.units).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  }
  return negative ? `-${digits}` : digits;
}

function parsePosition(value: unknown, fallback: string, observedAt: number) {
  const position = record(value);
  const instrument = record(position?.instrument);
  const symbol = text(instrument?.symbol);
  const quantity = decimal(position?.units);
  const code = currency(instrument?.currency, currency(position?.currency, fallback));
  if (!position || !symbol || !quantity || !code) return undefined;
  const price = decimal(position.price);
  return {
    sourceId: text(instrument?.id),
    symbol,
    name: text(instrument?.description),
    quantity,
    marketValue: decimal(position.market_value) ?? decimalProduct(quantity, price),
    averageCost: decimal(position.cost_basis),
    currency: code,
    observedAt,
  };
}

function parseActivity(value: unknown, fallback: string) {
  const activity = record(value);
  if (!activity) return undefined;
  const occurredAt = timestamp(activity.trade_date) ?? timestamp(activity.settlement_date);
  const code = currency(
    record(activity.currency)?.code ?? activity.currency,
    fallback,
  );
  if (occurredAt === undefined || !code) return undefined;
  const sourceId = text(activity.id);
  const fingerprint =
    sourceId ??
    createHash("sha256")
      .update(canonicalJson(activity), "utf8")
      .digest("hex");
  const symbol =
    text(record(activity.symbol)?.symbol) ??
    text(record(activity.option_symbol)?.ticker) ??
    text(activity.symbol);
  return {
    sourceId,
    fingerprint,
    type: text(activity.type)?.toLowerCase() ?? "other",
    description: text(activity.description),
    amount: decimal(activity.amount),
    currency: code,
    symbol,
    quantity: decimal(activity.units),
    price: decimal(activity.price),
    status: text(activity.status)?.toLowerCase() ?? "posted",
    occurredAt,
    settledAt: timestamp(activity.settlement_date),
  };
}

function parseHistory(value: unknown, fallback: string, observedAt: number) {
  const point = record(value);
  const dateValue = text(point?.date) ?? text(point?.timestamp);
  const equity = decimal(point?.equity) ?? decimal(point?.value) ?? decimal(point?.total);
  if (!point || !dateValue || !equity) return undefined;
  const parsed = timestamp(dateValue);
  if (parsed === undefined) return undefined;
  return {
    date: new Date(parsed).toISOString().slice(0, 10),
    equity,
    cash: decimal(point.cash),
    currency: currency(point.currency, fallback) ?? fallback,
    observedAt,
  };
}

function parseReturnRates(value: unknown, observedAt: number) {
  const payload = record(value);
  if (!payload) return [];
  const source = record(payload.returnRates) ?? record(payload.return_rates) ?? payload;
  return Object.entries(source).flatMap(([timeframe, raw]) => {
    const percentage = typeof raw === "number" ? raw : Number(decimal(raw));
    return Number.isFinite(percentage)
      ? [{ timeframe, returnPercent: percentage, observedAt }]
      : [];
  });
}

export const settings = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args): Promise<{
    connected: boolean;
    hasClientId: boolean;
    hasConsumerKey: boolean;
    lastCheckedAt: string | null;
    secretProvider: string | null;
  }> => {
    const connection = (await ctx.runQuery(internal.capability.integration.connection, {
      workspaceId: args.workspaceId,
      provider: "snaptrade",
    })) as SnapTradeConnection | null;
    const credentials = connection?.credentials
      ? decryptCredentials(connection.credentials)
      : {};
    return {
      connected: connection?.status === "connected",
      hasClientId: Boolean(credentials.clientId),
      hasConsumerKey: Boolean(credentials.consumerKey),
      lastCheckedAt: connection?.updatedAt
        ? new Date(connection.updatedAt).toISOString()
        : null,
      secretProvider: connection?.credentials ? "convex" : null,
    };
  },
});

export const saveSettings = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    clientId: v.string(),
    consumerKey: v.string(),
  },
  handler: async (ctx, args) => {
    const clientId = args.clientId.trim();
    const consumerKey = args.consumerKey.trim();
    if (!clientId || !consumerKey) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "SnapTrade client ID and consumer key are required",
      });
    }
    await ctx.runMutation(internal.capability.integration.saveSnapTradeCredentials, {
      workspaceId: args.workspaceId,
      credentials: encryptCredentials({ clientId, consumerKey }),
    });
    return { connected: true };
  },
});

export const createConnectionPortal = action({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    broker: v.optional(v.string()),
    customRedirect: v.optional(v.string()),
    reconnect: v.optional(v.string()),
    immediateRedirect: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.runQuery(internal.capability.integration.connection, {
      workspaceId: args.workspaceId,
      provider: "snaptrade",
    });
    if (connection?.provider !== "snaptrade" || connection.credentials === undefined) {
      throw new ConvexError({ code: "NOT_CONNECTED", message: "SnapTrade is not connected" });
    }
    const body: Record<string, unknown> = {
      connectionType: "read",
      showCloseButton: true,
      connectionPortalVersion: "v4",
    };
    if (args.broker?.trim()) body.broker = args.broker.trim();
    if (args.customRedirect?.trim()) {
      const redirect = new URL(args.customRedirect);
      if (redirect.protocol !== "https:" && redirect.protocol !== "http:") {
        throw new ConvexError({ code: "INVALID_INPUT", message: "Redirect URL is invalid" });
      }
      body.customRedirect = redirect.toString();
    }
    if (args.reconnect?.trim()) body.reconnect = args.reconnect.trim();
    if (args.immediateRedirect !== undefined) body.immediateRedirect = args.immediateRedirect;
    const payload = record(
      await request(
        credentials(decryptCredentials(connection.credentials)),
        "POST",
        "/snapTrade/login",
        { body },
      ),
    );
    const redirectUri = text(payload?.redirectURI);
    if (!redirectUri) throw new Error("SnapTrade returned no connection portal URL");
    return { redirectUri, sessionId: text(payload?.sessionId) };
  },
});


type SnapTradeStepResult = {
  done: boolean;
  cursor?: string;
  fetched: number;
  applied: number;
  skipped: number;
  counts: {
    accounts: number;
    balances: number;
    positions: number;
    activities: number;
    history: number;
    returnRates: number;
  };
};

async function applyBatches(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  accountId: Id<"financeAccounts">,
  data: {
    balances: Array<NonNullable<ReturnType<typeof parseBalance>>>;
    positions: Array<NonNullable<ReturnType<typeof parsePosition>>>;
    activities: Array<NonNullable<ReturnType<typeof parseActivity>>>;
    history: Array<NonNullable<ReturnType<typeof parseHistory>>>;
    returnRates: ReturnType<typeof parseReturnRates>;
  },
): Promise<number> {
  let applied = 0;
  for (let offset = 0; offset < data.balances.length; offset += 100) {
    const result = await ctx.runMutation(
      internal.capability.integration.applySnapTradeAccountData,
      {
        workspaceId,
        system: true,
        accountId,
        balances: data.balances.slice(offset, offset + 100),
        positions: [],
        activities: [],
        history: [],
        returnRates: [],
      },
    );
    applied += result.balances;
  }
  for (let offset = 0; offset < data.positions.length; offset += 100) {
    const result = await ctx.runMutation(
      internal.capability.integration.applySnapTradeAccountData,
      {
        workspaceId,
        system: true,
        accountId,
        balances: [],
        positions: data.positions.slice(offset, offset + 100),
        activities: [],
        history: [],
        returnRates: [],
      },
    );
    applied += result.positions;
  }
  for (let offset = 0; offset < data.activities.length; offset += 100) {
    const result = await ctx.runMutation(
      internal.capability.integration.applySnapTradeAccountData,
      {
        workspaceId,
        system: true,
        accountId,
        balances: [],
        positions: [],
        activities: data.activities.slice(offset, offset + 100),
        history: [],
        returnRates: [],
      },
    );
    applied += result.activities;
  }
  for (let offset = 0; offset < data.history.length; offset += 100) {
    const result = await ctx.runMutation(
      internal.capability.integration.applySnapTradeAccountData,
      {
        workspaceId,
        system: true,
        accountId,
        balances: [],
        positions: [],
        activities: [],
        history: data.history.slice(offset, offset + 100),
        returnRates: [],
      },
    );
    applied += result.history;
  }
  for (let offset = 0; offset < data.returnRates.length; offset += 100) {
    const result = await ctx.runMutation(
      internal.capability.integration.applySnapTradeAccountData,
      {
        workspaceId,
        system: true,
        accountId,
        balances: [],
        positions: [],
        activities: [],
        history: [],
        returnRates: data.returnRates.slice(offset, offset + 100),
      },
    );
    applied += result.returnRates;
  }
  return applied;
}

async function syncScheduledPage(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  cursor?: string,
): Promise<SnapTradeStepResult> {
  const connection = await ctx.runQuery(
    internal.capability.integration.connectionByWorkspace,
    { workspaceId, provider: "snaptrade" },
  );
  if (connection?.provider !== "snaptrade" || connection.credentials === undefined) {
    throw new ConvexError({ code: "NOT_CONNECTED", message: "SnapTrade is not connected" });
  }
  const auth = credentials(decryptCredentials(connection.credentials));
  const state = cursor
    ? (JSON.parse(cursor) as {
        phase: "account";
        accountSourceIds: string[];
        accountIndex: number;
        activityOffset: number;
      })
    : undefined;
  const observedAt = Date.now();
  if (state === undefined) {
    const raw = await request(auth, "GET", "/accounts");
    const values = Array.isArray(raw) ? raw : [];
    const accounts = values.flatMap((value) => parseAccount(value, observedAt) ?? []);
    const ids: Array<{
      sourceId: string;
      accountId: Id<"financeAccounts">;
    }> = await ctx.runMutation(
      internal.capability.integration.upsertSnapTradeAccounts,
      {
        workspaceId,
        system: true,
        accounts,
      },
    );
    return {
      done: accounts.length === 0,
      cursor: ids.length
        ? JSON.stringify({
            phase: "account",
            accountSourceIds: ids.map((account) => account.sourceId),
            accountIndex: 0,
            activityOffset: 0,
          })
        : undefined,
      fetched: values.length,
      applied: ids.length,
      skipped: values.length - accounts.length,
      counts: {
        accounts: accounts.length,
        balances: 0,
        positions: 0,
        activities: 0,
        history: 0,
        returnRates: 0,
      },
    };
  }
  const accounts: Array<{
    sourceId: string;
    accountId: Id<"financeAccounts">;
    currency: string;
  }> = await ctx.runQuery(internal.capability.integration.snapTradeAccounts, {
    workspaceId,
  });
  const sourceId = state.accountSourceIds[state.accountIndex];
  const account = accounts.find((candidate) => candidate.sourceId === sourceId);
  if (account === undefined) {
    const accountIndex = state.accountIndex + 1;
    return {
      done: accountIndex >= state.accountSourceIds.length,
      cursor:
        accountIndex >= state.accountSourceIds.length
          ? undefined
          : JSON.stringify({ ...state, accountIndex, activityOffset: 0 }),
      fetched: 0,
      applied: 0,
      skipped: 1,
      counts: {
        accounts: 0,
        balances: 0,
        positions: 0,
        activities: 0,
        history: 0,
        returnRates: 0,
      },
    };
  }
  const encodedId = encodeURIComponent(account.sourceId);
  const activityPayload = record(
    await request(auth, "GET", `/accounts/${encodedId}/activities`, {
      query: { offset: String(state.activityOffset), limit: "100" },
    }),
  );
  const activityValues = Array.isArray(activityPayload?.data) ? activityPayload.data : [];
  const activities = activityValues.flatMap(
    (value) => parseActivity(value, account.currency) ?? [],
  );
  let balances: Array<NonNullable<ReturnType<typeof parseBalance>>> = [];
  let positions: Array<NonNullable<ReturnType<typeof parsePosition>>> = [];
  let history: Array<NonNullable<ReturnType<typeof parseHistory>>> = [];
  let returnRates: ReturnType<typeof parseReturnRates> = [];
  let fetched = activityValues.length;
  let skipped = activityValues.length - activities.length;
  if (state.activityOffset === 0) {
    const [rawBalances, rawPositions] = await Promise.all([
      request(auth, "GET", `/accounts/${encodedId}/balances`),
      request(auth, "GET", `/accounts/${encodedId}/positions/all`),
    ]);
    const balanceValues = Array.isArray(rawBalances) ? rawBalances : [];
    balances = balanceValues.flatMap(
      (value) => parseBalance(value, account.currency, observedAt) ?? [],
    );
    const positionValues = record(rawPositions)?.results;
    const rawPositionValues = Array.isArray(positionValues) ? positionValues : [];
    positions = rawPositionValues.flatMap(
      (value) => parsePosition(value, account.currency, observedAt) ?? [],
    );
    fetched += balanceValues.length + rawPositionValues.length;
    skipped +=
      balanceValues.length -
      balances.length +
      rawPositionValues.length -
      positions.length;
    try {
      const payload = await request(auth, "GET", `/accounts/${encodedId}/balanceHistory`);
      const payloadRecord = record(payload);
      const values: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payloadRecord?.balances)
          ? payloadRecord.balances
          : [];
      history = values.flatMap(
        (value) => parseHistory(value, account.currency, observedAt) ?? [],
      );
      fetched += values.length;
      skipped += values.length - history.length;
    } catch (error) {
      if (!String(error).includes("(403)") && !String(error).includes("(404)")) throw error;
    }
    try {
      returnRates = parseReturnRates(
        await request(auth, "GET", `/accounts/${encodedId}/returnRates`),
        observedAt,
      );
      fetched += returnRates.length;
    } catch (error) {
      if (!String(error).includes("(403)") && !String(error).includes("(404)")) throw error;
    }
  }
  const applied = await applyBatches(ctx, workspaceId, account.accountId, {
    balances,
    positions,
    activities,
    history,
    returnRates,
  });
  const total = record(activityPayload?.pagination)?.total;
  const hasMoreActivities =
    activityValues.length === 100 &&
    (typeof total !== "number" || state.activityOffset + activityValues.length < total);
  const next = hasMoreActivities
    ? {
        ...state,
        activityOffset: state.activityOffset + activityValues.length,
      }
    : {
        ...state,
        accountIndex: state.accountIndex + 1,
        activityOffset: 0,
      };
  return {
    done:
      !hasMoreActivities &&
      next.accountIndex >= state.accountSourceIds.length,
    cursor:
      !hasMoreActivities &&
      next.accountIndex >= state.accountSourceIds.length
        ? undefined
        : JSON.stringify(next),
    fetched,
    applied,
    skipped,
    counts: {
      accounts: 0,
      balances: balances.length,
      positions: positions.length,
      activities: activities.length,
      history: history.length,
      returnRates: returnRates.length,
    },
  };
}

export const syncNow = action({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    const workspaceId: Id<"workspaces"> = await ctx.runQuery(
      internal.capability.integration.authorizeWorkspace,
      { workspaceId: args.workspaceId },
    );
    let cursor: string | undefined;
    let totals = {
      accounts: 0,
      balances: 0,
      positions: 0,
      activities: 0,
      history: 0,
      returnRates: 0,
      skipped: 0,
    };
    let completed = false;
    for (let page = 0; page < 1_000; page += 1) {
      const result = await syncScheduledPage(ctx, workspaceId, cursor);
      totals = {
        accounts: totals.accounts + result.counts.accounts,
        balances: totals.balances + result.counts.balances,
        positions: totals.positions + result.counts.positions,
        activities: totals.activities + result.counts.activities,
        history: totals.history + result.counts.history,
        returnRates: totals.returnRates + result.counts.returnRates,
        skipped: totals.skipped + result.skipped,
      };
      if (result.done) {
        completed = true;
        break;
      }
      cursor = result.cursor;
    }
    if (!completed) throw new Error("SnapTrade sync exceeded its page limit");
    await ctx.runMutation(
      internal.capability.integration.jobs.publishProviderSyncCompletion,
      { workspaceId, provider: "snaptrade" },
    );
    return {
      ok: true as const,
      accounts: totals.accounts,
      balances: totals.balances,
      positions: totals.positions,
      activities: totals.activities,
      activitiesInserted: 0,
      activitiesSkipped: totals.skipped,
      historyPoints: totals.history,
      returnRates: totals.returnRates,
      warnings: totals.activities
        ? ["SnapTrade activities were upserted; new-versus-updated counts are unavailable"]
        : [],
    };
  },
});

export const syncScheduledStep = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    cursor: v.optional(v.string()),
  },
  handler: (ctx, args): Promise<SnapTradeStepResult> =>
    syncScheduledPage(ctx, args.workspaceId, args.cursor),
});
