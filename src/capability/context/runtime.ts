import { createHash } from "node:crypto";
import { runWikiAgent } from "../../llm-wiki";
import { runMonitorAgent, type MonitorAgentRunner, type MonitorResult } from "./monitor-agent";
import type {
  ContextAckRequest,
  ContextAppendRequest,
  ContextCapabilityClient,
  ContextClaimOutboundRequest,
  ContextClaimRequest,
  ContextClaimedEvent,
  ContextCompileRequest,
  ContextCompileResult,
  ContextCompleteOutboundRequest,
  ContextEventRecord,
  ContextOutboundRecord,
  ContextSummaryRequest,
  ContextScopeRequest,
} from "./client";
import { runContextConversation, type ContextConversationDeps, type ContextConversationRunner } from "./conversation";
import { authorizeChannelMessage, type ChannelBinding } from "../../platform/channel/authorization";
import type {
  AuthorizedChannelMessage,
  ChannelAdapter,
  ChannelDestination,
  ChannelReceiver,
  InboundChannelMessage,
} from "../../platform/channel/channel";

export type ContextRuntimeClient = ContextCapabilityClient & {
  claim(input: ContextClaimRequest): Promise<readonly ContextClaimedEvent[]>;
  ack(input: ContextAckRequest): Promise<{ acknowledged: number; cursor: number }>;
  saveSummary(input: ContextSummaryRequest): Promise<{ summaryId?: string; inserted: boolean }>;
  claimOutbound(input: ContextClaimOutboundRequest): Promise<readonly ContextOutboundRecord[]>;
  completeOutbound(input: ContextCompleteOutboundRequest): Promise<{
    id: string;
    status: "completed" | "queued" | "failed";
    attempts: number;
  }>;
};

type Timer = ReturnType<typeof setTimeout>;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LEASE_MS = 30_000;

export type OwnerNotificationDestination = ChannelDestination & {
  surface: "pi" | "discord" | "web" | "sms" | "integration" | "system";
};

export type ContextMonitorRuntimeOptions = {
  contextClient: ContextRuntimeClient;
  consumer?: string;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  ownerDestinations?: readonly OwnerNotificationDestination[];
  monitorAgent?: MonitorAgentRunner;
  wikiAgent?: (task: string) => Promise<unknown>;
  now?: () => Date;
};

/** Drain owner-private context without allowing a failed batch to be acked. */
export class ContextMonitorRuntime {
  private readonly options: Required<Pick<ContextMonitorRuntimeOptions, "consumer" | "intervalMs" | "batchSize" | "leaseMs" | "ownerDestinations" | "now">> & ContextMonitorRuntimeOptions;
  private timer: Timer | undefined;
  private draining = false;
  private started = false;
  private stopped = false;
  private active: Promise<void> | undefined;

  constructor(options: ContextMonitorRuntimeOptions) {
    this.options = {
      ...options,
      consumer: options.consumer ?? "os-monitor",
      intervalMs: Math.max(250, options.intervalMs ?? DEFAULT_INTERVAL_MS),
      batchSize: Math.min(200, Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)),
      leaseMs: Math.min(86_400_000, Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS)),
      ownerDestinations: options.ownerDestinations ?? [],
      now: options.now ?? (() => new Date()),
    };
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.armTimer();
    await this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }

  schedule(): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.armTimer(0);
  }

  async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    const run = this.drainBatch().catch(() => {
      // Leases intentionally remain claimable when any durable effect fails.
    });
    this.active = run;
    try {
      await run;
    } finally {
      this.active = undefined;
      this.draining = false;
    }
  }

  private async drainBatch(): Promise<void> {
    const claimed = await this.options.contextClient.claim({
      scope: { kind: "owner" },
      consumer: this.options.consumer,
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
    });
    if (!claimed.length) return;
    const events = claimed.map((entry) => entry.event as ContextEventRecord);
    const result = await runMonitorAgent(
      { events, priorNotes: "", signal: undefined },
      this.options.monitorAgent ? { monitorAgent: this.options.monitorAgent, now: this.options.now() } : { now: this.options.now() },
    );
    if (result.notes.startsWith("Monitor unavailable:")) throw new Error(result.notes);
    await this.persistResult(result, events);
    await this.options.contextClient.ack({
      consumer: this.options.consumer,
      eventIds: claimed.map((entry) => entry.event.id),
      claimToken: claimed.length === 1 ? claimed[0]?.claimToken : undefined,
    });
  }

  private async persistResult(result: MonitorResult, events: readonly ContextEventRecord[]): Promise<void> {
    for (const summary of result.summaries) {
      const source = events.find((event) => event.source.conversationId === summary.conversationId && event.source.visibility === summary.visibility && (!summary.channelId || event.source.channelId === summary.channelId));
      const scope = summary.visibility === "private"
        ? { kind: "owner" as const, ownerId: source?.source.principalId }
        : { kind: "channel" as const, workspaceId: source?.source.workspaceId, channelId: summary.channelId ?? source?.source.channelId };
      if (scope.kind === "channel" && !scope.channelId) continue;
      await this.options.contextClient.saveSummary({
        workspaceId: source?.source.workspaceId,
        scope,
        summary: summary.summary,
        updatedAt: this.options.now().getTime(),
      });
    }
    if (result.notes.trim()) {
      const owner = events.find((event) => event.source.visibility === "private");
      await this.options.contextClient.saveSummary({
        workspaceId: owner?.source.workspaceId,
        scope: { kind: "owner", ...(owner?.source.principalId ? { ownerId: owner.source.principalId } : {}) },
        summary: result.notes.trim().slice(0, 8_000),
        updatedAt: this.options.now().getTime(),
      });
    }
    for (const task of result.wikiTasks) {
      if (this.options.wikiAgent) await this.options.wikiAgent(task.task);
      else await runWikiAgent({ task: task.task });
    }
    const destinations = this.options.ownerDestinations.filter((destination) => destination.visibility === "private");
    for (const [index, notification] of result.notifications.entries()) {
      for (const destination of destinations) {
        const id = deterministicId("monitor-notification", `${this.options.consumer}:${index}:${notification.text}:${destination.channelId}:${destination.threadId ?? ""}`);
        await this.options.contextClient.enqueueOutbound({
          id,
          workspaceId: destination.workspaceId,
          destination: {
            surface: destination.surface,
            channelId: destination.channelId,
            ...(destination.threadId ? { threadId: destination.threadId } : {}),
          },
          text: notification.text,
        });
      }
    }
  }

  private armTimer(delay = this.options.intervalMs): void {
    if (!this.started || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().finally(() => this.armTimer());
    }, delay);
  }
}

export type OutboundRuntimeOptions = {
  contextClient: ContextRuntimeClient;
  adapters: readonly ChannelAdapter[] | ReadonlyMap<string, ChannelAdapter>;
  consumer?: string;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
};

/** Deliver queued context rows once through their registered channel adapter. */
export class ContextOutboundRuntime {
  private readonly options: Required<Pick<OutboundRuntimeOptions, "consumer" | "intervalMs" | "batchSize" | "leaseMs">> & OutboundRuntimeOptions;
  private readonly adapters: ReadonlyMap<string, ChannelAdapter>;
  private readonly providerResults = new Map<string, string>();
  private timer: Timer | undefined;
  private draining = false;
  private started = false;
  private stopped = false;
  private active: Promise<void> | undefined;
  constructor(options: OutboundRuntimeOptions) {
    this.options = {
      ...options,
      consumer: options.consumer ?? "os-outbound",
      intervalMs: Math.max(250, options.intervalMs ?? DEFAULT_INTERVAL_MS),
      batchSize: Math.min(100, Math.max(1, options.batchSize ?? 20)),
      leaseMs: Math.min(86_400_000, Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS)),
    };
    this.adapters = options.adapters instanceof Map
      ? options.adapters
      : new Map((options.adapters as readonly ChannelAdapter[]).map((adapter: ChannelAdapter) => [adapter.id, adapter] as const));
  }
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.armTimer();
    await this.drain();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }
  async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    const run = this.drainBatch().catch(() => {
      // Keep a failed lease retryable.
    });
    this.active = run;
    try {
      await run;
    } finally {
      this.active = undefined;
      this.draining = false;
    }
  }
  private async drainBatch(): Promise<void> {
    const rows = await this.options.contextClient.claimOutbound({ consumer: this.options.consumer, limit: this.options.batchSize, leaseMs: this.options.leaseMs });
    for (const row of rows) {
      const knownProviderResult = this.providerResults.get(row.id);
      if (knownProviderResult) {
        await this.complete(row, true, false);
        this.providerResults.delete(row.id);
        continue;
      }
      const adapter = this.adapters.get(row.destination.surface);
      if (!adapter) {
        await this.complete(row, false, false, `No adapter registered for ${row.destination.surface}`);
        continue;
      }
      let result;
      try {
        result = await adapter.send({
          visibility: "private",
          workspaceId: row.workspaceId,
          channelId: row.destination.channelId,
          ...(row.destination.threadId ? { threadId: row.destination.threadId } : {}),
        }, {
          id: row.id,
          text: row.text,
          attachments: row.attachments,
          replyToId: row.replyToId,
        });
      } catch (error) {
        await this.complete(row, false, true, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (result.ok) {
        this.providerResults.set(row.id, result.messageId);
        await this.complete(row, true, false);
        this.providerResults.delete(row.id);
      } else {
        await this.complete(row, false, result.retryable, result.error);
      }
    }
  }
  private async complete(row: ContextOutboundRecord, success: boolean, retryable: boolean, error?: string): Promise<void> {
    await this.options.contextClient.completeOutbound({
      id: row.id,
      consumer: this.options.consumer,
      claimToken: row.claimToken,
      success,
      retryable,
      ...(error ? { error } : {}),
    });
  }
  private armTimer(): void {
    if (!this.started || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().finally(() => this.armTimer());
    }, this.options.intervalMs);
  }
}

export type DiscordContextRuntimeOptions = {
  contextClient: ContextCapabilityClient;
  adapter: ChannelAdapter;
  bindings: readonly ChannelBinding[];
  conversation?: ContextConversationRunner;
  conversationDeps?: Omit<ContextConversationDeps, "conversation">;
  contextLimit?: number;
  now?: () => Date;
};

/** Authorize Discord messages and process each origin conversation in order. */
export class DiscordContextRuntime {
  private readonly options: Required<Pick<DiscordContextRuntimeOptions, "contextLimit" | "now">> & DiscordContextRuntimeOptions;
  private readonly tails = new Map<string, Promise<void>>();
  private started = false;
  constructor(options: DiscordContextRuntimeOptions) {
    this.options = { ...options, contextLimit: Math.min(200, Math.max(1, options.contextLimit ?? 50)), now: options.now ?? (() => new Date()) };
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.options.adapter.start((message) => this.receive(message));
  }
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.options.adapter.stop();
    await Promise.allSettled(this.tails.values());
    this.tails.clear();
  }
  async receive(message: InboundChannelMessage): Promise<void> {
    const authorized = authorizeChannelMessage(message, this.options.bindings);
    if (!authorized) return;
    const key = conversationKey(authorized);
    const prior = this.tails.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(() => this.process(authorized));
    this.tails.set(key, current);
    try {
      await current;
    } finally {
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
  private async process(message: AuthorizedChannelMessage): Promise<void> {
    const source = {
      surface: "discord" as const,
      principalId: message.authorization.principalId,
      conversationId: keyForMessage(message),
      visibility: message.destination.visibility,
      ...(message.authorization.contextScope.kind === "channel" && message.authorization.contextScope.workspaceId ? { workspaceId: message.authorization.contextScope.workspaceId } : {}),
      ...(message.destination.channelId ? { channelId: message.destination.channelId } : {}),
      ...(message.destination.threadId ? { threadId: message.destination.threadId } : {}),
    };
    const inbound: ContextAppendRequest = {
      id: deterministicId("discord-event", message.id),
      kind: "conversation_turn",
      occurredAt: message.occurredAt,
      source,
      content: { text: message.text, prompt: message.text },
    };
    const appended = await this.options.contextClient.append(inbound);
    if (isRecord(appended) && appended.inserted === false) return;
    const scope = scopeRequest(message);
    const compiled = await this.options.contextClient.compile({
      scope,
      query: message.text.slice(0, 2_000),
      limit: this.options.contextLimit,
    }) as ContextCompileResult;
    const reply = await runContextConversation({ text: message.text, compiledContext: compiled, now: this.options.now() }, {
      ...(this.options.conversation ? { conversation: this.options.conversation } : {}),
      ...this.options.conversationDeps,
    });
    const sent = await this.options.adapter.send(message.destination, { id: deterministicId("discord-reply", message.id), text: reply, replyToId: message.id });
    if (!sent.ok) throw new Error(sent.error);
    await this.options.contextClient.append({
      id: deterministicId("discord-turn", message.id),
      kind: "conversation_turn",
      occurredAt: this.options.now().getTime(),
      source,
      content: { text: reply, prompt: message.text, assistant: reply },
    });
  }
}

export function createDiscordContextRuntime(options: DiscordContextRuntimeOptions): DiscordContextRuntime {
  return new DiscordContextRuntime(options);
}

function scopeRequest(message: AuthorizedChannelMessage): ContextScopeRequest {
  const scope = message.authorization.contextScope;
  if (scope.kind === "owner") return { kind: "owner", ownerId: scope.ownerId };
  if (scope.kind === "workspace") return { kind: "workspace", workspaceId: scope.workspaceId };
  return { kind: "channel", ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), channelId: scope.channelId };
}
function conversationKey(message: AuthorizedChannelMessage): string {
  return `${message.identity.provider}:${message.identity.accountId}:${message.destination.channelId}:${message.destination.threadId ?? ""}`;
}
function keyForMessage(message: AuthorizedChannelMessage): string {
  return conversationKey(message);
}
function deterministicId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
