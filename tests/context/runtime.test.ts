import { describe, expect, test } from "bun:test";
import type { ContextAckRequest, ContextCapabilityClient, ContextClaimRequest, ContextCompileResult, ContextClaimedEvent, ContextEventRecord, ContextOutboundRecord } from "../../src/capability/context/client";
import { ContextMonitorRuntime, ContextOutboundRuntime, DiscordContextRuntime } from "../../src/capability/context/runtime";
import type { ChannelAdapter, ChannelReceiver, ChannelSendResult, InboundChannelMessage } from "../../src/platform/channel/channel";

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  await promise.then(
    () => {
      throw new Error(`Expected promise to reject with "${message}"`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
    },
  );
}

function fakeClient(log: string[]) {
  let claimed = true;
  const outbound: ContextOutboundRecord[] = [];
  const compileScopes: unknown[] = [];
  const client: ContextCapabilityClient & {
    compileScopes: unknown[];
    outbound: ContextOutboundRecord[];
  } = {
    compileScopes,
    outbound,
    append: (input) => {
      log.push(`append:${input.id}`);
      return Promise.resolve({ inserted: true, id: input.id });
    },
    compile: (input) => {
      compileScopes.push(input.scope);
      return Promise.resolve({ scope: input.scope, events: [], summaries: [], wikiPages: [] } satisfies ContextCompileResult);
    },
    claim: () => {
      if (!claimed) return Promise.resolve([]);
      claimed = false;
      const event: ContextClaimedEvent["event"] = {
        id: "monitor-event",
        kind: "conversation_turn",
        occurredAt: 1,
        source: { surface: "pi", conversationId: "owner-conversation", visibility: "private", principalId: "owner" },
        content: { text: "check" },
      };
      return Promise.resolve([{ event, claimToken: "lease", attempts: 1, leaseUntil: Date.now() + 1_000 }]);
    },
    saveSummary: () => {
      log.push("summary");
      return Promise.resolve({ inserted: true });
    },
    enqueueOutbound: (input) => {
      log.push(`enqueue:${input.id}`);
      const row = { ...input, status: "queued" as const, attempts: 0, claimToken: "out-lease", leaseUntil: Date.now() + 1_000 };
      outbound.push(row);
      return Promise.resolve({ inserted: true, id: input.id });
    },
    claimOutbound: () => Promise.resolve(outbound.splice(0)),
    completeOutbound: (input) => {
      log.push(`complete:${input.id}:${input.retryable === true ? "retry" : input.success === true ? "success" : "failed"}`);
      return Promise.resolve({ id: input.id ?? "", status: "completed" as const, attempts: 1 });
    },
    ack: () => {
      log.push("ack");
      return Promise.resolve({ acknowledged: 1, cursor: 1 });
    },
  };
  return client;
}


class FakeAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  receiver: ChannelReceiver | undefined;
  sent: Array<{ destination: unknown; message: { id: string; text: string; replyToId?: string } }> = [];
  sendResult: ChannelSendResult = { ok: true, messageId: "reply" };
  stopCalls = 0;
  start(receiver: ChannelReceiver) { this.receiver = receiver; return Promise.resolve(); }
  stop() { this.stopCalls += 1; this.receiver = undefined; return Promise.resolve(); }
  send(destination: InboundChannelMessage["destination"], message: { id: string; text: string; replyToId?: string }): Promise<ChannelSendResult> {
    this.sent.push({ destination, message });
    return Promise.resolve(this.sendResult);
  }
}

describe("context live runtimes", () => {
  test("Discord inbound compiles the exact owner scope and persists the reply", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const appendedInputs: unknown[] = [];
    const append = client.append.bind(client);
    client.append = (input) => {
      appendedInputs.push(input);
      return append(input);
    };
    const adapter = new FakeAdapter();
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner", workspaceId: "workspace" }],
      conversation: () => Promise.resolve("owner reply"),
    });
    await runtime.start();
    await runtime.receive({
      id: "discord-message",
      identity: { provider: "discord", accountId: "bot", userId: "owner-user" },
      destination: { visibility: "private", channelId: "dm", threadId: "thread" },
      text: "hello",
      occurredAt: 2,
      attachments: [],
    });
    expect(client.compileScopes).toEqual([{ kind: "owner", ownerId: "owner", workspaceId: "workspace" }]);
    expect(appendedInputs[0]).toMatchObject({ workspaceId: "workspace", source: { workspaceId: "workspace" } });
    expect(client.outbound[0]?.destination).toEqual({ surface: "discord", channelId: "dm", threadId: "thread" });
    const outbound = new ContextOutboundRuntime({ contextClient: client as never, adapters: [adapter] });
    await outbound.drain();
    expect(adapter.sent[0]?.destination).toEqual({ visibility: "private", workspaceId: "workspace", channelId: "dm", threadId: "thread" });
    expect(log.filter((entry) => entry.startsWith("append:")).length).toBe(2);
    await runtime.stop();
  });
  test("persists attachment-only inbound metadata and gives it to the model", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const appendedInputs: unknown[] = [];
    const modelInputs: string[] = [];
    const append = client.append.bind(client);
    client.append = (input) => {
      appendedInputs.push(input);
      return append(input);
    };
    const adapter = new FakeAdapter();
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner" }],
      conversation: (input) => {
        modelInputs.push(input.text);
        return Promise.resolve("attachment reply");
      },
    });
    await runtime.receive({
      id: "attachment-only",
      identity: { provider: "discord", accountId: "bot", userId: "owner-user" },
      destination: { visibility: "private", channelId: "dm" },
      text: "",
      occurredAt: 2,
      attachments: [{ id: "file-1", name: "photo.png", mediaType: "image/png" }],
    });
    expect(appendedInputs[0]).toMatchObject({
      content: {
        text: "",
        attachments: [{ id: "file-1", name: "photo.png", mediaType: "image/png" }],
      },
    });
    expect(modelInputs[0]).toContain("photo.png");
    await runtime.stop();
  });

  test("Discord rejects unauthorized users and keeps shared scope channel-local", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const adapter = new FakeAdapter();
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "shared-user" }, principalId: "principal", scopeId: "guild", channelId: "channel", workspaceId: "workspace" }],
      conversation: () => Promise.resolve("shared reply"),
    });
    await runtime.receive({
      id: "unauthorized",
      identity: { provider: "discord", accountId: "bot", userId: "other" },
      destination: { visibility: "shared", scopeId: "guild", channelId: "channel" },
      text: "no",
      occurredAt: 1,
      attachments: [],
    });
    expect(log).toHaveLength(0);
    await runtime.receive({
      id: "shared",
      identity: { provider: "discord", accountId: "bot", userId: "shared-user" },
      destination: { visibility: "shared", scopeId: "guild", channelId: "channel" },
      text: "yes",
      occurredAt: 2,
      attachments: [],
    });
    expect(client.compileScopes).toEqual([{ kind: "channel", workspaceId: "workspace", channelId: "channel" }]);
  });

  test("Monitor persists notification before ack, and outbound drains it", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const adapter = new FakeAdapter();
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      ownerDestinations: [{ visibility: "private", surface: "discord", channelId: "dm" }],
      monitorAgent: () => Promise.resolve({ summaries: [], wikiTasks: [], notifications: [{ text: "owner notice", reason: "test" }], notes: "" }),
    });
    await monitor.drain();
    expect(log.findIndex((entry) => entry.startsWith("enqueue:"))).toBeLessThan(log.indexOf("ack"));
    const outbound = new ContextOutboundRuntime({ contextClient: client as never, adapters: [adapter] });
    await outbound.drain();
    expect(adapter.sent).toHaveLength(1);
    expect(log.at(-1)?.startsWith("complete:")).toBe(true);
  });

  test("Outbound adapter failures are completed as retryable", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const adapter = new FakeAdapter();
    adapter.sendResult = { ok: false, error: "temporary", retryable: true };
    await client.enqueueOutbound({
      id: "retry-row",
      destination: { surface: "discord", channelId: "dm" },
      text: "retry",
    });
    const outbound = new ContextOutboundRuntime({ contextClient: client as never, adapters: [adapter] });
    await outbound.drain();
    expect(log).toContain("complete:retry-row:retry");
  });

  test("Monitor failures leave the claim lease unacked", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      monitorAgent: () => Promise.reject(new Error("agent unavailable")),
    });
    await monitor.drain();
    expect(log).not.toContain("ack");
  });

  test("Monitor acknowledges every event with its claim token", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const first = {
      event: {
        id: "monitor-event-1",
        kind: "conversation_turn" as const,
        occurredAt: 1,
        source: { surface: "pi" as const, conversationId: "owner-conversation-1", visibility: "private" as const, principalId: "owner" },
        content: { text: "check one" },
      },
      claimToken: "lease-1",
      attempts: 1,
      leaseUntil: 2_000,
    };
    const second = {
      event: {
        id: "monitor-event-2",
        kind: "conversation_turn" as const,
        occurredAt: 2,
        source: { surface: "pi" as const, conversationId: "owner-conversation-2", visibility: "private" as const, principalId: "owner" },
        content: { text: "check two" },
      },
      claimToken: "lease-2",
      attempts: 1,
      leaseUntil: 2_000,
    };
    const acknowledgments: Array<{ consumer: string; eventIds: readonly string[]; claimToken?: string }> = [];
    client.claim = () => Promise.resolve([first, second]);
    client.ack = (input) => {
      acknowledgments.push(input);
      return Promise.resolve({ acknowledged: 1, cursor: 2 });
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      monitorAgent: () => Promise.resolve({ summaries: [], wikiTasks: [], notifications: [], notes: "" }),
    });
    await monitor.drain();
    expect(acknowledgments).toEqual([
      { consumer: "os-monitor", eventIds: ["monitor-event-1"], claimToken: "lease-1" },
      { consumer: "os-monitor", eventIds: ["monitor-event-2"], claimToken: "lease-2" },
    ]);
  });

  test("Monitor forwards a lease longer than the legacy 30 second default", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    let leaseMs = 0;
    client.claim = (input) => {
      leaseMs = input.leaseMs ?? 0;
      return Promise.resolve([]);
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      leaseMs: 60_000,
      monitorAgent: () => Promise.resolve({ summaries: [], wikiTasks: [], notifications: [], notes: "" }),
    });
    await monitor.drain();
    expect(leaseMs).toBe(60_000);
  });

  test("Monitor and outbound runtimes can restart after stop", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    let monitorClaims = 0;
    let outboundClaims = 0;
    client.claim = () => {
      monitorClaims += 1;
      return Promise.resolve([]);
    };
    client.claimOutbound = () => {
      outboundClaims += 1;
      return Promise.resolve([]);
    };
    const monitor = new ContextMonitorRuntime({ contextClient: client as never });
    await monitor.start();
    await monitor.stop();
    await monitor.start();
    await monitor.stop();
    const outbound = new ContextOutboundRuntime({ contextClient: client as never, adapters: [] });
    await outbound.start();
    await outbound.stop();
    await outbound.start();
    await outbound.stop();
    expect(monitorClaims).toBe(2);
    expect(outboundClaims).toBe(2);
  });

  test("Monitor aggregates retained notes and summaries into one durable scope row", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const saved: Array<{ scope: unknown; summary: string }> = [];
    client.claim = () => Promise.resolve([{
      event: {
        id: "aggregate-event",
        kind: "conversation_turn" as const,
        occurredAt: 1,
        source: { surface: "pi" as const, conversationId: "conversation", visibility: "private" as const, principalId: "owner", workspaceId: "workspace" },
        content: { text: "context" },
      },
      claimToken: "lease",
      attempts: 1,
      leaseUntil: 60_000,
    }]);
    client.compile = () => Promise.resolve({
      scope: { kind: "owner", ownerId: "owner", workspaceId: "workspace" },
      summaries: [{ summary: "retained note", scopeKind: "owner", scopeId: "owner", visibility: "private" }],
      events: [],
      wikiPages: [],
    });
    client.saveSummary = (input) => {
      saved.push({ scope: input.scope, summary: input.summary });
      return Promise.resolve({ inserted: true });
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      monitorAgent: () => Promise.resolve({
        summaries: [
          { conversationId: "conversation", visibility: "private" as const, summary: "summary one" },
          { conversationId: "conversation", visibility: "private" as const, summary: "summary two" },
        ],
        wikiTasks: [],
        notifications: [],
        notes: "new note",
      }),
    });
    await monitor.drain();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.scope).toMatchObject({ kind: "owner", ownerId: "owner" });
    expect(saved[0]?.summary).toContain("retained note");
    expect(saved[0]?.summary).toContain("summary one");
    expect(saved[0]?.summary).toContain("summary two");
    expect(saved[0]?.summary).toContain("new note");
  });

  test("Same-text notifications from distinct claimed batches receive distinct durable IDs", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const first = (id: string) => ({
      event: {
        id,
        kind: "conversation_turn" as const,
        occurredAt: 1,
        source: { surface: "pi" as const, conversationId: id, visibility: "private" as const, principalId: "owner", workspaceId: "workspace" },
        content: { text: id },
      },
      claimToken: `lease-${id}`,
      attempts: 1,
      leaseUntil: 60_000,
    });
    let calls = 0;
    client.claim = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? [first("batch-one")] : [first("batch-two")]);
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      ownerDestinations: [{ visibility: "private", surface: "discord", channelId: "dm" }],
      monitorAgent: () => Promise.resolve({ summaries: [], wikiTasks: [], notifications: [{ text: "same text", reason: "test" }], notes: "" }),
    });
    await monitor.drain();
    await monitor.drain();
    const ids = log.filter((entry) => entry.startsWith("enqueue:")).map((entry) => entry.slice("enqueue:".length));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("Outbound rows without a configured adapter remain retryable", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    await client.enqueueOutbound({ id: "missing-adapter", destination: { surface: "sms", channelId: "dm" }, text: "retry me" });
    const outbound = new ContextOutboundRuntime({ contextClient: client as never, adapters: [] });
    await outbound.drain();
    expect(log).toContain("complete:missing-adapter:retry");
  });

  test("Discord replays only inbound surface/kind and acknowledges after durable enqueue", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const claims: ContextClaimRequest[] = [];
    const acknowledgments: ContextAckRequest[] = [];
    const sequence: string[] = [];
    client.claim = (input) => {
      claims.push(input);
      if (claims.length > 1) return Promise.resolve([]);
      return Promise.resolve([{
        event: {
          id: "persisted-discord",
          kind: "conversation_turn" as const,
          occurredAt: 1,
          source: { surface: "discord" as const, conversationId: "discord:bot:dm:", visibility: "private" as const, principalId: "owner", workspaceId: "workspace", channelId: "dm" },
          content: { text: "replay me", prompt: "replay me", resourceId: "original-message" },
        },
        claimToken: "discord-lease",
        attempts: 2,
        leaseUntil: 60_000,
      }]);
    };
    const enqueue = client.enqueueOutbound.bind(client);
    client.enqueueOutbound = (input) => {
      sequence.push("enqueue");
      return enqueue(input);
    };
    client.ack = (input) => {
      sequence.push("ack");
      acknowledgments.push(input);
      return Promise.resolve({ acknowledged: 1, cursor: 1 });
    };
    const adapter = new FakeAdapter();
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner", workspaceId: "workspace" }],
      conversation: () => Promise.resolve("replayed"),
    });
    await runtime.start();
    expect(claims[0]).toMatchObject({ surface: "discord", kind: "conversation_turn" });
    expect(client.outbound).toHaveLength(1);
    expect(acknowledgments).toEqual([{ consumer: "os-discord-replay", eventIds: ["persisted-discord"], claimToken: "discord-lease" }]);
    expect(sequence).toEqual(["enqueue", "ack"]);
    await runtime.stop();
  });

  test("A persisted inbound event is retried after a model failure", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const appended: string[] = [];
    client.append = (input) => {
      const duplicate = appended.includes(input.id);
      appended.push(input.id);
      return Promise.resolve({ inserted: !duplicate, id: input.id });
    };
    let attempts = 0;
    const adapter = new FakeAdapter();
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner" }],
      conversation: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("model unavailable"));
        return Promise.resolve("recovered reply");
      },
    });
    const message: InboundChannelMessage = {
      id: "retry-message",
      identity: { provider: "discord", accountId: "bot", userId: "owner-user" },
      destination: { visibility: "private", channelId: "dm" },
      text: "retry me",
      occurredAt: 2,
      attachments: [],
    };
    await expectRejected(runtime.receive(message), "model unavailable");
    await runtime.receive(message);
    expect(attempts).toBe(2);
    expect(client.outbound).toHaveLength(1);
    expect(client.outbound[0]?.id).toMatch(/^discord-reply:/);
    expect(appended.filter((id) => id.startsWith("discord-event:"))).toHaveLength(2);
    expect(appended.filter((id) => id.startsWith("discord-turn:"))).toHaveLength(1);
  });

  test("A send failure can replay the persisted inbound with the same outbound id", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const appended: string[] = [];
    client.append = (input) => {
      const duplicate = appended.includes(input.id);
      appended.push(input.id);
      return Promise.resolve({ inserted: !duplicate, id: input.id });
    };
    const adapter = new FakeAdapter();
    adapter.sendResult = { ok: false, error: "send unavailable", retryable: true };
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner" }],
      conversation: () => Promise.resolve("replayed reply"),
    });
    const outbound = new ContextOutboundRuntime({ contextClient: client as never, adapters: [adapter] });
    const message: InboundChannelMessage = {
      id: "send-retry-message",
      identity: { provider: "discord", accountId: "bot", userId: "owner-user" },
      destination: { visibility: "private", channelId: "dm" },
      text: "send retry",
      occurredAt: 2,
      attachments: [],
    };
    await runtime.receive(message);
    const firstId = client.outbound[0]?.id;
    await outbound.drain();
    expect(log).toContain(`complete:${firstId}:retry`);
    adapter.sendResult = { ok: true, messageId: "replayed" };
    await runtime.receive(message);
    const secondId = client.outbound[0]?.id;
    expect(secondId).toBe(firstId);
    await outbound.drain();
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[0]?.message.id).toBe(adapter.sent[1]?.message.id);
    expect(appended.filter((id) => id.startsWith("discord-turn:"))).toHaveLength(2);
  });
  test("duplicate inbound deliveries reuse durable reply and outbound IDs", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const adapter = new FakeAdapter();
    let replyEvent: ContextEventRecord | undefined;
    let modelCalls = 0;
    const append = client.append.bind(client);
    client.append = (input) => {
      if (input.kind === "agent_action") replyEvent = input;
      return append(input);
    };
    client.compile = (input) => Promise.resolve({
      scope: input.scope,
      events: replyEvent ? [replyEvent] : [],
      summaries: [],
      wikiPages: [],
    } satisfies ContextCompileResult);
    const enqueue = client.enqueueOutbound.bind(client);
    client.enqueueOutbound = (input) => {
      if (client.outbound.some((row) => row.id === input.id)) {
        return Promise.resolve({ inserted: false, id: input.id });
      }
      return enqueue(input);
    };
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner" }],
      conversation: () => {
        modelCalls += 1;
        return Promise.resolve("deduplicated reply");
      },
    });
    const message: InboundChannelMessage = {
      id: "duplicate-message",
      identity: { provider: "discord", accountId: "bot", userId: "owner-user" },
      destination: { visibility: "private", channelId: "dm" },
      text: "same",
      occurredAt: 2,
      attachments: [],
    };
    await runtime.receive(message);
    await runtime.receive(message);
    expect(modelCalls).toBe(1);
    expect(client.outbound).toHaveLength(1);
    expect(client.outbound[0]?.id).toMatch(/^discord-reply:/);
    await runtime.stop();
  });

  test("Shutdown drains an in-flight model call before stopping the adapter", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const adapter = new FakeAdapter();
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    let releaseModel!: (reply: string) => void;
    const model = new Promise<string>((resolve) => { releaseModel = resolve; });
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner" }],
      conversation: () => {
        modelStarted();
        return model;
      },
    });
    await runtime.start();
    const receive = runtime.receive({
      id: "shutdown-message",
      identity: { provider: "discord", accountId: "bot", userId: "owner-user" },
      destination: { visibility: "private", channelId: "dm" },
      text: "wait for me",
      occurredAt: 2,
      attachments: [],
    });
    await started;
    const stop = runtime.stop();
    await Promise.resolve();
    expect(adapter.stopCalls).toBe(0);
    releaseModel("drained reply");
    await receive;
    const outbound = new ContextOutboundRuntime({ contextClient: client as never, adapters: [adapter] });
    await outbound.drain();
    await stop;
    expect(adapter.stopCalls).toBe(1);
    expect(adapter.sent).toHaveLength(1);
    await runtime.receive({
      id: "late-message",
      identity: { provider: "discord", accountId: "bot", userId: "owner-user" },
      destination: { visibility: "private", channelId: "dm" },
      text: "must be ignored",
      occurredAt: 3,
      attachments: [],
    });
    expect(adapter.sent).toHaveLength(1);
  });
  test("Monitor isolates private and channel scopes before invoking the model", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const event = (id: string, visibility: "private" | "shared", channelId?: string): ContextClaimedEvent => ({
      event: {
        id,
        kind: "conversation_turn",
        occurredAt: 1,
        source: {
          surface: "pi",
          conversationId: id,
          visibility,
          ...(visibility === "private" ? { principalId: "owner" } : {}),
          workspaceId: "workspace",
          ...(channelId ? { channelId } : {}),
        },
        content: { text: id },
      },
      claimToken: `lease-${id}`,
      attempts: 1,
      leaseUntil: Date.now() + 60_000,
    });
    const claimed = [event("private", "private"), event("channel-a", "shared", "a"), event("channel-b", "shared", "b")];
    client.claim = () => Promise.resolve(claimed);
    const invocations: string[][] = [];
    const saved: string[] = [];
    client.saveSummary = (input) => {
      saved.push(input.summary);
      return Promise.resolve({ inserted: true });
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      monitorAgent: (input) => {
        invocations.push(input.events.map((item) => item.id));
        return Promise.resolve({
          summaries: [{
            conversationId: input.events[0]?.source.conversationId ?? "",
            visibility: "shared" as const,
            channelId: "channel-b",
            summary: "must not cross scope",
          }],
          wikiTasks: [],
          notifications: [],
          notes: "",
        });
      },
    });
    await monitor.drain();
    expect(invocations).toEqual([["private"], ["channel-a"], ["channel-b"]]);
    expect(saved).toHaveLength(0);
    expect(log.filter((entry) => entry === "ack")).toHaveLength(3);
  });
  test("Monitor rejects a claimed event from a different configured workspace", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    client.claim = () => Promise.resolve([{
      event: {
        id: "wrong-workspace",
        kind: "conversation_turn" as const,
        occurredAt: 1,
        source: {
          surface: "pi" as const,
          conversationId: "wrong-workspace",
          visibility: "shared" as const,
          workspaceId: "other-workspace",
          channelId: "channel",
        },
        content: { text: "must remain retryable" },
      },
      claimToken: "lease",
      attempts: 1,
      leaseUntil: Date.now() + 60_000,
    }]);
    let invoked = false;
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      workspaceId: "configured-workspace",
      monitorAgent: () => {
        invoked = true;
        return Promise.resolve({ summaries: [], wikiTasks: [], notifications: [], notes: "" });
      },
    });
    await monitor.drain();
    expect(invoked).toBe(false);
    expect(log).not.toContain("ack");
  });

  test("Monitor loads and saves every affected scope beyond the batch-size window", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const claimed: ContextClaimedEvent[] = Array.from({ length: 60 }, (_, index) => ({
      event: {
        id: `scope-${index}`,
        kind: "conversation_turn",
        occurredAt: index,
        source: {
          surface: "pi",
          conversationId: `scope-${index}`,
          visibility: "shared",
          workspaceId: "workspace",
          channelId: `channel-${index}`,
        },
        content: { text: `scope-${index}` },
      },
      claimToken: `lease-${index}`,
      attempts: 1,
      leaseUntil: Date.now() + 60_000,
    }));
    client.claim = () => Promise.resolve(claimed);
    const compileScopes: unknown[] = [];
    let saves = 0;
    client.compile = (input) => {
      compileScopes.push(input.scope);
      return Promise.resolve({ scope: input.scope, summaries: [], events: [], wikiPages: [] } satisfies ContextCompileResult);
    };
    client.saveSummary = () => {
      saves += 1;
      return Promise.resolve({ inserted: true });
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      batchSize: 100,
      monitorAgent: (input) => Promise.resolve({
        summaries: [],
        wikiTasks: [],
        notifications: [],
        notes: input.events[0]?.source.channelId ?? "",
      }),
    });
    await monitor.drain();
    expect(compileScopes).toHaveLength(60);
    expect(saves).toBe(60);
  });

  test("Monitor leaves an expired or concurrently reclaimed claim unacked", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    let claims = 0;
    const event = (token: string): ContextClaimedEvent => ({
      event: {
        id: "lease-event",
        kind: "conversation_turn",
        occurredAt: 1,
        source: { surface: "pi", conversationId: "lease", visibility: "private", principalId: "owner" },
        content: { text: "lease" },
      },
      claimToken: token,
      attempts: claims,
      leaseUntil: Date.now() + 60_000,
    });
    client.claim = () => {
      claims += 1;
      return Promise.resolve(claims === 1 ? [event("expired-token")] : [event("reclaimed-token")]);
    };
    let renewals = 0;
    client.renewClaim = (input) => {
      renewals += 1;
      if (renewals === 1) return Promise.reject(new Error("claim reclaimed"));
      return Promise.resolve({ claims: input.claims, leaseUntil: Date.now() + 300_000 });
    };
    client.commitMonitorEffect = (input) => Promise.resolve({ effectKey: input.effectKey, status: "completed" as const });
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      monitorAgent: () => Promise.resolve({ summaries: [], wikiTasks: [], notifications: [], notes: "durable" }),
    });
    await monitor.drain();
    expect(log).not.toContain("ack");
    await monitor.drain();
    expect(log.filter((entry) => entry === "ack")).toHaveLength(1);
  });

  test("Monitor replay after a partial effect skips the completed effect key", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    let claims = 0;
    const claimed = (token: string): ContextClaimedEvent => ({
      event: {
        id: "replay-event",
        kind: "conversation_turn",
        occurredAt: 1,
        source: { surface: "pi", conversationId: "replay", visibility: "private", principalId: "owner" },
        content: { text: "replay" },
      },
      claimToken: token,
      attempts: claims,
      leaseUntil: Date.now() + 60_000,
    });
    client.claim = () => {
      claims += 1;
      return Promise.resolve(claims === 1 ? [claimed("first-token")] : [claimed("reclaimed-token")]);
    };
    const seen = new Set<string>();
    const effects: string[] = [];
    let failNotification = true;
    client.renewClaim = (input) => Promise.resolve({ claims: input.claims, leaseUntil: Date.now() + 300_000 });
    client.commitMonitorEffect = (input) => {
      if (input.kind === "notification" && failNotification) {
        failNotification = false;
        return Promise.reject(new Error("crash after summary"));
      }
      if (seen.has(input.effectKey)) return Promise.resolve({ effectKey: input.effectKey, status: "replayed" as const });
      seen.add(input.effectKey);
      effects.push(input.kind);
      return Promise.resolve({ effectKey: input.effectKey, status: "completed" as const });
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      ownerDestinations: [{ visibility: "private", surface: "discord", channelId: "dm" }],
      monitorAgent: () => Promise.resolve({
        summaries: [],
        wikiTasks: [],
        notifications: [{ text: "notice", reason: "test" }],
        notes: "summary",
      }),
    });
    await monitor.drain();
    expect(log).not.toContain("ack");
    await monitor.drain();
    expect(log.filter((entry) => entry === "ack")).toHaveLength(1);
    expect(effects).toEqual(["summary", "notification"]);
  });
  test("Monitor drains a pending Wiki job once and records completion", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    client.claim = () => Promise.resolve([]);
    let jobClaims = 0;
    let runs = 0;
    const completions: Array<{ success: boolean; effectKey: string }> = [];
    client.claimMonitorWikiEffects = () => {
      jobClaims += 1;
      return Promise.resolve(jobClaims === 1
        ? [{ effectKey: "wiki-effect", wikiTask: "curate durable task", jobClaimToken: "job-token", leaseUntil: Date.now() + 300_000 }]
        : []);
    };
    client.completeMonitorWikiEffect = (input) => {
      completions.push({ success: input.success, effectKey: input.effectKey });
      return Promise.resolve({ effectKey: input.effectKey, status: "completed" as const });
    };
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      wikiAgent: () => {
        runs += 1;
        return Promise.resolve({ ok: true });
      },
    });
    await monitor.start();
    await monitor.stop();
    await monitor.start();
    await monitor.stop();
    expect(runs).toBe(1);
    expect(completions).toEqual([{ success: true, effectKey: "wiki-effect" }]);
  });

  test("Monitor retains stale Wiki jobs as reconciliation failures without rerunning", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    client.claim = () => Promise.resolve([]);
    let runs = 0;
    client.claimMonitorWikiEffects = () => Promise.resolve([]);
    client.completeMonitorWikiEffect = () => Promise.resolve({ effectKey: "stale", status: "needs_reconciliation" as const });
    const monitor = new ContextMonitorRuntime({
      contextClient: client as never,
      wikiAgent: () => {
        runs += 1;
        return Promise.resolve();
      },
    });
    await monitor.start();
    await monitor.stop();
    expect(runs).toBe(0);
  });
});
