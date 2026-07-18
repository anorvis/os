import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getHomeDir } from "../../paths";

export const MAINTENANCE_FINAL_STATUSES = [
  "existing_pull_request",
  "fixed",
  "not_reproduced",
  "blocked",
  "verification_failed",
  "failed",
] as const;

export type MaintenanceTicketStatus =
  | "pending_approval"
  | "approved"
  | "running"
  | "rejected"
  | (typeof MAINTENANCE_FINAL_STATUSES)[number];
export type MaintenanceUsageScope = "foreground" | "monitor" | "maintainer";
export type MaintenanceUsagePeriod = "all" | "current_month";

export type MaintenanceTelemetryStage = "generalizer" | "worker" | "monitor";

export type MaintainerTelemetryStage = Exclude<MaintenanceTelemetryStage, "monitor">;

export type MaintainerTelemetryOutcome =
  | MaintenanceTicketStatus
  | "completed"
  | "error"
  | "timed_out"
  | "cancelled"
  | "output_limited";

export type MaintenanceTelemetryRecord = {
  scope: "monitor" | "maintainer";
  host: "monitor" | "maintainer";
  sessionKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  provider: string;
  model: string;
  stage: MaintenanceTelemetryStage;
  outcome: MaintainerTelemetryOutcome;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  totalTokens: number;
  usdCost: number;
};

export type MaintainerTelemetryRecord = Omit<MaintenanceTelemetryRecord, "scope" | "host" | "stage"> & {
  scope: "maintainer";
  host: "maintainer";
  stage: MaintainerTelemetryStage;
};

export type MaintenanceTelemetryMetrics = {
  provider?: string;
  model?: string;
  stage: MaintenanceTelemetryStage;
  outcome: MaintainerTelemetryOutcome;
  startedAt?: string | Date;
  completedAt?: string | Date;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens?: number;
  usdCost: number;
};

export type MaintainerTelemetryMetrics = Omit<MaintenanceTelemetryMetrics, "stage"> & {
  stage: MaintainerTelemetryStage;
};

export type MaintenanceTelemetryInput = MaintenanceTelemetryMetrics & {
  scope: "monitor" | "maintainer";
};

export type MaintainerTelemetryInput = MaintainerTelemetryMetrics;

export type MaintenanceTelemetryParseOptions = {
  stage: MaintenanceTelemetryStage;
  outcome: MaintainerTelemetryOutcome;
  startedAt?: string | Date;
  completedAt?: string | Date;
};

export type MaintainerTelemetryParseOptions = Omit<MaintenanceTelemetryParseOptions, "stage"> & {
  stage: MaintainerTelemetryStage;
};

export type MaintainerTelemetryOptions = {
  root?: string;
  now?: Date | (() => Date);
};


export type MaintenanceTicket = {
  id: string;
  status: MaintenanceTicketStatus;
  task: string;
  /** A one-way project key; never a raw project path or identifier. */
  project: string;
  createdAt: string;
  updatedAt: string;
  answer?: string;
  pullRequest?: string;
  verification: string[];
  warnings: string[];
};
export type MaintenanceTicketLinearLink = {
  identifier: string;
  url: string;
};

export type MaintenanceOverviewTicket = MaintenanceTicket & {
  linear?: MaintenanceTicketLinearLink;
};

export type CreateMaintenanceTicketInput = {
  task: string;
  project?: string;
};

export type UpdateMaintenanceTicketInput = {
  status?: MaintenanceTicketStatus;
  answer?: string;
  pullRequest?: string;
  verification?: string[];
  warnings?: string[];
};

export type MaintenanceReview = {
  sessionKey: string;
  turnIndex?: number;
  reviewedAt: string;
};

export type MaintenanceUsage = {
  scope: MaintenanceUsageScope;
  host: string;
  sessionKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  provider: string;
  model: string;
  stage: MaintenanceTelemetryStage | null;
  outcome: MaintainerTelemetryOutcome | null;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  totalTokens: number;
  usdCost: number;
  outputLimitWarningCount: number;
  reviewed: boolean;
};

export type MaintenanceUsageTotals = Omit<MaintenanceUsage, "scope" | "host" | "sessionKey" | "firstSeenAt" | "lastSeenAt" | "provider" | "model" | "stage" | "outcome" | "reviewed"> & {
  sessions: number;
};

export type MaintenanceModelUsage = Omit<MaintenanceUsage, "scope" | "host" | "sessionKey" | "firstSeenAt" | "lastSeenAt" | "stage" | "outcome" | "reviewed"> & {
  provider: string;
  model: string;
  sessions: number;
};

export type MaintenancePerformanceTotals = {
  samples: number;
  outputTokens: number;
  generationMs: number;
  tokensPerSecond: number;
  timeToFirstTokenMs: number;
};

export type MaintenanceModelPerformance = MaintenancePerformanceTotals & {
  modelKey: string;
  updatedAt: string;
};

export type MaintenancePerformance = {
  totals: MaintenancePerformanceTotals;
  byModel: MaintenanceModelPerformance[];
};

export type MaintenanceOverview = {
  scope: MaintenanceUsageScope;
  usagePeriod: MaintenanceUsagePeriod;
  usageSince: string | null;
  usage: {
    totals: MaintenanceUsageTotals;
    recent: MaintenanceUsage[];
    byModel: MaintenanceModelUsage[];
  };
  performance: MaintenancePerformance;
  tickets: MaintenanceOverviewTicket[];
  total?: number;
  usageTotal?: number;
};

export type MaintenanceSessionRoot = {
  host: string;
  path: string;
};

export type MaintenanceSessionRoots =
  | string[]
  | MaintenanceSessionRoot[]
  | { pi?: string | string[]; omp?: string | string[] };

export type MaintenanceOptions = {
  root?: string;
  sessionRoots?: MaintenanceSessionRoots;
  maintainerModelPerfPath?: string;
  foregroundStatsPath?: string;
  sessionScope?: MaintenanceUsageScope;
  now?: Date | (() => Date);
  limit?: number;
  offset?: number;
  ticketStatuses?: readonly MaintenanceTicketStatus[];
  sessionLimit?: number;
  sessionOffset?: number;
  // Ticket-only callers skip the (expensive) usage scan and performance load.
  includeUsage?: boolean;
};


type PersistedState = {
  version: 1;
  tickets: PersistedTicket[];
  reviews: MaintenanceReview[];
};

export type MaintenanceStore = {
  path: string;
  read(): PersistedState;
  write(state: PersistedState): void;
  createTicket(input: CreateMaintenanceTicketInput): MaintenanceTicket;
  updateTicket(id: string, input: UpdateMaintenanceTicketInput): MaintenanceTicket | undefined;
  listTickets(): MaintenanceTicket[];
  recordReview(input: { sessionId: string; turnIndex?: number }): MaintenanceReview;
  listReviews(): MaintenanceReview[];
};

const ACTIVE_STATUSES = new Set<MaintenanceTicketStatus>([
  "pending_approval",
  "approved",
  "running",
]);

export function maintenanceRoot(root?: string): string {
  return root?.trim() || process.env.ANORVIS_MONITOR_ROOT?.trim() || join(getHomeDir(), ".anorvis", "monitor");
}

export function maintenancePath(root?: string): string {
  return join(maintenanceRoot(root), "maintenance.json");
}

export function hashMaintenanceSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function createMaintenanceStore(options: { root?: string; now?: Date | (() => Date) } = {}): MaintenanceStore {
  const path = maintenancePath(options.root);
  const now = () => {
    const value = options.now;
    return (typeof value === "function" ? value() : value) ?? new Date();
  };
  const read = (): PersistedState => readState(path);
  const write = (state: PersistedState): void => atomicWrite(path, state);

  return {
    path,
    read,
    write,
    createTicket(input) {
      const state = read();
      const task = normalizeTask(input.task);
      const project = hashProject(input.project ?? "");
      const requestKey = hashRequest(task, input.project ?? "");
      const existing = state.tickets.find((ticket) =>
        ACTIVE_STATUSES.has(ticket.status) && ticket.requestKey === requestKey,
      );
      if (existing) return publicTicket(existing);
      const createdAt = now().toISOString();
      const ticket: PersistedTicket = {
        id: randomUUID(),
        status: "pending_approval",
        task,
        project,
        requestKey,
        createdAt,
        updatedAt: createdAt,
        verification: [],
        warnings: [],
      };
      state.tickets.push(ticket);
      write(state);
      return publicTicket(ticket);
    },
    updateTicket(id, input) {
      const state = read();
      const index = state.tickets.findIndex((ticket) => ticket.id === id);
      if (index < 0) return undefined;
      const current = state.tickets[index];
      const updated: PersistedTicket = {
        ...current,
        ...(input.status ? { status: input.status } : {}),
        ...(input.answer !== undefined ? { answer: redactText(input.answer) } : {}),
        ...(input.pullRequest !== undefined ? { pullRequest: safePullRequest(input.pullRequest) } : {}),
        ...(input.verification !== undefined ? { verification: redactList(input.verification) } : {}),
        ...(input.warnings !== undefined ? { warnings: redactList(input.warnings) } : {}),
        updatedAt: now().toISOString(),
      };
      state.tickets[index] = updated;
      write(state);
      return publicTicket(updated);
    },
    listTickets() {
      return read().tickets
        .map(publicTicket)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    recordReview(input) {
      const state = read();
      const sessionKey = hashMaintenanceSessionId(input.sessionId);
      const existing = state.reviews.find((review) => review.sessionKey === sessionKey && review.turnIndex === input.turnIndex);
      if (existing) return { ...existing };
      const review: MaintenanceReview = {
        sessionKey,
        ...(Number.isInteger(input.turnIndex) && input.turnIndex! >= 0 ? { turnIndex: input.turnIndex } : {}),
        reviewedAt: now().toISOString(),
      };
      state.reviews.push(review);
      write(state);
      return { ...review };
    },
    listReviews() {
      return read().reviews.map((review) => ({ ...review }));
    },
  };
}

export function createMaintenanceTicket(
  input: CreateMaintenanceTicketInput,
  options: MaintenanceOptions = {},
): MaintenanceTicket {
  return createMaintenanceStore(options).createTicket(input);
}

export function updateMaintenanceTicket(
  id: string,
  input: UpdateMaintenanceTicketInput,
  options: MaintenanceOptions = {},
): MaintenanceTicket | undefined {
  return createMaintenanceStore(options).updateTicket(id, input);
}

export function listMaintenanceTickets(options: MaintenanceOptions = {}): MaintenanceTicket[] {
  return createMaintenanceStore(options).listTickets();
}

export function recordMaintenanceReview(
  input: { sessionId: string; turnIndex?: number },
  options: MaintenanceOptions = {},
): MaintenanceReview {
  return createMaintenanceStore(options).recordReview(input);
}

export function scanMaintenanceUsage(options: MaintenanceOptions = {}): MaintenanceUsage[] {
  const roots = resolveSessionRoots(options.sessionRoots);
  const reviews = createMaintenanceStore(options).listReviews();
  const reviewed = new Set(reviews.map((review) => review.sessionKey));
  const rows = new Map<string, UsageAccumulator>();
  const seen = new Set<string>();
  for (const root of roots) {
    for (const path of jsonlFiles(root.path)) {
      seen.add(path);
      mergeContribution(rows, cachedContribution(path, root.host));
    }
  }
  // Session files can disappear (cleanup, root changes); drop their cache
  // entries so the memo never outgrows the live session set.
  for (const path of sessionFileCache.keys()) {
    if (!seen.has(path)) sessionFileCache.delete(path);
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      scope: "foreground" as const,
      firstSeenAt: row.firstSeenAt || new Date(0).toISOString(),

      lastSeenAt: row.lastSeenAt || row.firstSeenAt || new Date(0).toISOString(),
      provider: row.provider || "unknown",
      model: row.model || "unknown",
      stage: null,
      outcome: null,
      reviewed: reviewed.has(row.sessionKey),
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function getMaintainerTelemetryPath(root?: string): string {
  return process.env.ANORVIS_MAINTAINER_USAGE_LEDGER?.trim()
    || join(maintenanceRoot(root), "maintainer-usage.jsonl");
}

export const maintainerTelemetryPath = getMaintainerTelemetryPath;

export function parseMaintenanceTelemetry(
  stdout: string,
  options: MaintenanceTelemetryParseOptions,
): MaintenanceTelemetryMetrics | undefined {
  if (typeof stdout !== "string" || !options || !isMaintainerTelemetryOutcome(options.outcome)) return undefined;
  if (!isMaintenanceTelemetryStage(options.stage)) return undefined;
  const parsed = parseMaintainerOutputUsage(stdout);
  return {
    provider: parsed.provider || "unknown",
    model: parsed.model || "unknown",
    stage: options.stage,
    outcome: options.outcome,
    ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
    ...(options.completedAt !== undefined ? { completedAt: options.completedAt } : {}),
    messageCount: parsed.messageCount,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    cacheWriteTokens: parsed.cacheWriteTokens,
    totalTokens: parsed.totalTokens || parsed.inputTokens + parsed.outputTokens + parsed.cacheReadTokens + parsed.cacheWriteTokens,
    usdCost: parsed.usdCost,
  };
}

export function parseMaintainerTelemetry(
  stdout: string,
  options: MaintainerTelemetryParseOptions,
): MaintainerTelemetryMetrics | undefined {
  const parsed = parseMaintenanceTelemetry(stdout, options);
  return parsed ? { ...parsed, stage: options.stage } : undefined;
}

export const parseMaintainerUsage = parseMaintainerTelemetry;

export function recordMaintenanceTelemetry(
  input: MaintenanceTelemetryInput,
  options: MaintainerTelemetryOptions = {},
): MaintenanceTelemetryRecord | undefined {
  if (!input || !isMaintainerTelemetryOutcome(input.outcome)) return undefined;
  if (!isMaintenanceTelemetryStage(input.stage)) return undefined;
  if (input.scope !== "monitor" && input.scope !== "maintainer") return undefined;
  if (input.scope === "monitor" ? input.stage !== "monitor" : input.stage === "monitor") return undefined;
  const nowValue = options.now;
  const now = typeof nowValue === "function" ? nowValue() : nowValue;
  const firstSeenAt = normalizeTelemetryTimestamp(input.startedAt) || (now ?? new Date()).toISOString();
  const lastSeenAt = normalizeTelemetryTimestamp(input.completedAt) || firstSeenAt;
  const path = getMaintainerTelemetryPath(options.root);
  const record: MaintenanceTelemetryRecord = {
    scope: input.scope,
    host: input.scope,
    sessionKey: hashMaintenanceSessionId(randomUUID()),
    firstSeenAt,
    lastSeenAt,
    provider: normalizeTelemetryString(input.provider) || "unknown",
    model: normalizeTelemetryString(input.model) || "unknown",
    stage: input.stage,
    outcome: input.outcome,
    messageCount: nonnegativeMetric(input.messageCount),
    inputTokens: nonnegativeMetric(input.inputTokens),
    outputTokens: nonnegativeMetric(input.outputTokens),
    cacheReadTokens: nonnegativeMetric(input.cacheReadTokens),
    cacheWriteTokens: nonnegativeMetric(input.cacheWriteTokens),
    cacheTokens: nonnegativeMetric(input.cacheReadTokens) + nonnegativeMetric(input.cacheWriteTokens),
    totalTokens: nonnegativeMetric(input.totalTokens ?? 0) || (
      nonnegativeMetric(input.inputTokens)
      + nonnegativeMetric(input.outputTokens)
      + nonnegativeMetric(input.cacheReadTokens)
      + nonnegativeMetric(input.cacheWriteTokens)
    ),
    usdCost: nonnegativeMetric(input.usdCost),
  };
  const root = dirname(path);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return record;
}

export function recordMaintainerTelemetry(
  input: MaintainerTelemetryInput,
  options: MaintainerTelemetryOptions = {},
): MaintainerTelemetryRecord | undefined {
  const record = recordMaintenanceTelemetry({ ...input, scope: "maintainer" }, options);
  return record as MaintainerTelemetryRecord | undefined;
}

export const recordMaintainerUsage = recordMaintainerTelemetry;
export const recordMaintenanceUsage = recordMaintenanceTelemetry;

type ParsedMaintainerUsage = {
  provider: string;
  model: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  usdCost: number;
};

function parseMaintainerOutputUsage(stdout: string): ParsedMaintainerUsage {
  const result: ParsedMaintainerUsage = {
    provider: "",
    model: "",
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    usdCost: 0,
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    const message = isRecord(event.message) ? event.message : undefined;
    const assistant = event.role === "assistant" || message?.role === "assistant";
    if (!assistant || event.type !== "message_end") continue;
    result.messageCount++;
    result.provider ||= stringField(event, "provider") || (message ? stringField(message, "provider") : "");
    result.model ||= stringField(event, "model") || stringField(event, "modelId")
      || (message ? stringField(message, "model") || stringField(message, "modelId") : "");
    const tokens = tokenFields(event);
    result.inputTokens += tokens.input;
    result.outputTokens += tokens.output;
    result.cacheReadTokens += tokens.cacheRead;
    result.cacheWriteTokens += tokens.cacheWrite;
    result.totalTokens += tokens.total;
    result.usdCost += tokens.cost;
  }
  return result;
}

function normalizeTelemetryString(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

function nonnegativeMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeTelemetryTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && !Number.isNaN(new Date(text).getTime()) ? new Date(text).toISOString() : undefined;
}

function isMaintenanceTelemetryStage(value: unknown): value is MaintenanceTelemetryStage {
  return value === "generalizer" || value === "worker" || value === "monitor";
}

function isMaintainerTelemetryStage(value: unknown): value is MaintainerTelemetryStage {
  return value === "generalizer" || value === "worker";
}

function isMaintenanceTelemetryScope(value: unknown): value is "monitor" | "maintainer" {
  return value === "monitor" || value === "maintainer";
}

function isMaintainerTelemetryOutcome(value: unknown): value is MaintainerTelemetryOutcome {
  return value === "pending_approval"
    || value === "approved"
    || value === "running"
    || value === "rejected"
    || value === "existing_pull_request"
    || value === "fixed"
    || value === "not_reproduced"
    || value === "blocked"
    || value === "verification_failed"
    || value === "failed"
    || value === "completed"
    || value === "error"
    || value === "timed_out"
    || value === "cancelled"
    || value === "output_limited";
}

function parsePersistedTelemetry(value: unknown): MaintenanceTelemetryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const scope = value.scope;
  if (!isMaintenanceTelemetryScope(scope) || value.host !== scope) return undefined;
  const host = scope;
  if (typeof value.sessionKey !== "string" || !/^[0-9a-f]{64}$/.test(value.sessionKey)) return undefined;
  if (!isMaintenanceTelemetryStage(value.stage)) return undefined;
  if (scope === "monitor" ? value.stage !== "monitor" : !isMaintainerTelemetryStage(value.stage)) return undefined;
  if (!isMaintainerTelemetryOutcome(value.outcome)) return undefined;
  const firstSeenAt = normalizeTelemetryTimestamp(value.firstSeenAt);
  const lastSeenAt = normalizeTelemetryTimestamp(value.lastSeenAt);
  if (!firstSeenAt || !lastSeenAt) return undefined;
  return {
    scope,
    host,
    sessionKey: value.sessionKey,
    firstSeenAt,
    lastSeenAt,
    provider: normalizeTelemetryString(value.provider) || "unknown",
    model: normalizeTelemetryString(value.model) || "unknown",
    stage: value.stage,
    outcome: value.outcome,
    messageCount: nonnegativeMetric(value.messageCount),
    inputTokens: nonnegativeMetric(value.inputTokens),
    outputTokens: nonnegativeMetric(value.outputTokens),
    cacheReadTokens: nonnegativeMetric(value.cacheReadTokens),
    cacheWriteTokens: nonnegativeMetric(value.cacheWriteTokens),
    cacheTokens: nonnegativeMetric(value.cacheTokens),
    totalTokens: nonnegativeMetric(value.totalTokens),
    usdCost: nonnegativeMetric(value.usdCost),
  };
}

function scanTelemetryUsage(
  options: MaintainerTelemetryOptions,
  scope: "monitor" | "maintainer",
): MaintenanceUsage[] {
  const path = getMaintainerTelemetryPath(options.root);
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const rows = new Map<string, MaintenanceUsage>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const record = parsePersistedTelemetry(value);
    if (record?.scope === scope) rows.set(record.sessionKey, {
      ...record,
      outputLimitWarningCount: 0,
      reviewed: false,
    });
  }
  return [...rows.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function scanMaintainerUsage(options: MaintainerTelemetryOptions = {}): MaintenanceUsage[] {
  return scanTelemetryUsage(options, "maintainer");
}

export function scanMonitorUsage(options: MaintainerTelemetryOptions = {}): MaintenanceUsage[] {
  return scanTelemetryUsage(options, "monitor");
}


type PersistedTicket = MaintenanceTicket & { requestKey: string };
type UsageAccumulator = Omit<MaintenanceUsage, "scope" | "reviewed" | "firstSeenAt" | "lastSeenAt" | "provider" | "model" | "stage" | "outcome"> & {
  host: string;
  sessionKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  provider: string;
  model: string;
  stage: null;
  outcome: null;
};







function readState(path: string): PersistedState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return emptyState();
    const tickets = Array.isArray(parsed.tickets) ? parsed.tickets.flatMap(parseTicket) : [];
    const reviews = Array.isArray(parsed.reviews) ? parsed.reviews.flatMap(parseReview) : [];
    return { version: 1, tickets, reviews };
  } catch {
    return emptyState();
  }
}

function emptyState(): PersistedState {
  return { version: 1, tickets: [], reviews: [] };
}

function atomicWrite(path: string, state: PersistedState): void {
  const root = dirname(path);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function parseTicket(value: unknown): PersistedTicket[] {
  if (!isRecord(value) || typeof value.id !== "string" || !isTicketStatus(value.status) || typeof value.task !== "string") return [];
  const project = typeof value.project === "string" && /^[0-9a-f]{32}$/.test(value.project)
    ? value.project
    : hashProject(typeof value.project === "string" ? value.project : "");
  const task = normalizeTask(value.task);
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
  return [{
    id: value.id,
    status: value.status,
    task,
    project,
    requestKey: typeof value.requestKey === "string" && /^[0-9a-f]{64}$/.test(value.requestKey)
      ? value.requestKey
      : hashRequest(task, project),
    createdAt,
    updatedAt,
    ...(typeof value.answer === "string" ? { answer: redactText(value.answer) } : {}),
    ...(typeof value.pullRequest === "string" ? { pullRequest: safePullRequest(value.pullRequest) } : {}),
    verification: redactList(value.verification),
    warnings: redactList(value.warnings),
  }];
}

function parseReview(value: unknown): MaintenanceReview[] {
  if (!isRecord(value) || typeof value.sessionKey !== "string" || !/^[0-9a-f]{64}$/.test(value.sessionKey)) return [];
  const turnIndex = typeof value.turnIndex === "number" && Number.isInteger(value.turnIndex) && value.turnIndex >= 0
    ? value.turnIndex
    : undefined;
  return [{
    sessionKey: value.sessionKey,
    ...(turnIndex !== undefined ? { turnIndex } : {}),
    reviewedAt: typeof value.reviewedAt === "string" ? value.reviewedAt : new Date(0).toISOString(),
  }];
}

function publicTicket(ticket: PersistedTicket): MaintenanceTicket {
  const { requestKey: _requestKey, ...value } = ticket;
  return { ...value, verification: [...value.verification], warnings: [...value.warnings] };
}

function isTicketStatus(value: unknown): value is MaintenanceTicketStatus {
  return value === "pending_approval" || value === "approved" || value === "running" || value === "rejected" || MAINTENANCE_FINAL_STATUSES.includes(value as never);
}

function normalizeTask(value: string): string {
  return redactText(value).trim().replace(/\s+/g, " ").slice(0, 800);
}

function hashProject(value: string): string {
  return createHash("sha256").update(normalizeProject(value)).digest("hex").slice(0, 32);
}

function normalizeProject(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase();
}

function hashRequest(task: string, project: string): string {
  return createHash("sha256").update(`${task}\u0000${normalizeProject(project)}`).digest("hex");
}

function redactText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:)?\/(?:[^\s/]+\/){1,}[^\s]*/g, "[path]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]")
    .slice(0, 2_000);
}

function safePullRequest(value: string): string {
  return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(value.trim())
    ? value.trim()
    : redactText(value);
}

function redactList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(redactText).slice(0, 32)
    : [];
}

export function resolveSessionRoots(input?: MaintenanceSessionRoots): MaintenanceSessionRoot[] {
  if (input) {
    if (Array.isArray(input)) {
      return input.flatMap((value) => typeof value === "string" ? [{ host: hostFromPath(value), path: value }] : [value]);
    }
    return [
      ...(input.pi ? toRootList("pi", input.pi) : []),
      ...(input.omp ? toRootList("omp", input.omp) : []),
    ];
  }
  const home = getHomeDir();
  const roots: MaintenanceSessionRoot[] = [];
  const pi = process.env.ANORVIS_PI_SESSION_ROOT?.trim() || join(home, ".pi", "agent", "sessions");
  const omp = process.env.ANORVIS_OMP_SESSION_ROOT?.trim();
  roots.push({ host: "pi", path: pi });
  for (const path of [omp, join(home, ".omp", "sessions"), join(home, ".omp", "agent", "sessions")]) {
    if (path && !roots.some((root) => root.path === path)) roots.push({ host: "omp", path });
  }
  return roots;
}

function toRootList(host: string, value: string | string[]): MaintenanceSessionRoot[] {
  return (Array.isArray(value) ? value : [value]).map((path) => ({ host, path }));
}

function hostFromPath(path: string): string {
  return /(?:^|[\\/])\.omp(?:[\\/]|$)/.test(path) ? "omp" : "pi";
}

function jsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (path: string): void => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
    }
  };
  try {
    const info = statSync(root);
    if (info.isFile()) return root.endsWith(".jsonl") ? [root] : [];
    if (info.isDirectory()) visit(root);
  } catch {
    return [];
  }
  return files;
}
type SessionFileContribution = UsageAccumulator;

type SessionFileCacheEntry = {
  stamp: string;
  contribution: SessionFileContribution | undefined;
};

// Session JSONL roots reach hundreds of megabytes; reparsing every file on
// every overview request is the dominant gateway cost. Files are append-only
// per session, so (mtime, size) identifies parsed content exactly.
const sessionFileCache = new Map<string, SessionFileCacheEntry>();

function cachedContribution(
  path: string,
  host: string,
): SessionFileContribution | undefined {
  let stamp: string;
  try {
    const info = statSync(path);
    stamp = `${host}\u0000${info.mtimeMs}\u0000${info.size}`;
  } catch {
    return undefined;
  }
  const cached = sessionFileCache.get(path);
  if (cached && cached.stamp === stamp) return cached.contribution;
  const contribution = parseSessionFile(path, host);
  sessionFileCache.set(path, { stamp, contribution });
  return contribution;
}

function mergeContribution(
  rows: Map<string, UsageAccumulator>,
  contribution: SessionFileContribution | undefined,
): void {
  if (!contribution) return;
  const key = `${contribution.host}\u0000${contribution.sessionKey}`;
  const current = rows.get(key);
  if (!current) {
    rows.set(key, { ...contribution });
    return;
  }
  current.firstSeenAt = !current.firstSeenAt || contribution.firstSeenAt < current.firstSeenAt ? contribution.firstSeenAt : current.firstSeenAt;
  current.lastSeenAt = contribution.lastSeenAt > current.lastSeenAt ? contribution.lastSeenAt : current.lastSeenAt;
  current.provider ||= contribution.provider;
  current.model ||= contribution.model;
  current.messageCount += contribution.messageCount;
  current.inputTokens += contribution.inputTokens;
  current.outputTokens += contribution.outputTokens;
  current.cacheReadTokens += contribution.cacheReadTokens;
  current.cacheWriteTokens += contribution.cacheWriteTokens;
  current.cacheTokens += contribution.cacheTokens;
  current.totalTokens += contribution.totalTokens;
  current.usdCost += contribution.usdCost;
  current.outputLimitWarningCount += contribution.outputLimitWarningCount;
}

function parseSessionFile(path: string, host: string): SessionFileContribution | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const fallbackId = path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") || path;
  let sessionId = fallbackId;
  let firstSeenAt = "";
  let lastSeenAt = "";
  let provider = "";
  let model = "";
  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let usdCost = 0;
  let outputLimitWarningCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    if (typeof event.sessionId === "string") sessionId = event.sessionId;
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (typeof event.id === "string" && (event.type === "session" || event.type === "session_start")) sessionId = event.id;
    const timestamp = eventTimestamp(event);
    if (timestamp) {
      if (!firstSeenAt || timestamp < firstSeenAt) firstSeenAt = timestamp;
      if (!lastSeenAt || timestamp > lastSeenAt) lastSeenAt = timestamp;
    }
    provider ||= stringField(event, "provider");
    model ||= stringField(event, "model") || stringField(event, "modelId");
    const message = isRecord(event.message) ? event.message : undefined;
    if (event.type === "message" || event.type === "message_start" || event.role === "user" || event.role === "assistant" || message?.role === "user" || message?.role === "assistant") messageCount++;
    provider ||= message ? stringField(message, "provider") : "";
    model ||= message ? stringField(message, "model") || stringField(message, "modelId") : "";
    const tokens = tokenFields(event);
    inputTokens += tokens.input;
    outputTokens += tokens.output;
    cacheReadTokens += tokens.cacheRead;
    cacheWriteTokens += tokens.cacheWrite;
    totalTokens += tokens.total;
    usdCost += tokens.cost;
    if (isOutputLimitWarning(event)) outputLimitWarningCount++;
  }
  const cacheTokens = cacheReadTokens + cacheWriteTokens;
  if (!firstSeenAt && !lastSeenAt) {
    try {
      const mtime = statSync(path).mtime.toISOString();
      firstSeenAt = mtime;
      lastSeenAt = mtime;
    } catch { firstSeenAt = new Date(0).toISOString(); lastSeenAt = firstSeenAt; }
  }
  if (!totalTokens) totalTokens = inputTokens + outputTokens + cacheTokens;
  const sessionKey = hashMaintenanceSessionId(sessionId);
  return { host, sessionKey, firstSeenAt, lastSeenAt, provider, model, stage: null, outcome: null, messageCount, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheTokens, totalTokens, usdCost, outputLimitWarningCount };
}

function eventTimestamp(event: Record<string, unknown>): string | undefined {
  for (const key of ["timestamp", "createdAt", "created_at", "time", "ts", "date"]) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (typeof value === "string") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return undefined;
}

function tokenFields(event: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number } {
  const message = isRecord(event.message) ? event.message : undefined;
  const containers = message ? [event, message] : [event];
  const candidates = containers.flatMap((container) =>
    [container.usage, container.tokens, container.tokenUsage, container.stats].filter(isRecord),
  );
  let input = 0; let output = 0; let cacheRead = 0; let cacheWrite = 0; let total = 0; let cost = 0;
  for (const value of candidates) {
    input += numberField(value, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
    output += numberField(value, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
    const directCache = numberField(value, ["cache", "cacheTokens", "cache_tokens"]);
    cacheRead += directCache || numberField(value, ["cacheRead", "cache_read", "cacheReadTokens", "cache_read_tokens"]);
    cacheWrite += numberField(value, ["cacheWrite", "cache_write", "cacheWriteTokens", "cache_write_tokens"]);
    total += numberField(value, ["total", "totalTokens", "total_tokens"]);
    const nestedCost = isRecord(value.cost)
      ? numberField(value.cost, ["total", "usd", "usdCost", "costUsd", "cost_usd"])
      : 0;
    cost += nestedCost || numberField(value, ["usd", "usdCost", "costUsd", "cost_usd", "cost"]);
  }
  cost += numberField(event, ["usdCost", "costUsd", "cost_usd"]);
  return { input, output, cacheRead, cacheWrite, total, cost };
}

function numberField(value: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.max(0, candidate);
  }
  return 0;
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key].trim().slice(0, 200) : "";
}

function isOutputLimitWarning(event: Record<string, unknown>): boolean {
  for (const key of ["outputLimited", "output_limited", "outputLimitExceeded", "output_limit_exceeded"]) {
    if (event[key] === true) return true;
  }
  const stopReason = [event.stopReason, event.stop_reason].find((value): value is string => typeof value === "string");
  if (stopReason && /(?:length|max[_-]?tokens|output[_-]?limit)/i.test(stopReason)) return true;
  const message = isRecord(event.message) ? event.message : undefined;
  if (event.type === "warning" || event.type === "error") {
    const text = [event.message, event.warning, event.error, event.reason]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    return /output\s*(?:limit|limited|exceed)/i.test(text);
  }
  if (event.role === "toolResult" || message?.role === "toolResult") {
    try {
      return /(?:exceeded the output limit|output[_\s-]*limited)/i.test(JSON.stringify(message ?? event));
    } catch {
      return false;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
