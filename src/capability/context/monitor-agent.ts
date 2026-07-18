import { spawnSync } from "node:child_process";
import type { ContextEventInput } from "./schema";
import { runAgentProcess } from "../../core/agent/process";
import {
  resolveAgentModel,
  resolveAgentThinking,
} from "../../core/config/agent-settings";

export type MonitorInput = {
  events: readonly ContextEventInput[];
  priorNotes?: string;
  signal?: AbortSignal;
};

export type MonitorSummary = {
  conversationId: string;
  visibility: "private" | "shared";
  channelId?: string;
  summary: string;
};

export type MonitorWikiTask = { task: string };
export type MonitorNotification = { text: string; reason: string };

export type MonitorResult = {
  summaries: MonitorSummary[];
  wikiTasks: MonitorWikiTask[];
  notifications: MonitorNotification[];
  notes: string;
};

export type MonitorAgentRun = {
  events: readonly ContextEventInput[];
  priorNotes: string;
  now: Date;
  signal?: AbortSignal;
};

export type MonitorAgentRunner = (
  input: MonitorAgentRun,
) => Promise<unknown>;

export type MonitorAgentDeps = {
  cwd?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  command?: string;
  commandAvailable?: (command: string) => boolean;
  monitorAgent?: MonitorAgentRunner;
  timeoutMs?: number;
};

export type MonitorAgentCommand = { command: string; label: string };

export type MonitorScope = {
  conversations: Set<string>;
  conversationChannels: Map<string, Set<string>>;
  conversationVisibilities?: Map<string, Set<"private" | "shared">>;
};

type PromptInput = {
  events: readonly ContextEventInput[];
  priorNotes?: string;
  now?: Date;
};

const MAX_INPUT_EVENTS = 128;
const MAX_EVENT_TEXT = 2_000;
const MAX_PRIOR_NOTES = 8_000;
const MAX_SUMMARIES = 32;
const MAX_WIKI_TASKS = 16;
const MAX_NOTIFICATIONS = 16;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_WIKI_TASK_LENGTH = 800;
const MAX_NOTIFICATION_TEXT = 1_000;
const MAX_NOTIFICATION_REASON = 600;
const MAX_NOTES_LENGTH = 8_000;
const MAX_AGENT_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

const EMPTY_RESULT: MonitorResult = {
  summaries: [],
  wikiTasks: [],
  notifications: [],
  notes: "",
};

/** Run the Monitor against one claimed batch without exposing any tools. */
export async function runMonitorAgent(
  input: MonitorInput,
  deps: MonitorAgentDeps = {},
): Promise<MonitorResult> {
  try {
    const events = normalizeEvents(input?.events);
    const priorNotes = clipString(input?.priorNotes, MAX_PRIOR_NOTES);
    if (events.length === 0 && !priorNotes) {
      return { ...EMPTY_RESULT, notes: "No context events or prior notes to curate." };
    }

    const run: MonitorAgentRun = {
      events,
      priorNotes,
      now: deps.now ?? new Date(),
      signal: input?.signal,
    };
    const scope = makeScope(events);
    const value = deps.monitorAgent
      ? await deps.monitorAgent(run)
      : await runCliMonitorAgent(run, deps);
    return normalizeMonitorOutput(value, scope);
  } catch (error) {
    return monitorFailure(errorMessage(error));
  }
}

/** Build the Monitor's bounded, no-tools curation prompt. */
export function buildMonitorPrompt(input: PromptInput): string {
  const events = normalizeEvents(input.events).slice(0, MAX_INPUT_EVENTS);
  const priorNotes = clipString(input.priorNotes, MAX_PRIOR_NOTES);
  const now = input.now ?? new Date();
  const compactEvents = events.map(compactEvent);
  return `You are the Anorvis Monitor, a proactive personal monitor for shared context across Anorvis surfaces.

Date: ${now.toISOString()}

Your input is a claimed batch of normalized context events and prior compact notes. Track concrete progress and commitments on the user's tasks, deadlines, and follow-ups; notice durable knowledge and useful cross-domain patterns across projects, health, finance, and calendar context. Curate compact, useful summaries and notes, and proactively notify the owner only when something is timely, high-signal, and genuinely useful. Prefer silence over low-value output and leave empty arrays when there is nothing worth preserving or surfacing.

Privacy and scope rules:
- Preserve visibility exactly. Private events may only be represented in private summaries or owner-directed notifications; never leak private details into a shared summary.
- A shared summary must include the channelId from its source scope. Never invent or merge channel scopes, conversations, workspaces, or identities.
- Treat prior notes as private context. Never expose secrets, credentials, or sensitive personal details.
- Wiki tasks are requests for later curation only, not execution.

Capability boundary (strict): you have no tools and must not request or use any. Do not perform or propose repair, GitHub, PR, issue, code-change, or Maintainer actions. Never create a repair ticket, mention GitHub, dispatch code changes, or act as a Maintainer. Do not discuss these actions in your result.

Return ONLY valid JSON with this exact shape and no markdown:
{"summaries":[{"conversationId":"...","visibility":"private|shared","channelId":"...","summary":"..."}],"wikiTasks":[{"task":"..."}],"notifications":[{"text":"...","reason":"..."}],"notes":"..."}
Use no fields other than those shown. Bound each item to a concise statement.

Prior compact notes:
${priorNotes || "(none)"}

Claimed context events (JSON):
${JSON.stringify(compactEvents)}
`;
}

/** Resolve the OMP executable while allowing tests and local installations to override it. */
export function resolveMonitorAgentCommand(
  env: Record<string, string | undefined> = process.env,
  commandAvailable: (command: string) => boolean = commandExists,
): MonitorAgentCommand {
  const configured = env.ANORVIS_MONITOR_AGENT_COMMAND?.trim() || env.ANORVIS_OMP_COMMAND?.trim() || env.ANORVIS_AGENT_COMMAND?.trim();
  if (configured) return { command: configured, label: `${configured} Monitor Agent` };
  if (commandAvailable("omp")) return { command: "omp", label: "OMP Monitor Agent" };
  return { command: "omp", label: "OMP Monitor Agent" };
}

/** Parse and normalize model JSON, dropping unknown fields and unsafe scopes. */
export function parseMonitorOutput(
  stdout: string,
  scope?: MonitorScope,
): MonitorResult {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_AGENT_OUTPUT_BYTES) {
    return monitorFailure("Monitor returned output outside the bounded JSON limit.");
  }
  try {
    return normalizeMonitorOutput(JSON.parse(stdout.trim()) as unknown, scope);
  } catch {
    return monitorFailure("Monitor returned malformed JSON.");
  }
}

export function normalizeMonitorOutput(
  value: unknown,
  scope?: MonitorScope,
): MonitorResult {
  if (!isRecord(value) || !Array.isArray(value.summaries) || !Array.isArray(value.wikiTasks) || !Array.isArray(value.notifications) || typeof value.notes !== "string") {
    return monitorFailure("Monitor returned an invalid result shape.");
  }

  const summaries: MonitorSummary[] = [];
  for (const item of value.summaries) {
    if (summaries.length >= MAX_SUMMARIES) break;
    if (!isRecord(item)) continue;
    const conversationId = boundedRequiredString(item.conversationId, 240);
    const summary = boundedRequiredString(item.summary, MAX_SUMMARY_LENGTH);
    const visibility = item.visibility;
    if (!conversationId || !summary || (visibility !== "private" && visibility !== "shared")) continue;
    const allowedVisibilities = scope?.conversationVisibilities?.get(conversationId);
    if (scope && allowedVisibilities && (!allowedVisibilities.has(visibility) || (visibility === "shared" && allowedVisibilities.has("private")))) continue;
    const channelId = boundedOptionalString(item.channelId, 240);
    if (visibility === "shared") {
      if (!channelId) continue;
      const allowedChannels = scope?.conversationChannels.get(conversationId);
      if (scope && !allowedChannels?.has(channelId)) continue;
    } else if (channelId && scope) {
      const allowedChannels = scope.conversationChannels.get(conversationId);
      if (!allowedChannels?.has(channelId)) continue;
    }
    if (containsForbiddenAction(summary)) continue;
    summaries.push({
      conversationId,
      visibility,
      ...(channelId ? { channelId } : {}),
      summary,
    });
  }

  const wikiTasks: MonitorWikiTask[] = [];
  for (const item of value.wikiTasks) {
    if (wikiTasks.length >= MAX_WIKI_TASKS) break;
    if (!isRecord(item)) continue;
    const task = boundedRequiredString(item.task, MAX_WIKI_TASK_LENGTH);
    if (task && !containsForbiddenAction(task)) wikiTasks.push({ task });
  }

  const notifications: MonitorNotification[] = [];
  for (const item of value.notifications) {
    if (notifications.length >= MAX_NOTIFICATIONS) break;
    if (!isRecord(item)) continue;
    const text = boundedRequiredString(item.text, MAX_NOTIFICATION_TEXT);
    const reason = boundedRequiredString(item.reason, MAX_NOTIFICATION_REASON);
    if (!text || !reason || containsForbiddenAction(text) || containsForbiddenAction(reason)) continue;
    notifications.push({ text, reason });
  }

  const notes = clipString(value.notes, MAX_NOTES_LENGTH);
  return {
    summaries,
    wikiTasks,
    notifications,
    notes: containsForbiddenAction(notes) ? "" : notes,
  };
}

async function runCliMonitorAgent(
  input: MonitorAgentRun,
  deps: MonitorAgentDeps,
): Promise<MonitorResult> {
  const env = deps.env ?? process.env;
  const command = deps.command?.trim()
    ? { command: deps.command.trim(), label: `${deps.command.trim()} Monitor Agent` }
    : resolveMonitorAgentCommand(env, deps.commandAvailable);
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-builtin-tools",
  ];
  const model = resolveAgentModel("monitor", env);
  if (model) args.push("--model", model);
  const thinking = resolveAgentThinking("monitor", env);
  if (thinking) args.push("--thinking", thinking);
  args.push(buildMonitorPrompt(input));

  const timeoutMs = monitorTimeoutMs(deps.timeoutMs, env);
  const processEnv = deps.env ? { ...process.env, ...deps.env } : undefined;
  const result = await runAgentProcess({
    command: command.command,
    args,
    cwd: deps.cwd ?? process.cwd(),
    label: command.label,
    timeoutMs,
    signal: input.signal,
    env: processEnv,
    maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
  });
  if (result.timedOut) return monitorFailure(`${command.label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
  if (result.cancelled) return monitorFailure(`${command.label} was cancelled before returning JSON.`);
  if (result.outputLimited) return monitorFailure(`${command.label} exceeded its bounded output limit.`);
  if (result.code !== 0) {
    const detail = clipString(result.stderr, 500);
    return monitorFailure(`${command.label} exited with code ${String(result.code)}.${detail ? ` ${detail}` : ""}`);
  }
  return parseMonitorOutput(result.stdout);
}

function normalizeEvents(value: unknown): ContextEventInput[] {
  if (!Array.isArray(value)) return [];
  const events: ContextEventInput[] = [];
  for (const item of value) {
    if (events.length >= MAX_INPUT_EVENTS) break;
    if (isNormalizedEvent(item)) events.push(item);
  }
  return events;
}

function isNormalizedEvent(value: unknown): value is ContextEventInput {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || typeof value.kind !== "string" || typeof value.occurredAt !== "number" || !Number.isFinite(value.occurredAt) || !isRecord(value.source) || !isRecord(value.content)) return false;
  return typeof value.source.conversationId === "string" && value.source.conversationId.trim() !== "" && (value.source.visibility === "private" || value.source.visibility === "shared") && typeof value.source.surface === "string";
}

function compactEvent(event: ContextEventInput): Record<string, unknown> {
  const content = event.content;
  return {
    id: clipString(event.id, 240),
    kind: event.kind,
    occurredAt: event.occurredAt,
    source: {
      surface: event.source.surface,
      principalId: clipString(event.source.principalId, 240),
      conversationId: clipString(event.source.conversationId, 240),
      visibility: event.source.visibility,
      workspaceId: clipString(event.source.workspaceId, 240),
      channelId: clipString(event.source.channelId, 240),
      threadId: clipString(event.source.threadId, 240),
    },
    content: {
      text: clipString(content.text, MAX_EVENT_TEXT),
      prompt: clipString(content.prompt, MAX_EVENT_TEXT),
      assistant: compactUnknown(content.assistant),
      toolResults: compactUnknown(content.toolResults),
      resource: clipString(content.resource, 240),
      resourceId: clipString(content.resourceId, 240),
    },
  };
}

function compactUnknown(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return clipString(JSON.stringify(value), MAX_EVENT_TEXT);
  } catch {
    return "[unserializable]";
  }
}

function makeScope(events: readonly ContextEventInput[]): MonitorScope {
  const conversations = new Set<string>();
  const conversationChannels = new Map<string, Set<string>>();
  const conversationVisibilities = new Map<string, Set<"private" | "shared">>();
  for (const event of events) {
    const conversationId = event.source.conversationId;
    conversations.add(conversationId);
    const visibilities = conversationVisibilities.get(conversationId) ?? new Set<"private" | "shared">();
    visibilities.add(event.source.visibility);
    conversationVisibilities.set(conversationId, visibilities);
    if (event.source.channelId) {
      const channels = conversationChannels.get(conversationId) ?? new Set<string>();
      channels.add(event.source.channelId);
      conversationChannels.set(conversationId, channels);
    }
  }
  return { conversations, conversationChannels, conversationVisibilities };
}

function monitorTimeoutMs(requested: number | undefined, env: Record<string, string | undefined>): number {
  const configured = Number(env.ANORVIS_MONITOR_AGENT_TIMEOUT_MS);
  const candidate = requested ?? (Number.isFinite(configured) ? configured : DEFAULT_TIMEOUT_MS);
  return Number.isFinite(candidate) && candidate > 0 ? Math.min(candidate, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function commandExists(command: string): boolean {
  const shell = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  return spawnSync(shell, args, { stdio: "ignore", shell: process.platform !== "win32" }).status === 0;
}

function monitorFailure(message: string): MonitorResult {
  return { ...EMPTY_RESULT, notes: clipString(`Monitor unavailable: ${message}`, MAX_NOTES_LENGTH) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unexpected failure";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedRequiredString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function boundedOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function clipString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function containsForbiddenAction(value: string): boolean {
  return /github|pull\s*request|code[- ]change|repair(?:\s+ticket)?|\bmaintainer\b/i.test(value);
}
