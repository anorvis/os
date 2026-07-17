// Gateway-only overview aggregation. This module reads SQLite performance
// databases through bun:sqlite and MUST NOT be imported from Node hosts;
// Node-safe ticket and telemetry APIs live in "./index".
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getHomeDir } from "../../paths";
import {
  listMaintenanceTickets,
  resolveSessionRoots,
  scanMaintainerUsage,
  scanMaintenanceUsage,
  type MaintenanceModelPerformance,
  type MaintenanceModelUsage,
  type MaintenanceOptions,
  type MaintenanceOverview,
  type MaintenancePerformance,
  type MaintenanceSessionRoots,
  type MaintenanceUsageScope,
  type MaintenanceUsageTotals,
} from "./index";

export function getMaintenanceOverview(options: MaintenanceOptions = {}): MaintenanceOverview {
  const sessionScope = options.sessionScope ?? "foreground";
  const includeUsage = options.includeUsage ?? true;
  const recordedUsage = !includeUsage
    ? []
    : sessionScope === "maintainer"
      ? scanMaintainerUsage(options)
      : scanMaintenanceUsage(options);
  const clock =
    (typeof options.now === "function" ? options.now() : options.now) ??
    new Date();
  const usageSince =
    sessionScope === "maintainer"
      ? new Date(
          Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1),
        ).toISOString()
      : null;
  const usage = usageSince
    ? recordedUsage.filter((row) => row.lastSeenAt >= usageSince)
    : recordedUsage;
  const totals: MaintenanceUsageTotals = {
    sessions: usage.length,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    usdCost: 0,
    outputLimitWarningCount: 0,
  };
  const byModel = new Map<string, MaintenanceModelUsage>();
  for (const row of usage) {
    totals.messageCount += row.messageCount;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadTokens += row.cacheReadTokens;
    totals.cacheWriteTokens += row.cacheWriteTokens;
    totals.cacheTokens += row.cacheTokens;
    totals.totalTokens += row.totalTokens;
    totals.usdCost += row.usdCost;
    totals.outputLimitWarningCount += row.outputLimitWarningCount;
    const key = `${row.provider}\u0000${row.model}`;
    const aggregate = byModel.get(key) ?? {
      provider: row.provider,
      model: row.model,
      sessions: 0,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      usdCost: 0,
      outputLimitWarningCount: 0,
    };
    aggregate.sessions++;
    aggregate.messageCount += row.messageCount;
    aggregate.inputTokens += row.inputTokens;
    aggregate.outputTokens += row.outputTokens;
    aggregate.cacheReadTokens += row.cacheReadTokens;
    aggregate.cacheWriteTokens += row.cacheWriteTokens;
    aggregate.cacheTokens += row.cacheTokens;
    aggregate.totalTokens += row.totalTokens;
    aggregate.usdCost += row.usdCost;
    aggregate.outputLimitWarningCount += row.outputLimitWarningCount;
    byModel.set(key, aggregate);
  }
  const allTickets = listMaintenanceTickets(options);
  const filteredTickets = options.ticketStatuses?.length
    ? allTickets.filter((ticket) => options.ticketStatuses!.includes(ticket.status))
    : allTickets;
  const paginated = options.limit !== undefined || options.offset !== undefined || options.ticketStatuses !== undefined;
  const offset = paginated ? Math.max(0, Math.trunc(options.offset ?? 0)) : 0;
  const limit = paginated ? Math.min(100, Math.max(0, Math.trunc(options.limit ?? 20))) : undefined;
  const tickets = limit === undefined ? filteredTickets : filteredTickets.slice(offset, offset + limit);
  const sessionPaginated = options.sessionLimit !== undefined || options.sessionOffset !== undefined;
  const sessionOffset = sessionPaginated ? Math.max(0, Math.trunc(options.sessionOffset ?? 0)) : 0;
  const sessionLimit = sessionPaginated ? Math.min(100, Math.max(0, Math.trunc(options.sessionLimit ?? 20))) : undefined;
  const recent = sessionLimit === undefined ? usage.slice(0, 25) : usage.slice(sessionOffset, sessionOffset + sessionLimit);
  return {
    scope: sessionScope,
    usagePeriod: sessionScope === "maintainer" ? "current_month" : "all",
    usageSince,
    usage: {
      totals,
      recent,
      byModel: [...byModel.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)),
    },
    performance: includeUsage
      ? loadModelPerformance(options.maintainerModelPerfPath, sessionScope, options.foregroundStatsPath, options.sessionRoots)
      : emptyPerformance(),
    tickets,
    ...(paginated ? { total: filteredTickets.length } : {}),
    ...(sessionPaginated ? { usageTotal: usage.length } : {}),
  };
}

type ModelPerfRow = {
  model_key: unknown;
  samples: unknown;
  output_tokens: unknown;
  gen_ms: unknown;
  ttft_samples: unknown;
  ttft_ms: unknown;
  updated_at: unknown;
};

type PerformanceAccumulator = {
  modelKey: string;
  samples: number;
  outputTokens: number;
  generationMs: number;
  ttftSamples: number;
  ttftMs: number;
  updatedAt: string;
};

function emptyPerformance(): MaintenancePerformance {
  return {
    totals: {
      samples: 0,
      outputTokens: 0,
      generationMs: 0,
      tokensPerSecond: 0,
      timeToFirstTokenMs: 0,
    },
    byModel: [],
  };
}

function loadModelPerformance(
  maintainerModelPerfPath: string | undefined,
  sessionScope: MaintenanceUsageScope,
  foregroundStatsPath: string | undefined,
  sessionRoots: MaintenanceSessionRoots | undefined,
): MaintenancePerformance {
  if (sessionScope === "foreground") {
    return loadForegroundStatsPerformance(foregroundStatsPath, sessionRoots);
  }
  const path = maintainerModelPerfPath?.trim()
    || process.env.ANORVIS_MAINTAINER_AGENT_DB?.trim()
    || join(getHomeDir(), ".anorvis", "sandbox", "agent", "agent.db");
  return loadModelPerfDatabase(path);
}

function loadForegroundStatsPerformance(
  statsPath: string | undefined,
  sessionRoots: MaintenanceSessionRoots | undefined,
): MaintenancePerformance {
  let database: Database | undefined;
  try {
    const path = statsPath?.trim()
      || process.env.ANORVIS_OMP_STATS_DB?.trim()
      || join(getHomeDir(), ".omp", "stats.db");
    if (!existsSync(path)) return emptyPerformance();
    const roots = resolveSessionRoots(sessionRoots).filter((root) => root.host === "omp");
    if (roots.length === 0) return emptyPerformance();
    database = new Database(path, { readonly: true });
    const columns = new Set(
      database
        .query<{ name: unknown }, []>("PRAGMA table_info(messages)")
        .all()
        .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
    );
    const sessionFileColumn = firstAvailableColumn(columns, [
      "session_file",
      "sessionFile",
    ]);
    if (!sessionFileColumn) return emptyPerformance();
    const normalizedSessionFile = `replace(${sqlIdentifier(sessionFileColumn)}, '\\', '/')`;
    const conditions: string[] = [];
    const parameters: string[] = [];
    for (const root of roots) {
      const normalizedRoot = root.path.replace(/\\/g, "/").replace(/\/+$/, "");
      conditions.push(
        `(${normalizedSessionFile} = ? OR ${normalizedSessionFile} LIKE ? ESCAPE '!')`,
      );
      parameters.push(normalizedRoot, `${escapeSqlLike(normalizedRoot)}/%`);
    }
    const projection = [
      sqlProjection(columns, ["session_file", "sessionFile"], "session_file"),
      sqlProjection(columns, ["provider"], "provider"),
      sqlProjection(columns, ["model_key", "modelKey", "model"], "model"),
      sqlProjection(
        columns,
        ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
        "output_tokens",
      ),
      sqlProjection(
        columns,
        ["duration_ms", "durationMs", "duration"],
        "duration_ms",
      ),
      sqlProjection(
        columns,
        ["ttft_ms", "ttftMs", "time_to_first_token_ms", "timeToFirstTokenMs"],
        "ttft_ms",
      ),
      sqlProjection(
        columns,
        ["timestamp", "created_at", "createdAt", "updated_at", "updatedAt"],
        "timestamp",
      ),
    ].join(", ");
    const rows = database
      .query<Record<string, unknown>, string[]>(
        `SELECT ${projection} FROM messages WHERE ${conditions.join(" OR ")}`,
      )
      .all(...parameters);
    const byModel = new Map<string, PerformanceAccumulator>();
    for (const row of rows) {
      const sessionFile = firstString(row, ["session_file", "sessionFile"]);
      if (!sessionFile || !roots.some((root) => isPathWithin(root.path, sessionFile))) continue;
      const outputTokens = nonnegativeNumber(firstValue(row, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"])) ?? 0;
      const durationMs = nonnegativeNumber(firstValue(row, ["duration_ms", "durationMs", "duration"]));
      const ttftMs = nonnegativeNumber(firstValue(row, ["ttft_ms", "ttftMs", "time_to_first_token_ms", "timeToFirstTokenMs"]));
      const model = firstString(row, ["model_key", "modelKey", "model"]) || "unknown";
      const provider = firstString(row, ["provider"]);
      const modelKey = provider && !model.includes("/") ? `${provider}/${model}` : model;
      const updatedAt = performanceUpdatedAt(firstValue(row, ["timestamp", "created_at", "createdAt", "updated_at", "updatedAt"]));
      if (durationMs === undefined && ttftMs === undefined) continue;
      const current = byModel.get(modelKey) ?? {
        modelKey,
        samples: 0,
        outputTokens: 0,
        generationMs: 0,
        ttftSamples: 0,
        ttftMs: 0,
        updatedAt,
      };
      if (durationMs !== undefined) {
        current.samples += 1;
        current.outputTokens += outputTokens;
        current.generationMs += Math.max(durationMs - (ttftMs ?? 0), 0);
      }
      if (ttftMs !== undefined) {
        current.ttftSamples += 1;
        current.ttftMs += ttftMs;
      }
      if (updatedAt > current.updatedAt) current.updatedAt = updatedAt;
      byModel.set(modelKey, current);
    }
    const modelRows = [...byModel.values()]
      .map(toModelPerformance)
      .sort((a, b) => a.modelKey.localeCompare(b.modelKey));
    const totals = [...byModel.values()].reduce(
      (total, row) => ({
        samples: total.samples + row.samples,
        outputTokens: total.outputTokens + row.outputTokens,
        generationMs: total.generationMs + row.generationMs,
        ttftSamples: total.ttftSamples + row.ttftSamples,
        ttftMs: total.ttftMs + row.ttftMs,
      }),
      { samples: 0, outputTokens: 0, generationMs: 0, ttftSamples: 0, ttftMs: 0 },
    );
    return {
      totals: {
        samples: totals.samples,
        outputTokens: totals.outputTokens,
        generationMs: totals.generationMs,
        tokensPerSecond: ratePerSecond(totals.outputTokens, totals.generationMs),
        timeToFirstTokenMs: average(totals.ttftMs, totals.ttftSamples),
      },
      byModel: modelRows,
    };
  } catch {
    return emptyPerformance();
  } finally {
    database?.close();
  }
}

function firstAvailableColumn(
  columns: ReadonlySet<string>,
  candidates: readonly string[],
): string | undefined {
  return candidates.find((candidate) => columns.has(candidate));
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlProjection(
  columns: ReadonlySet<string>,
  candidates: readonly string[],
  alias: string,
): string {
  const column = firstAvailableColumn(columns, candidates);
  return `${column ? sqlIdentifier(column) : "NULL"} AS ${sqlIdentifier(alias)}`;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[!%_]/g, "!$&");
}

function firstValue(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  const value = firstValue(row, keys);
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

function isPathWithin(root: string, candidate: string): boolean {
  const scoped = relative(resolve(root), resolve(candidate));
  return (
    scoped === "" ||
    (scoped !== ".." && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped))
  );
}

function loadModelPerfDatabase(modelPerfPath: string): MaintenancePerformance {
  let database: Database | undefined;
  try {
    const path = modelPerfPath.trim();
    if (!existsSync(path)) return emptyPerformance();
    database = new Database(path, { readonly: true });
    const rows = database.query<ModelPerfRow, []>(
      "SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at FROM model_perf",
    ).all();
    const byModel = new Map<string, PerformanceAccumulator>();
    for (const row of rows) {
      if (typeof row.model_key !== "string" || !row.model_key.trim()) return emptyPerformance();
      const samples = nonnegativeNumber(row.samples);
      const outputTokens = nonnegativeNumber(row.output_tokens);
      const generationMs = nonnegativeNumber(row.gen_ms);
      const ttftSamples = nonnegativeNumber(row.ttft_samples);
      const ttftMs = nonnegativeNumber(row.ttft_ms);
      if (samples === undefined || outputTokens === undefined || generationMs === undefined || ttftSamples === undefined || ttftMs === undefined) {
        return emptyPerformance();
      }
      const modelKey = row.model_key.trim().slice(0, 200);
      const updatedAt = performanceUpdatedAt(row.updated_at);
      const current = byModel.get(modelKey) ?? {
        modelKey,
        samples: 0,
        outputTokens: 0,
        generationMs: 0,
        ttftSamples: 0,
        ttftMs: 0,
        updatedAt,
      };
      current.samples += samples;
      current.outputTokens += outputTokens;
      current.generationMs += generationMs;
      current.ttftSamples += ttftSamples;
      current.ttftMs += ttftMs;
      if (updatedAt > current.updatedAt) current.updatedAt = updatedAt;
      byModel.set(modelKey, current);
    }
    const modelRows = [...byModel.values()]
      .map(toModelPerformance)
      .sort((a, b) => a.modelKey.localeCompare(b.modelKey));
    const totals = [...byModel.values()].reduce(
      (total, row) => ({
        samples: total.samples + row.samples,
        outputTokens: total.outputTokens + row.outputTokens,
        generationMs: total.generationMs + row.generationMs,
        ttftSamples: total.ttftSamples + row.ttftSamples,
        ttftMs: total.ttftMs + row.ttftMs,
      }),
      { samples: 0, outputTokens: 0, generationMs: 0, ttftSamples: 0, ttftMs: 0 },
    );
    return {
      totals: {
        samples: totals.samples,
        outputTokens: totals.outputTokens,
        generationMs: totals.generationMs,
        tokensPerSecond: ratePerSecond(totals.outputTokens, totals.generationMs),
        timeToFirstTokenMs: average(totals.ttftMs, totals.ttftSamples),
      },
      byModel: modelRows,
    };
  } catch {
    return emptyPerformance();
  } finally {
    database?.close();
  }
}

function toModelPerformance(row: PerformanceAccumulator): MaintenanceModelPerformance {
  return {
    modelKey: row.modelKey,
    samples: row.samples,
    outputTokens: row.outputTokens,
    generationMs: row.generationMs,
    tokensPerSecond: ratePerSecond(row.outputTokens, row.generationMs),
    timeToFirstTokenMs: average(row.ttftMs, row.ttftSamples),
    updatedAt: row.updatedAt,
  };
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function ratePerSecond(outputTokens: number, generationMs: number): number {
  return generationMs > 0 ? outputTokens * 1_000 / generationMs : 0;
}

function average(total: number, count: number): number {
  return count > 0 ? total / count : 0;
}

function performanceUpdatedAt(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    return text && !Number.isNaN(new Date(text).getTime()) ? text : "";
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
