import {
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
  host: string;
  sessionKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  provider: string;
  model: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  usdCost: number;
  outputLimitWarningCount: number;
  reviewed: boolean;
};

export type MaintenanceUsageTotals = Omit<MaintenanceUsage, "host" | "sessionKey" | "firstSeenAt" | "lastSeenAt" | "provider" | "model" | "reviewed"> & {
  sessions: number;
};

export type MaintenanceModelUsage = Omit<MaintenanceUsage, "host" | "sessionKey" | "firstSeenAt" | "lastSeenAt" | "reviewed"> & {
  provider: string;
  model: string;
};

export type MaintenanceOverview = {
  usage: {
    totals: MaintenanceUsageTotals;
    recent: MaintenanceUsage[];
    byModel: MaintenanceModelUsage[];
  };
  tickets: MaintenanceTicket[];
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
  now?: Date | (() => Date);
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
      const current = state.tickets[index]!;
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
  for (const root of roots) {
    for (const path of jsonlFiles(root.path)) parseSessionFile(path, root.host, rows);
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      firstSeenAt: row.firstSeenAt || new Date(0).toISOString(),
      lastSeenAt: row.lastSeenAt || row.firstSeenAt || new Date(0).toISOString(),
      provider: row.provider || "unknown",
      model: row.model || "unknown",
      reviewed: reviewed.has(row.sessionKey),
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function getMaintenanceOverview(options: MaintenanceOptions = {}): MaintenanceOverview {
  const usage = scanMaintenanceUsage(options);
  const totals: MaintenanceUsageTotals = {
    sessions: usage.length,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
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
    totals.cacheTokens += row.cacheTokens;
    totals.totalTokens += row.totalTokens;
    totals.usdCost += row.usdCost;
    totals.outputLimitWarningCount += row.outputLimitWarningCount;
    const key = `${row.provider}\u0000${row.model}`;
    const aggregate = byModel.get(key) ?? {
      provider: row.provider,
      model: row.model,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      usdCost: 0,
      outputLimitWarningCount: 0,
    };
    aggregate.messageCount += row.messageCount;
    aggregate.inputTokens += row.inputTokens;
    aggregate.outputTokens += row.outputTokens;
    aggregate.cacheTokens += row.cacheTokens;
    aggregate.totalTokens += row.totalTokens;
    aggregate.usdCost += row.usdCost;
    aggregate.outputLimitWarningCount += row.outputLimitWarningCount;
    byModel.set(key, aggregate);
  }
  return {
    usage: {
      totals,
      recent: usage.slice(0, 25),
      byModel: [...byModel.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)),
    },
    tickets: listMaintenanceTickets(options),
  };
}

type PersistedTicket = MaintenanceTicket & { requestKey: string };
type UsageAccumulator = Omit<MaintenanceUsage, "reviewed" | "firstSeenAt" | "lastSeenAt" | "provider" | "model"> & {
  firstSeenAt: string;
  lastSeenAt: string;
  provider: string;
  model: string;
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

function resolveSessionRoots(input?: MaintenanceSessionRoots): MaintenanceSessionRoot[] {
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

function parseSessionFile(path: string, host: string, rows: Map<string, UsageAccumulator>): void {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  const fallbackId = path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") || path;
  let sessionId = fallbackId;
  let firstSeenAt = "";
  let lastSeenAt = "";
  let provider = "";
  let model = "";
  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;
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
    cacheTokens += tokens.cache;
    totalTokens += tokens.total;
    usdCost += tokens.cost;
    if (isOutputLimitWarning(event)) outputLimitWarningCount++;
  }
  if (!firstSeenAt && !lastSeenAt) {
    try {
      const mtime = statSync(path).mtime.toISOString();
      firstSeenAt = mtime;
      lastSeenAt = mtime;
    } catch { firstSeenAt = new Date(0).toISOString(); lastSeenAt = firstSeenAt; }
  }
  if (!totalTokens) totalTokens = inputTokens + outputTokens + cacheTokens;
  const sessionKey = hashMaintenanceSessionId(sessionId);
  const key = `${host}\u0000${sessionKey}`;
  const current = rows.get(key);
  if (!current) {
    rows.set(key, { host, sessionKey, firstSeenAt, lastSeenAt, provider, model, messageCount, inputTokens, outputTokens, cacheTokens, totalTokens, usdCost, outputLimitWarningCount });
    return;
  }
  current.firstSeenAt = !current.firstSeenAt || firstSeenAt < current.firstSeenAt ? firstSeenAt : current.firstSeenAt;
  current.lastSeenAt = lastSeenAt > current.lastSeenAt ? lastSeenAt : current.lastSeenAt;
  current.provider ||= provider;
  current.model ||= model;
  current.messageCount += messageCount;
  current.inputTokens += inputTokens;
  current.outputTokens += outputTokens;
  current.cacheTokens += cacheTokens;
  current.totalTokens += totalTokens;
  current.usdCost += usdCost;
  current.outputLimitWarningCount += outputLimitWarningCount;
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

function tokenFields(event: Record<string, unknown>): { input: number; output: number; cache: number; total: number; cost: number } {
  const message = isRecord(event.message) ? event.message : undefined;
  const containers = message ? [event, message] : [event];
  const candidates = containers.flatMap((container) =>
    [container.usage, container.tokens, container.tokenUsage, container.stats].filter(isRecord),
  );
  let input = 0; let output = 0; let cache = 0; let total = 0; let cost = 0;
  for (const value of candidates) {
    input += numberField(value, ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
    output += numberField(value, ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
    const directCache = numberField(value, ["cache", "cacheTokens", "cache_tokens"]);
    const cacheRead = numberField(value, ["cacheRead", "cache_read", "cacheReadTokens", "cache_read_tokens"]);
    const cacheWrite = numberField(value, ["cacheWrite", "cache_write", "cacheWriteTokens", "cache_write_tokens"]);
    cache += directCache || cacheRead + cacheWrite;
    total += numberField(value, ["total", "totalTokens", "total_tokens"]);
    const nestedCost = isRecord(value.cost)
      ? numberField(value.cost, ["total", "usd", "usdCost", "costUsd", "cost_usd"])
      : 0;
    cost += nestedCost || numberField(value, ["usd", "usdCost", "costUsd", "cost_usd", "cost"]);
  }
  cost += numberField(event, ["usdCost", "costUsd", "cost_usd"]);
  return { input, output, cache, total, cost };
}

function numberField(value: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.max(0, candidate);
  }
  return 0;
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key]!.trim().slice(0, 200) : "";
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
export { createMaintenanceService } from "./service";
