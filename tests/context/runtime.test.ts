import { describe, expect, test } from "bun:test";
import type { ContextCapabilityClient, ContextCompileResult, ContextClaimedEvent, ContextOutboundRecord } from "../../src/capability/context/client";
import { ContextMonitorRuntime, ContextOutboundRuntime, DiscordContextRuntime } from "../../src/capability/context/runtime";
import type { ChannelAdapter, ChannelReceiver, ChannelSendResult, InboundChannelMessage } from "../../src/platform/channel/channel";

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
    append: async (input) => {
      log.push(`append:${input.id}`);
      return { inserted: true, id: input.id };
    },
    compile: async (input) => {
      compileScopes.push(input.scope);
      return { scope: input.scope, events: [], summaries: [], wikiPages: [] } satisfies ContextCompileResult;
    },
    claim: async () => {
      if (!claimed) return [];
      claimed = false;
      const event: ContextClaimedEvent["event"] = {
        id: "monitor-event",
        kind: "conversation_turn",
        occurredAt: 1,
        source: { surface: "pi", conversationId: "owner-conversation", visibility: "private", principalId: "owner" },
        content: { text: "check" },
      };
      return [{ event, claimToken: "lease", attempts: 1, leaseUntil: Date.now() + 1_000 }];
    },
    saveSummary: async () => {
      log.push("summary");
      return { inserted: true };
    },
    enqueueOutbound: async (input) => {
      log.push(`enqueue:${input.id}`);
      const row = { ...input, status: "queued" as const, attempts: 0, claimToken: "out-lease", leaseUntil: Date.now() + 1_000 };
      outbound.push(row);
      return { inserted: true, id: input.id };
    },
    claimOutbound: async () => outbound.splice(0),
    completeOutbound: async (input) => {
      log.push(`complete:${input.id}:${input.retryable === true ? "retry" : input.success === true ? "success" : "failed"}`);
      return { id: input.id ?? "", status: "completed" as const, attempts: 1 };
    },
    ack: async () => {
      log.push("ack");
      return { acknowledged: 1, cursor: 1 };
    },
  };
  return client;
}


class FakeAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  receiver: ChannelReceiver | undefined;
  sent: Array<{ destination: unknown; message: unknown }> = [];
  sendResult: ChannelSendResult = { ok: true, messageId: "reply" };
  async start(receiver: ChannelReceiver) { this.receiver = receiver; }
  async stop() { this.receiver = undefined; }
  async send(destination: InboundChannelMessage["destination"], message: { id: string; text: string; replyToId?: string }): Promise<ChannelSendResult> {
    this.sent.push({ destination, message });
    return this.sendResult;
  }
}

describe("context live runtimes", () => {
  test("Discord inbound compiles the exact owner scope and persists the reply", async () => {
    const log: string[] = [];
    const client = fakeClient(log);
    const adapter = new FakeAdapter();
    const runtime = new DiscordContextRuntime({
      contextClient: client,
      adapter,
      bindings: [{ identity: { provider: "discord", accountId: "bot", userId: "owner-user" }, principalId: "owner", ownerId: "owner" }],
      conversation: async () => "owner reply",
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
    expect(client.compileScopes).toEqual([{ kind: "owner", ownerId: "owner" }]);
    expect(adapter.sent[0]?.destination).toEqual({ visibility: "private", channelId: "dm", threadId: "thread" });
    expect(log.filter((entry) => entry.startsWith("append:")).length).toBe(2);
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
      conversation: async () => "shared reply",
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
      monitorAgent: async () => ({ summaries: [], wikiTasks: [], notifications: [{ text: "owner notice", reason: "test" }], notes: "" }),
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
      monitorAgent: async () => {
        throw new Error("agent unavailable");
      },
    });
    await monitor.drain();
    expect(log).not.toContain("ack");
  });
});
