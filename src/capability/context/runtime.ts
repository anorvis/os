import { createHash } from "node:crypto";
import { runWikiAgent } from "../../llm-wiki";
import { runMonitorAgent, type MonitorAgentRunner, type MonitorResult } from "./monitor-agent";
import type {
  ContextAckRequest,
  ContextAppendRequest,
  ContextCapabilityClient,
  ContextClaimMonitorWikiEffectsRequest,
  ContextClaimFence,
  ContextClaimOutboundRequest,
  ContextClaimRequest,
  ContextClaimedEvent,
  ContextCompileResult,
  ContextCompleteMonitorWikiEffectRequest,
  ContextCompleteOutboundRequest,
  ContextEventRecord,
  ContextMonitorWikiJob,
  ContextMonitorEffectRequest,
  ContextMonitorEffectResult,
  ContextOutboundRecord,
  ContextRenewClaimRequest,
  ContextScopeRequest,
  ContextSummaryRequest,
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
  renewClaim(input: ContextRenewClaimRequest): Promise<{
    claims: readonly ContextClaimFence[];
    leaseUntil: number;
  }>;
  claimMonitorWikiEffects(input: ContextClaimMonitorWikiEffectsRequest): Promise<readonly ContextMonitorWikiJob[]>;
  completeMonitorWikiEffect(input: ContextCompleteMonitorWikiEffectRequest): Promise<ContextMonitorEffectResult>;
  commitMonitorEffect(input: ContextMonitorEffectRequest): Promise<ContextMonitorEffectResult>;
};

type Timer = ReturnType<typeof setTimeout>;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_LEASE_MS = 300_000;

export type OwnerNotificationDestination = ChannelDestination & {
  surface: "pi" | "discord" | "web" | "sms" | "integration" | "system";
};

export type ContextMonitorRuntimeOptions = {
  contextClient: ContextRuntimeClient;
  consumer?: string;
  workspaceId?: string;
  intervalMs?: number;
  batchSize?: number;
  leaseMs?: number;
  ownerDestinations?: readonly OwnerNotificationDestination[];
  monitorAgent?: MonitorAgentRunner;
  wikiAgent?: (task: string) => Promise<unknown>;
  now?: () => Date;
};

type MonitorPartition = {
  key: string;
  visibility: "private" | "shared";
  workspaceId?: string;
  scope: ContextScopeRequest;
  batchId?: string;
  claimed: readonly ContextClaimedEvent[];
  priorSummaries: ContextCompileResult["summaries"];
};

/** Drain context through one isolated Monitor invocation per durable output scope. */
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
    try {
      await this.drainWikiEffects();
      await this.drain();
      this.armTimer();
    } catch (error) {
      this.started = false;
      this.stopped = true;
      throw error;
    }
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
      // A failed fenced effect leaves every claim retryable.
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
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      scope: { kind: "owner" },
      consumer: this.options.consumer,
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
    });
    if (!claimed.length) return;
    const heartbeat = this.startHeartbeat(claimed);
    try {
      const partitions = this.partitionClaims(claimed);
      for (const partition of partitions) {
        heartbeat.check();
        partition.priorSummaries = await this.loadPriorSummaries(partition);
        const events = partition.claimed.map((entry) => entry.event);
        const priorNotes = partition.priorSummaries
          .map((summary) => summary.summary.trim())
          .filter(Boolean)
          .join("\n")
          .slice(-8_000);
        const result = await runMonitorAgent(
          { events, priorNotes, signal: undefined },
          this.options.monitorAgent
            ? { monitorAgent: this.options.monitorAgent, now: this.options.now() }
            : { now: this.options.now() },
        );
        if (result.notes.startsWith("Monitor unavailable:")) throw new Error(result.notes);
        heartbeat.check();
        await this.persistResult(result, partition);
        heartbeat.check();
      }
      await this.drainWikiEffects();
      heartbeat.check();
      for (const partition of partitions) {
        heartbeat.check();
        const claims = await this.renew(partition);
        for (const entry of partition.claimed) {
          const claim = claims.find((item) => item.eventId === entry.event.id);
          await this.options.contextClient.ack({
            ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
            consumer: this.options.consumer,
            eventIds: [entry.event.id],
            claimToken: claim?.claimToken ?? entry.claimToken,
          });
        }
      }
    } finally {
      await heartbeat.stop();
    }
  }

  private startHeartbeat(claimed: readonly ContextClaimedEvent[]) {
    let timer: Timer | undefined;
    let pending: Promise<unknown> | undefined;
    let stopped = false;
    let failed = false;
    let failure: unknown;
    const tick = (): void => {
      if (stopped) return;
      pending = (pending ?? Promise.resolve()).then(async () => {
        if (stopped || failed) return;
        await this.renewClaims(claimed);
      }).catch((error: unknown) => {
        failed = true;
        failure ??= error;
      });
      timer = setTimeout(tick, Math.max(250, Math.floor(this.options.leaseMs / 3)));
    };
    timer = setTimeout(tick, Math.max(250, Math.floor(this.options.leaseMs / 3)));
    return {
      check: (): void => {
        if (failed) throw failure;
      },
      stop: async (): Promise<void> => {
        stopped = true;
        clearTimeout(timer);
        await pending;
        if (failed) throw failure;
      },
    };
  }

  private async renewClaims(claimed: readonly ContextClaimedEvent[]): Promise<readonly ContextClaimFence[]> {
    const renew = this.options.contextClient.renewClaim;
    const fences = claimed.map((entry) => ({ eventId: entry.event.id, claimToken: entry.claimToken }));
    if (typeof renew !== "function" || fences.length === 0) return fences;
    const grouped = new Map<string, ContextClaimedEvent[]>();
    for (const entry of claimed) {
      const workspaceId = entry.event.workspaceId ?? entry.event.source.workspaceId ?? this.options.workspaceId ?? "";
      const group = grouped.get(workspaceId) ?? [];
      group.push(entry);
      grouped.set(workspaceId, group);
    }
    const renewed: ContextClaimFence[] = [];
    for (const [workspaceId, entries] of grouped) {
      const result = await renew.call(this.options.contextClient, {
        ...(workspaceId ? { workspaceId } : {}),
        consumer: this.options.consumer,
        claims: entries.map((entry) => ({ eventId: entry.event.id, claimToken: entry.claimToken })),
        leaseMs: this.options.leaseMs,
      });
      renewed.push(...result.claims);
    }
    return renewed;
  }

  private partitionClaims(claimed: readonly ContextClaimedEvent[]): MonitorPartition[] {
    const partitions = new Map<string, MonitorPartition>();
    for (const entry of claimed) {
      const event = entry.event;
      const eventWorkspaceId = event.workspaceId ?? event.source.workspaceId;
      if (this.options.workspaceId && eventWorkspaceId && eventWorkspaceId !== this.options.workspaceId) {
        throw new Error("Monitor claim belongs to a different workspace.");
      }
      const workspaceId = eventWorkspaceId ?? this.options.workspaceId;
      const ownerId = event.ownerId ?? event.source.principalId;
      const channelId = event.source.channelId;
      const visibility = event.source.visibility;
      const scope: ContextScopeRequest = visibility === "private"
        ? { kind: "owner", ...(ownerId ? { ownerId } : {}) }
        : channelId
          ? { kind: "channel", channelId }
          : { kind: "workspace" };
      const scopeId = scope.kind === "owner"
        ? (scope.ownerId ?? "")
        : scope.kind === "channel"
          ? (scope.channelId ?? "")
          : "";
      const batchId = entry.batchId;
      const key = `${visibility}:${scope.kind}:${workspaceId ?? ""}:${scopeId}:${batchId ?? ""}`;
      const prior = partitions.get(key);
      if (prior) {
        (prior.claimed as ContextClaimedEvent[]).push(entry);
        continue;
      }
      partitions.set(key, {
        key,
        visibility,
        ...(batchId ? { batchId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        scope,
        claimed: [entry],
        priorSummaries: [],
      });
    }
    return [...partitions.values()];
  }

  private async loadPriorSummaries(partition: MonitorPartition): Promise<ContextCompileResult["summaries"]> {
    const compiled = await this.options.contextClient.compile({
      ...(partition.workspaceId ? { workspaceId: partition.workspaceId } : {}),
      scope: partition.scope,
      limit: 200,
    }) as ContextCompileResult;
    return compiled.summaries.filter((summary) => {
      if (partition.visibility === "private") {
        return summary.visibility === "private"
          && (partition.scope.ownerId === undefined || summary.scopeId === partition.scope.ownerId);
      }
      if (partition.scope.kind === "channel") {
        return summary.visibility === "shared" && summary.channelId === partition.scope.channelId;
      }
      return summary.visibility === "shared" && !summary.channelId;
    });
  }

  private async renew(partition: MonitorPartition): Promise<readonly ContextClaimFence[]> {
    return this.renewClaims(partition.claimed);
  }

  private async commitEffect(request: ContextMonitorEffectRequest, partition: MonitorPartition): Promise<ContextMonitorEffectResult> {
    const claims = await this.renew(partition);
    const fenced = { ...request, claims };
    const commit = this.options.contextClient.commitMonitorEffect;
    if (typeof commit === "function") return commit.call(this.options.contextClient, fenced);
    return { effectKey: request.effectKey, status: "completed" };
  }
  private async drainWikiEffects(): Promise<void> {
    const claimJobs = this.options.contextClient.claimMonitorWikiEffects;
    const completeJob = this.options.contextClient.completeMonitorWikiEffect;
    if (typeof claimJobs !== "function" || typeof completeJob !== "function") return;
    const jobs = await claimJobs.call(this.options.contextClient, {
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      consumer: `${this.options.consumer}:wiki`,
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
    });
    for (const job of jobs) {
      try {
        const result = this.options.wikiAgent
          ? await this.options.wikiAgent(job.wikiTask)
          : await runWikiAgent({ task: job.wikiTask });
        await completeJob.call(this.options.contextClient, {
          ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
          consumer: `${this.options.consumer}:wiki`,
          effectKey: job.effectKey,
          jobClaimToken: job.jobClaimToken,
          success: true,
          result: JSON.stringify(result).slice(-2_000),
        });
      } catch (error) {
        await completeJob.call(this.options.contextClient, {
          ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
          consumer: `${this.options.consumer}:wiki`,
          effectKey: job.effectKey,
          jobClaimToken: job.jobClaimToken,
          success: false,
          error: error instanceof Error ? error.message.slice(-2_000) : String(error).slice(-2_000),
        });
        throw error;
      }
    }
  }

  private async persistResult(result: MonitorResult, partition: MonitorPartition): Promise<void> {
    const events = partition.claimed.map((entry) => entry.event);
    const batchId = partition.batchId ?? partition.claimed[0]?.batchId ?? events[0]?.id ?? "empty";
    const values = partition.priorSummaries
      .map((summary) => summary.summary.trim())
      .filter(Boolean);
    const conversations = new Set(events.map((event) => event.source.conversationId));
    for (const summary of result.summaries) {
      if (summary.visibility !== partition.visibility || !conversations.has(summary.conversationId)) continue;
      if (partition.scope.kind === "channel" && summary.channelId !== partition.scope.channelId) continue;
      if (partition.visibility === "shared" && partition.scope.kind !== "channel" && summary.channelId) continue;
      if (!values.includes(summary.summary.trim())) values.push(summary.summary.trim());
    }
    if (result.notes.trim() && !values.includes(result.notes.trim())) values.push(result.notes.trim());
    const summary = values.filter(Boolean).join("\n").slice(-8_000);
    if (summary) {
      const effectKey = deterministicId("monitor-summary", `${this.options.consumer}:${batchId}:${partition.key}:summary`);
      const request: ContextMonitorEffectRequest = {
        ...(partition.workspaceId ? { workspaceId: partition.workspaceId } : {}),
        consumer: this.options.consumer,
        effectKey,
        kind: "summary",
        claims: [],
        scope: partition.scope,
        summary,
      };
      if (typeof this.options.contextClient.commitMonitorEffect === "function") {
        await this.commitEffect(request, partition);
      } else {
        await this.options.contextClient.saveSummary({
          ...(partition.workspaceId ? { workspaceId: partition.workspaceId } : {}),
          scope: partition.scope,
          summary,
          updatedAt: this.options.now().getTime(),
        });
      }
    }
    for (const [index, task] of result.wikiTasks.entries()) {
      const effectKey = deterministicId("monitor-wiki", `${this.options.consumer}:${batchId}:${partition.key}:${index}`);
      const request: ContextMonitorEffectRequest = {
        ...(partition.workspaceId ? { workspaceId: partition.workspaceId } : {}),
        consumer: this.options.consumer,
        effectKey,
        kind: "wiki",
        claims: [],
        scope: partition.scope,
        wikiTask: task.task,
      };
      const hasWikiJobs = typeof this.options.contextClient.claimMonitorWikiEffects === "function"
        && typeof this.options.contextClient.completeMonitorWikiEffect === "function";
      if (typeof this.options.contextClient.commitMonitorEffect === "function" && hasWikiJobs) {
        await this.commitEffect(request, partition);
      } else if (this.options.wikiAgent) {
        await this.renew(partition);
        await this.options.wikiAgent(task.task);
      } else {
        await this.renew(partition);
        await runWikiAgent({ task: task.task });
      }
    }
    const destinations = this.options.ownerDestinations.filter((destination) => destination.visibility === "private");
    for (const [index, notification] of result.notifications.entries()) {
      for (const destination of destinations) {
        const effectKey = deterministicId("monitor-notification", `${this.options.consumer}:${batchId}:${partition.key}:${index}:${destination.workspaceId ?? ""}:${destination.channelId}:${destination.threadId ?? ""}`);
        const outbound = {
          destination: {
            surface: destination.surface,
            channelId: destination.channelId,
            ...(destination.threadId ? { threadId: destination.threadId } : {}),
          },
          text: notification.text,
        };
        const request: ContextMonitorEffectRequest = {
          ...(partition.workspaceId ? { workspaceId: partition.workspaceId } : {}),
          consumer: this.options.consumer,
          effectKey,
          kind: "notification",
          claims: [],
          scope: partition.scope,
          notification: outbound,
        };
        if (typeof this.options.contextClient.commitMonitorEffect === "function") {
          await this.commitEffect(request, partition);
        } else {
          await this.renew(partition);
          await this.options.contextClient.enqueueOutbound({
            id: effectKey,
            ...(destination.workspaceId ? { workspaceId: destination.workspaceId } : {}),
            ...outbound,
          });
        }
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
  workspaceId?: string;
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
    const rows = await this.options.contextClient.claimOutbound({
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      consumer: this.options.consumer,
      limit: this.options.batchSize,
      leaseMs: this.options.leaseMs,
    });
    for (const row of rows) {
      if (this.options.workspaceId && row.workspaceId !== this.options.workspaceId) {
        throw new Error("Outbound claim workspace mismatch");
      }
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
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
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
    if (this.stopping) throw new Error("Discord context runtime is stopping");
    const authorized = authorizeChannelMessage(message, this.options.bindings);
    if (!authorized) return;
    const key = conversationKey(authorized);
    await this.enqueueConversation(key, () => this.process(authorized));
  }

  private async enqueueConversation(key: string, task: () => Promise<void>): Promise<void> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(task);
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
    const attachments = boundAttachments(message.attachments);
    const inbound: ContextAppendRequest = {
      ...(workspaceId ? { workspaceId } : {}),
      id: deterministicId("discord-event", message.id),
      kind: "conversation_turn",
      occurredAt: message.occurredAt,
      source,
      content: {
        text: message.text,
        prompt: message.text,
        resourceId: message.id,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
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
    const modelText = contextModelText(text, inbound.content.attachments);
    const compiled = await this.options.contextClient.compile({
      scope,
      query: modelText.slice(0, 2_000),
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
      reply = await runContextConversation({ text: modelText, compiledContext: compiled, now: this.options.now() }, {
        ...(this.options.conversation ? { conversation: this.options.conversation } : {}),
        ...this.options.conversationDeps,
      });
      await this.options.contextClient.append({
        ...(inbound.workspaceId ? { workspaceId: inbound.workspaceId } : {}),
        id: replyEventId,
        kind: "agent_action",
        occurredAt: this.options.now().getTime(),
        source: inbound.source,
        content: { text: reply, prompt: modelText, assistant: reply },
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
        const workspaceId = entry.event.workspaceId ?? entry.event.source.workspaceId;
        if (!this.replayAllowed(entry.event) || (entry.event.kind === "conversation_turn" && entry.event.content.assistant !== undefined)) {
          await ack({
            ...(workspaceId ? { workspaceId } : {}),
            consumer: this.options.consumer,
            eventIds: [entry.event.id],
            claimToken: entry.claimToken,
          });
          continue;
        }
        const destination: ChannelDestination = {
          visibility: entry.event.source.visibility,
          ...(workspaceId ? { workspaceId } : {}),
          channelId: entry.event.source.channelId ?? "",
          ...(entry.event.source.threadId ? { threadId: entry.event.source.threadId } : {}),
        };
        if (!destination.channelId) continue;
        const eventScope = entry.event.source.visibility === "private"
          ? { kind: "owner" as const, ...(entry.event.source.principalId ? { ownerId: entry.event.source.principalId } : {}), ...(workspaceId ? { workspaceId } : {}) }
          : { kind: "channel" as const, channelId: destination.channelId, ...(workspaceId ? { workspaceId } : {}) };
        await this.enqueueConversation(
          entry.event.source.conversationId,
          () => this.processEvent(entry.event, eventScope, destination, typeof entry.event.content.resourceId === "string" ? entry.event.content.resourceId : undefined),
        );
        await ack({
          ...(workspaceId ? { workspaceId } : {}),
          consumer: this.options.consumer,
          eventIds: [entry.event.id],
          claimToken: entry.claimToken,
        });
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
const MAX_CONTEXT_ATTACHMENTS = 16;
const MAX_CONTEXT_ATTACHMENT_ID = 256;
const MAX_CONTEXT_ATTACHMENT_NAME = 256;
const MAX_CONTEXT_ATTACHMENT_MEDIA_TYPE = 128;
const MAX_CONTEXT_ATTACHMENT_URL = 4_096;

function boundAttachments(
  attachments: readonly InboundChannelMessage["attachments"][number][],
): Array<{
  id: string;
  name: string;
  mediaType?: string;
  url?: string;
}> {
  return attachments.slice(0, MAX_CONTEXT_ATTACHMENTS).flatMap((attachment, index) => {
    const id = attachment.id.trim().slice(0, MAX_CONTEXT_ATTACHMENT_ID) || `attachment-${index + 1}`;
    const name = attachment.name.trim().slice(0, MAX_CONTEXT_ATTACHMENT_NAME) || `attachment-${index + 1}`;
    if (!id || !name) return [];
    const mediaType = attachment.mediaType?.trim().slice(0, MAX_CONTEXT_ATTACHMENT_MEDIA_TYPE);
    const url = attachment.url?.trim().slice(0, MAX_CONTEXT_ATTACHMENT_URL);
    return [{
      id,
      name,
      ...(mediaType ? { mediaType } : {}),
      ...(url ? { url } : {}),
    }];
  });
}

function contextModelText(
  text: string,
  attachments: ContextEventRecord["content"]["attachments"],
): string {
  if (!attachments?.length) return text;
  const attachmentText = attachments.map((attachment) => [
    `- ${attachment.name}`,
    attachment.mediaType ? `(${attachment.mediaType})` : "",
    attachment.url ? attachment.url : "",
  ].filter(Boolean).join(" ")).join("\n");
  return `${text}${text ? "\n\n" : ""}Attachments:\n${attachmentText}`.slice(0, 8_000);
}
