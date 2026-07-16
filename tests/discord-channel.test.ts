import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "bun:test";
import {
  DiscordChannelAdapter,
  type DiscordClientLike,
  type DiscordMessageLike,
  normalizeDiscordMessage,
  parseDiscordConfig,
  splitDiscordText,
} from "../src/platform/channel/discord";
import { authorizeChannelMessage } from "../src/platform/channel/authorization";
import type { InboundChannelMessage, OutboundChannelMessage } from "../src/platform/channel/channel";

class FakeClient implements DiscordClientLike {
  user: { id: string } | null = { id: "bot-1" };
  loginCalls = 0;
  destroyCalls = 0;
  sent: unknown[] = [];
  fetchError: Error | undefined;
  sendError: Error | undefined;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  channels = {
    fetch: (_channelId: string) => {
      if (this.fetchError) return Promise.reject(this.fetchError);
      return Promise.resolve({
        send: (payload: unknown) => {
          if (this.sendError) return Promise.reject(this.sendError);
          this.sent.push(payload);
          return Promise.resolve({ id: `sent-${this.sent.length}` });
        },
      });
    },
  };

  login(_token: string): Promise<string> {
    this.loginCalls += 1;
    this.emit("ready");
    return Promise.resolve("token");
  }

  destroy(): void {
    this.destroyCalls += 1;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const config = {
  botToken: "token",
  allowedUserIds: [],
  bindings: [],
  requireMention: true,
};
let spoolCounter = 0;
function testSpoolPath(): string {
  const path = join(tmpdir(), `anorvis-discord-test-${process.pid}-${spoolCounter += 1}.json`);
  rmSync(path, { force: true });
  return path;
}

function message(overrides: Partial<DiscordMessageLike> = {}): DiscordMessageLike {
  return {
    id: "message-1",
    channelId: "channel-1",
    content: "hello",
    createdTimestamp: 1_700_000_000_000,
    author: { id: "user-1" },
    ...overrides,
  };
}

describe("Discord channel adapter", () => {
  test("normalizes DM and threaded guild messages with exact IDs and attachments", () => {
    const dm = normalizeDiscordMessage(message({ guildId: null }), "bot-1");
    expect(dm).toMatchObject({
      id: "message-1",
      identity: { provider: "discord", accountId: "bot-1", userId: "user-1" },
      destination: { visibility: "private", channelId: "channel-1" },
      text: "hello",
      occurredAt: 1_700_000_000_000,
    });

    const guild = normalizeDiscordMessage(message({
      guildId: "guild-1",
      channelId: "thread-1",
      channel: { parentId: "channel-1", isThread: () => true },
      reference: { messageId: "reply-1" },
      attachments: new Map([
        ["file-1", { id: "file-1", name: "note.txt", contentType: "text/plain", url: "https://example.test/note.txt" }],
      ]),
    }), "bot-1");

    expect(guild).toMatchObject({
      identity: { accountId: "bot-1", userId: "user-1" },
      destination: {
        visibility: "shared",
        scopeId: "guild-1",
        channelId: "channel-1",
        threadId: "thread-1",
      },
      replyToId: "reply-1",
      attachments: [{ id: "file-1", name: "note.txt", mediaType: "text/plain", url: "https://example.test/note.txt" }],
    });
  });

  test("ignores bots/self and gates guild messages on mention while accepting DMs", async () => {
    const client = new FakeClient();
    const received: InboundChannelMessage[] = [];
    const adapter = new DiscordChannelAdapter(config, { client, spoolPath: testSpoolPath() });
    await adapter.start((candidate) => {
      received.push(candidate);
      return Promise.resolve();
    });

    client.emit("messageCreate", message({ author: { id: "other-bot", bot: true } }));
    client.emit("messageCreate", message({ author: { id: "bot-1" } }));
    client.emit("messageCreate", message({ guildId: "guild-1", content: "hello" }));
    client.emit("messageCreate", message({ guildId: "guild-1", content: "<@bot-1> hello" }));
    client.emit("messageCreate", message({ guildId: null, content: "private hello" }));
    await Promise.resolve();

    expect(received).toHaveLength(2);
    expect(received.map((candidate) => candidate.text)).toEqual(["<@bot-1> hello", "private hello"]);
    await adapter.stop();
  });
  test("retries a transient receiver failure so initial durable append is not swallowed", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      let calls = 0;
      const adapter = new DiscordChannelAdapter(config, { client, spoolPath: testSpoolPath() });
      await adapter.start(() => Promise.resolve().then(() => {
        calls += 1;
        if (calls === 1) throw new Error("append unavailable");
      }));
      client.emit("messageCreate", message({ guildId: null }));
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(1);
      vi.advanceTimersByTime(25);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(2);
      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  test("retains receiver failures beyond three callbacks and recovers", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "anorvis-discord-spool-"));
    const spoolPath = join(root, "inbound.json");
    try {
      const client = new FakeClient();
      let calls = 0;
      const adapter = new DiscordChannelAdapter(config, { client, spoolPath });
      await adapter.start(() => Promise.resolve().then(() => {
        calls += 1;
        if (calls < 5) throw new Error("append unavailable");
      }));
      client.emit("messageCreate", message({ id: "extended-retry", guildId: null }));
      await Promise.resolve();
      await Promise.resolve();
      for (const delay of [25, 50, 100, 200]) {
        vi.advanceTimersByTime(delay);
        await Promise.resolve();
        await Promise.resolve();
      }
      expect(calls).toBe(5);
      expect(readFileSync(spoolPath, "utf8")).toBe("[]");
      await adapter.stop();
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains messages rejected while ordered shutdown is stopping", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "anorvis-discord-stopping-"));
    const spoolPath = join(root, "inbound.json");
    try {
      const client = new FakeClient();
      const adapter = new DiscordChannelAdapter(config, { client, spoolPath });
      await adapter.start(() => Promise.reject(new Error("runtime is stopping")));
      client.emit("messageCreate", message({ id: "stopping-message", guildId: null }));
      await Promise.resolve();
      await Promise.resolve();
      await adapter.stop();
      expect(JSON.parse(readFileSync(spoolPath, "utf8"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not overlap receiver retries while a delivery is in flight", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      const adapter = new DiscordChannelAdapter(config, { client, spoolPath: testSpoolPath() });
      let calls = 0;
      let active = 0;
      let maximumActive = 0;
      let releaseFirst!: () => void;
      let signalFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
      await adapter.start(() => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) {
          signalFirstStarted();
          return new Promise<void>((_, reject) => {
            releaseFirst = () => {
              active -= 1;
              reject(new Error("receiver unavailable"));
            };
          });
        }
        active -= 1;
        return Promise.resolve();
      });
      client.emit("messageCreate", message({ id: "slow-delivery", guildId: null }));
      await firstStarted;
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(25);
      await Promise.resolve();
      expect(calls).toBe(1);
      releaseFirst();
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(2);
      expect(maximumActive).toBe(1);
      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("replays the durable inbound spool after adapter restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "anorvis-discord-restart-"));
    const spoolPath = join(root, "inbound.json");
    try {
      const client = new FakeClient();
      const first = new DiscordChannelAdapter(config, { client, spoolPath });
      await first.start(() => Promise.reject(new Error("append unavailable")));
      client.emit("messageCreate", message({ id: "restart-message", guildId: null }));
      await Promise.resolve();
      await Promise.resolve();
      await first.stop();
      expect(JSON.parse(readFileSync(spoolPath, "utf8"))).toHaveLength(1);

      const recovered: InboundChannelMessage[] = [];
      const second = new DiscordChannelAdapter(config, { client, spoolPath });
      await second.start((candidate) => {
        recovered.push(candidate);
        return Promise.resolve();
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(recovered.map((candidate) => candidate.id)).toEqual(["restart-message"]);
      expect(readFileSync(spoolPath, "utf8")).toBe("[]");
      await second.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps successful deliveries memory bounded", async () => {
    const root = mkdtempSync(join(tmpdir(), "anorvis-discord-bounded-"));
    const spoolPath = join(root, "inbound.json");
    try {
      const client = new FakeClient();
      const received: InboundChannelMessage[] = [];
      const adapter = new DiscordChannelAdapter(config, { client, spoolPath });
      await adapter.start((candidate) => {
        received.push(candidate);
        return Promise.resolve();
      });
      for (let index = 0; index < 100; index += 1) {
        client.emit("messageCreate", message({ id: `bounded-${index}`, guildId: null }));
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(received).toHaveLength(100);
      expect(readFileSync(spoolPath, "utf8")).toBe("[]");
      expect("completed" in adapter).toBe(false);
      await adapter.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  test("supports owner DM full scope but guild messages only channel scope", async () => {
    const client = new FakeClient();
    const received: InboundChannelMessage[] = [];
    const adapter = new DiscordChannelAdapter(config, { client, spoolPath: testSpoolPath() });
    await adapter.start((candidate) => {
      received.push(candidate);
      return Promise.resolve();
    });

    client.emit("messageCreate", message({ guildId: null }));
    client.emit("messageCreate", message({
      guildId: "guild-1",
      content: "<@bot-1> hello",
    }));
    await Promise.resolve();

    const ownerBinding = {
      identity: { provider: "discord" as const, accountId: "bot-1", userId: "user-1" },
      principalId: "principal-1",
      ownerId: "owner-1",
    };
    const guildBinding = {
      identity: { provider: "discord" as const, accountId: "bot-1", userId: "user-1" },
      principalId: "principal-1",
      scopeId: "guild-1",
      channelId: "channel-1",
      workspaceId: "workspace-1",
    };
    const owner = authorizeChannelMessage(received[0], [ownerBinding]);
    const shared = authorizeChannelMessage(received[1], [guildBinding]);
    expect(owner?.authorization.contextScope).toEqual({ kind: "owner", ownerId: "owner-1" });
    expect(shared?.authorization.contextScope).toEqual({ kind: "channel", workspaceId: "workspace-1", channelId: "channel-1" });
    await adapter.stop();
  });

  test("selects the matching workspace for private owner bindings", () => {
    const normalized = normalizeDiscordMessage(message({ guildId: null }), "bot-1");
    if (!normalized) throw new Error("expected normalized DM");
    const destination = { ...normalized.destination, workspaceId: "workspace-2" };
    const firstWorkspace = {
      identity: { provider: "discord" as const, accountId: "bot-1", userId: "user-1" },
      principalId: "principal-1",
      ownerId: "owner-1",
      workspaceId: "workspace-1",
    };
    const secondWorkspace = { ...firstWorkspace, workspaceId: "workspace-2" };

    const authorized = authorizeChannelMessage({ ...normalized, destination }, [
      firstWorkspace,
      secondWorkspace,
    ]);

    expect(authorized?.authorization.contextScope).toEqual({
      kind: "owner",
      ownerId: "owner-1",
      workspaceId: "workspace-2",
    });
    const boundWithoutDestination = authorizeChannelMessage(normalized, [secondWorkspace]);
    expect(boundWithoutDestination?.authorization.contextScope).toEqual({
      kind: "owner",
      ownerId: "owner-1",
      workspaceId: "workspace-2",
    });
  });

  test("chunks sends at 2,000 characters and preserves thread reply", async () => {
    const client = new FakeClient();
    const adapter = new DiscordChannelAdapter(config, { client, spoolPath: testSpoolPath() });
    await adapter.start(async () => {});
    const outbound: OutboundChannelMessage = {
      id: "out-1",
      text: "😀".repeat(2_001),
      replyToId: "reply-1",
    };
    const result = await adapter.send({
      visibility: "shared",
      workspaceId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
    }, outbound);

    expect(result).toEqual({ ok: true, messageId: "sent-3" });
    expect(client.sent).toHaveLength(3);
    const first = client.sent[0] as { content: string; reply: unknown };
    const second = client.sent[1] as { content: string; reply?: unknown };
    const third = client.sent[2] as { content: string; reply?: unknown };
    expect(first.content).toHaveLength(2_000);
    expect(second.content).toHaveLength(2_000);
    expect(third.content).toHaveLength(2);
    expect(first.reply).toEqual({ messageReference: "reply-1" });
    expect(second.reply).toBeUndefined();
    expect(third.reply).toBeUndefined();
    await adapter.stop();
  });

  test("uses stable length-safe nonces with enforcement across retries", async () => {
    const client = new FakeClient();
    const adapter = new DiscordChannelAdapter(config, { client, spoolPath: testSpoolPath() });
    await adapter.start(async () => {});
    const outbound: OutboundChannelMessage = {
      id: "outbound-row-with-a-stable-id-that-is-longer-than-discord-allows",
      text: "x".repeat(2_001),
    };
    const destination = {
      visibility: "private" as const,
      channelId: "dm-1",
    };

    await adapter.send(destination, outbound);
    const firstAttempt = (client.sent as Array<{ nonce: string; enforceNonce: boolean }>).map((payload) => ({
      nonce: payload.nonce,
      enforceNonce: payload.enforceNonce,
    }));
    await adapter.send(destination, outbound);
    const secondAttempt = (client.sent as Array<{ nonce: string; enforceNonce: boolean }>).slice(firstAttempt.length).map((payload) => ({
      nonce: payload.nonce,
      enforceNonce: payload.enforceNonce,
    }));

    expect(firstAttempt).toHaveLength(2);
    expect(secondAttempt).toEqual(firstAttempt);
    expect(firstAttempt.every(({ nonce, enforceNonce }) =>
      enforceNonce && nonce.length <= 25 && /^[a-f0-9]+$/.test(nonce)
    )).toBe(true);
    expect(new Set(firstAttempt.map(({ nonce }) => nonce)).size).toBe(2);
    await adapter.stop();
  });

  test("classifies transient send failures as retryable and lifecycle is reconnect-safe", async () => {
    const client = new FakeClient();
    const adapter = new DiscordChannelAdapter(config, { client, spoolPath: testSpoolPath() });
    await adapter.start(async () => {});
    client.sendError = Object.assign(new Error("rate limited"), { status: 429 });
    expect(await adapter.send({ visibility: "private", channelId: "dm-1" }, {
      id: "out-1",
      text: "hello",
    })).toEqual({ ok: false, error: "rate limited", retryable: true });
    await adapter.stop();
    expect(client.destroyCalls).toBe(1);
    expect(await adapter.send({ visibility: "private", channelId: "dm-1" }, {
      id: "out-1",
      text: "hello",
    })).toEqual({ ok: false, error: "Discord adapter is not started", retryable: true });
    await adapter.start(async () => {});
    expect(client.loginCalls).toBe(2);
    await adapter.stop();
    expect(client.destroyCalls).toBe(2);
  });

  test("parses config without exposing token in validation errors", () => {
    const parsed = parseDiscordConfig({
      ANORVIS_DISCORD_BOT_TOKEN: " secret-token ",
      ANORVIS_DISCORD_OWNER_USER_ID: " owner-1 ",
      ANORVIS_DISCORD_ALLOWED_USER_IDS: "u-1, u-2,u-1",
      ANORVIS_DISCORD_BINDINGS: JSON.stringify([{ userId: "u-1", ownerId: "owner-1", workspaceId: "workspace-1", scopeId: "guild-1" }]),
      ANORVIS_DISCORD_PRIVATE_HOME_CHANNEL_ID: "home-1",
      ANORVIS_DISCORD_PRIVATE_HOME_THREAD_ID: "home-thread-1",
    });
    expect(parsed).toEqual({
      botToken: "secret-token",
      ownerUserId: "owner-1",
      allowedUserIds: ["u-1", "u-2"],
      bindings: [{ userId: "u-1", ownerId: "owner-1", workspaceId: "workspace-1", scopeId: "guild-1" }],
      privateHomeRoute: { channelId: "home-1", threadId: "home-thread-1" },
      requireMention: true,
    });
    expect(() => parseDiscordConfig({ ANORVIS_DISCORD_BOT_TOKEN: "" })).toThrow("discord bot token is required");
    expect(() => parseDiscordConfig({ ANORVIS_DISCORD_BOT_TOKEN: "secret", ANORVIS_DISCORD_BINDINGS: "nope" })).toThrow("invalid Discord binding configuration");
  });

  test("splits by Unicode code points without splitting surrogate pairs", () => {
    const chunks = splitDiscordText("😀a😀b", 3);
    expect(chunks).toEqual(["😀a", "😀b"]);
  });
});
