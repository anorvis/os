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
const DEFAULT_LEASE_MS = 120_000;

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
    if (this.started) return;
    this.stopped = false;
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
    const events = claimed.map((entry) => entry.event);
    const priorSummaries = await this.loadPriorSummaries();
    const priorNotes = priorSummaries.map((summary) => summary.summary.trim()).filter(Boolean).join("\n").slice(-8_000);
    const result = await runMonitorAgent(
      { events, priorNotes, signal: undefined },
      this.options.monitorAgent ? { monitorAgent: this.options.monitorAgent, now: this.options.now() } : { now: this.options.now() },
    );
    if (result.notes.startsWith("Monitor unavailable:")) throw new Error(result.notes);
    await this.persistResult(result, events, priorSummaries);
    for (const entry of claimed) {
      await this.options.contextClient.ack({
        consumer: this.options.consumer,
        eventIds: [entry.event.id],
        claimToken: entry.claimToken,
      });
    }
  }
  private async loadPriorSummaries(): Promise<ContextCompileResult["summaries"]> {
    const compiled = await this.options.contextClient.compile({
      scope: { kind: "owner" },
      limit: this.options.batchSize,
    }) as ContextCompileResult;
    return compiled.summaries;
  }

  private async persistResult(
    result: MonitorResult,
    events: readonly ContextEventRecord[],
    priorSummaries: Readonly<ContextCompileResult["summaries"]>,
  ): Promise<void> {
    const aggregates = new Map<string, { workspaceId?: string; scope: ContextScopeRequest; values: string[] }>();
    const effectiveWorkspaceId = events.find((event) => event.source.workspaceId)?.source.workspaceId;
    const add = (scope: ContextScopeRequest, workspaceId: string | undefined, value: string): void => {
      const text = value.trim();
      if (!text) return;
      const effectiveWorkspace = workspaceId ?? effectiveWorkspaceId;
      const key = `${scope.kind}:${effectiveWorkspace ?? ""}:${scope.channelId ?? ""}`;
      const prior = aggregates.get(key);
      if (prior) {
        if (scope.kind === "owner" && !prior.scope.ownerId && scope.ownerId) {
          prior.scope = { ...prior.scope, ownerId: scope.ownerId };
        }
        if (!prior.values.includes(text)) prior.values.push(text);
      } else {
        aggregates.set(key, { scope, ...(effectiveWorkspace ? { workspaceId: effectiveWorkspace } : {}), values: [text] });
      }
    };
    for (const summary of priorSummaries) {
      if (summary.scopeKind === "channel" && summary.channelId) {
        add({ kind: "channel", channelId: summary.channelId }, effectiveWorkspaceId, summary.summary);
      } else if (summary.scopeKind === "owner" || summary.visibility === "private") {
        add({ kind: "owner", ...(summary.scopeId ? { ownerId: summary.scopeId } : {}) }, effectiveWorkspaceId, summary.summary);
      }
    }
    for (const summary of result.summaries) {
      const source = events.find((event) =>
        event.source.conversationId === summary.conversationId &&
        event.source.visibility === summary.visibility &&
        (!summary.channelId || event.source.channelId === summary.channelId)
      );
      if (summary.visibility === "private") {
        add(
          { kind: "owner", ...(source?.source.principalId ? { ownerId: source.source.principalId } : {}) },
          source?.source.workspaceId,
          summary.summary,
        );
      } else {
        const channelId = summary.channelId ?? source?.source.channelId;
        if (channelId) add({ kind: "channel", channelId }, source?.source.workspaceId, summary.summary);
      }
    }
    const owner = events.find((event) => event.source.visibility === "private");
    if (result.notes.trim()) {
      add(
        { kind: "owner", ...(owner?.source.principalId ? { ownerId: owner.source.principalId } : {}) },
        owner?.source.workspaceId,
        result.notes,
      );
    }
    const updatedAt = this.options.now().getTime();
    for (const aggregate of aggregates.values()) {
      await this.options.contextClient.saveSummary({
        ...(aggregate.workspaceId ? { workspaceId: aggregate.workspaceId } : {}),
        scope: aggregate.scope,
        summary: aggregate.values.join("\n").slice(-8_000),
        updatedAt,
      });
    }
    for (const task of result.wikiTasks) {
      if (this.options.wikiAgent) await this.options.wikiAgent(task.task);
      else await runWikiAgent({ task: task.task });
    }
    const destinations = this.options.ownerDestinations.filter((destination) => destination.visibility === "private");
    const batchIdentity = events.map((event) => event.id).sort().join(",");
    for (const [index, notification] of result.notifications.entries()) {
      for (const destination of destinations) {
        const id = deterministicId("monitor-notification", `${this.options.consumer}:${batchIdentity}:${index}:${notification.text}:${destination.workspaceId ?? ""}:${destination.channelId}:${destination.threadId ?? ""}`);
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
    if (this.started) return;
    this.stopped = false;
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
        await this.complete(row, false, true, `No adapter registered for ${row.destination.surface}`);
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

type DiscordReplayClient = ContextCapabilityClient & Partial<Pick<ContextRuntimeClient, "claim" | "ack">>;

export type DiscordContextRuntimeOptions = {
  contextClient: DiscordReplayClient;
  adapter: ChannelAdapter;
  bindings: readonly ChannelBinding[];
  conversation?: ContextConversationRunner;
  conversationDeps?: Omit<ContextConversationDeps, "conversation">;
  contextLimit?: number;
  consumer?: string;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  now?: () => Date;
};

/** Authorize Discord messages, persist replies, and replay durable events in order. */
export class DiscordContextRuntime {
  private readonly options: Required<Pick<DiscordContextRuntimeOptions, "contextLimit" | "consumer" | "intervalMs" | "batchSize" | "leaseMs" | "now">> & DiscordContextRuntimeOptions;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly completed = new Set<string>();
  private started = false;
  private stopping = false;
  private adapterStarted = false;
  private replayTimer: Timer | undefined;
  private replaying = false;
  private activeReplay: Promise<void> | undefined;
  constructor(options: DiscordContextRuntimeOptions) {
    this.options = {
      ...options,
      contextLimit: Math.min(200, Math.max(1, options.contextLimit ?? 50)),
      consumer: options.consumer ?? "os-discord-replay",
      intervalMs: Math.max(250, options.intervalMs ?? DEFAULT_INTERVAL_MS),
      batchSize: Math.min(100, Math.max(1, options.batchSize ?? 20)),
      leaseMs: Math.min(86_400_000, Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS)),
      now: options.now ?? (() => new Date()),
    };
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.stopping = false;
    this.started = true;
    try {
      await this.options.adapter.start((message) => this.receive(message));
      this.adapterStarted = true;
      this.armReplayTimer(0);
      await this.replay();
    } catch (error) {
      this.started = false;
      this.stopping = true;
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
      if (this.adapterStarted) {
        this.adapterStarted = false;
        await this.options.adapter.stop().catch(() => undefined);
      }
      throw error;
    }
  }
  async stopInbound(): Promise<void> {
    if (this.stopping && !this.started) {
      await this.activeReplay;
      await Promise.allSettled(this.tails.values());
      return;
    }
    this.stopping = true;
    this.started = false;
    clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    await this.activeReplay;
    await Promise.allSettled(this.tails.values());
    this.tails.clear();
  }
  async stopAdapter(): Promise<void> {
    if (!this.adapterStarted) return;
    this.adapterStarted = false;
    await this.options.adapter.stop();
  }
  async stop(): Promise<void> {
    await this.stopInbound();
    await this.stopAdapter();
  }
  async receive(message: InboundChannelMessage): Promise<void> {
    if (this.stopping) return;
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
    const workspaceId = message.authorization.contextScope.workspaceId;
    const source = {
      surface: "discord" as const,
      principalId: message.authorization.principalId,
      conversationId: keyForMessage(message),
      visibility: message.destination.visibility,
      ...(workspaceId ? { workspaceId } : {}),
      ...(message.destination.channelId ? { channelId: message.destination.channelId } : {}),
      ...(message.destination.threadId ? { threadId: message.destination.threadId } : {}),
    };
    const inbound: ContextAppendRequest = {
      ...(workspaceId ? { workspaceId } : {}),
      id: deterministicId("discord-event", message.id),
      kind: "conversation_turn",
      occurredAt: message.occurredAt,
      source,
      content: { text: message.text, prompt: message.text, resourceId: message.id },
    };
    await this.options.contextClient.append(inbound);
    await this.processEvent(inbound, scopeRequest(message), message.destination, message.replyToId);
  }
  private async processEvent(
    inbound: ContextEventRecord,
    scope: ContextScopeRequest,
    destination: ChannelDestination,
    replyToId?: string,
  ): Promise<void> {
    const text = inbound.content.text ?? inbound.content.prompt ?? "";
    const compiled = await this.options.contextClient.compile({
      scope,
      query: text.slice(0, 2_000),
      limit: this.options.contextLimit,
    }) as ContextCompileResult;
    const originalId = typeof inbound.content.resourceId === "string" ? inbound.content.resourceId : inbound.id;
    const replyEventId = deterministicId("discord-turn", originalId);
    const priorReply = compiled.events.find((event) => event.id === replyEventId);
    let reply = typeof priorReply?.content.assistant === "string"
      ? priorReply.content.assistant
      : typeof priorReply?.content.text === "string"
        ? priorReply.content.text
        : undefined;
    if (!reply) {
      reply = await runContextConversation({ text, compiledContext: compiled, now: this.options.now() }, {
        ...(this.options.conversation ? { conversation: this.options.conversation } : {}),
        ...this.options.conversationDeps,
      });
      await this.options.contextClient.append({
        ...(inbound.workspaceId ? { workspaceId: inbound.workspaceId } : {}),
        id: replyEventId,
        kind: "agent_action",
        occurredAt: this.options.now().getTime(),
        source: inbound.source,
        content: { text: reply, prompt: text, assistant: reply },
      });
    }
    const outboundId = deterministicId("discord-reply", originalId);
    await this.options.contextClient.enqueueOutbound({
      ...(inbound.workspaceId ? { workspaceId: inbound.workspaceId } : {}),
      id: outboundId,
      destination: {
        surface: "discord",
        channelId: destination.channelId,
        ...(destination.threadId ? { threadId: destination.threadId } : {}),
      },
      text: reply,
      ...(replyToId ? { replyToId } : {}),
    });
    this.completed.add(originalId);
  }
  private replayAllowed(event: ContextEventRecord): boolean {
    return this.options.bindings.some((binding) => {
      if (binding.workspaceId && event.source.workspaceId && binding.workspaceId !== event.source.workspaceId) return false;
      if (event.source.visibility === "private") {
        return binding.ownerId === event.source.principalId || (!binding.ownerId && !binding.channelId);
      }
      return Boolean(binding.channelId && binding.channelId === event.source.channelId);
    });
  }
  private async replay(): Promise<void> {
    const client = this.options.contextClient;
    if (!client.claim || !client.ack || this.replaying || this.stopping) return;
    const claim = client.claim.bind(client);
    const ack = client.ack.bind(client);
    this.replaying = true;
    const run = this.replayBatch(claim, ack).catch(() => {
      // Leave the claim leased for replay after a transient failure.
    });
    this.activeReplay = run;
    try {
      await run;
    } finally {
      this.activeReplay = undefined;
      this.replaying = false;
    }
  }
  private async replayBatch(
    claim: NonNullable<DiscordReplayClient["claim"]>,
    ack: NonNullable<DiscordReplayClient["ack"]>,
  ): Promise<void> {
    for (const scope of replayScopes(this.options.bindings)) {
      const claimed = await claim({
        scope,
        consumer: this.options.consumer,
        limit: this.options.batchSize,
        leaseMs: this.options.leaseMs,
        surface: "discord",
        kind: "conversation_turn",
      });
      for (const entry of claimed) {
        if (!this.replayAllowed(entry.event) || (entry.event.kind === "conversation_turn" && entry.event.content.assistant !== undefined)) {
          await ack({ consumer: this.options.consumer, eventIds: [entry.event.id], claimToken: entry.claimToken });
          continue;
        }
        const destination: ChannelDestination = {
          visibility: entry.event.source.visibility,
          ...(entry.event.source.workspaceId ? { workspaceId: entry.event.source.workspaceId } : {}),
          channelId: entry.event.source.channelId ?? "",
          ...(entry.event.source.threadId ? { threadId: entry.event.source.threadId } : {}),
        };
        if (!destination.channelId) continue;
        const eventScope = entry.event.source.visibility === "private"
          ? { kind: "owner" as const, ...(entry.event.source.principalId ? { ownerId: entry.event.source.principalId } : {}), ...(entry.event.source.workspaceId ? { workspaceId: entry.event.source.workspaceId } : {}) }
          : { kind: "channel" as const, channelId: destination.channelId, ...(entry.event.source.workspaceId ? { workspaceId: entry.event.source.workspaceId } : {}) };
        await this.processEvent(entry.event, eventScope, destination, typeof entry.event.content.resourceId === "string" ? entry.event.content.resourceId : undefined);
        await ack({ consumer: this.options.consumer, eventIds: [entry.event.id], claimToken: entry.claimToken });
      }
    }
  }
  private armReplayTimer(delay = this.options.intervalMs): void {
    if (!this.started || this.stopping) return;
    this.replayTimer = setTimeout(() => {
      this.replayTimer = undefined;
      void this.replay().finally(() => this.armReplayTimer());
    }, delay);
  }
}

export function createDiscordContextRuntime(options: DiscordContextRuntimeOptions): DiscordContextRuntime {
  return new DiscordContextRuntime(options);
}
function replayScopes(bindings: readonly ChannelBinding[]): ContextScopeRequest[] {
  const scopes: ContextScopeRequest[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const scope: ContextScopeRequest = binding.ownerId
      ? { kind: "owner", ownerId: binding.ownerId, ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}) }
      : binding.channelId
        ? { kind: "channel", channelId: binding.channelId, ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}) }
        : binding.workspaceId
          ? { kind: "workspace", workspaceId: binding.workspaceId }
          : { kind: "owner" };
    const key = `${scope.kind}:${scope.ownerId ?? ""}:${scope.workspaceId ?? ""}:${scope.channelId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      scopes.push(scope);
    }
  }
  return scopes;
}


function scopeRequest(message: AuthorizedChannelMessage): ContextScopeRequest {
  const scope = message.authorization.contextScope;
  if (scope.kind === "owner") return { kind: "owner", ownerId: scope.ownerId, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) };
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
