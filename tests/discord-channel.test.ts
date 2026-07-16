import { describe, expect, test } from "bun:test";
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
  fetchError: unknown;
  sendError: unknown;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  channels = {
    fetch: async (_channelId: string) => {
      if (this.fetchError) throw this.fetchError;
      return {
        send: async (payload: unknown) => {
          if (this.sendError) throw this.sendError;
          this.sent.push(payload);
          return { id: `sent-${this.sent.length}` };
        },
      };
    },
  };

  async login(_token: string): Promise<string> {
    this.loginCalls += 1;
    this.emit("ready");
    return "token";
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
    const adapter = new DiscordChannelAdapter(config, { client });
    await adapter.start(async (candidate) => {
      received.push(candidate);
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

  test("supports owner DM full scope but guild messages only channel scope", async () => {
    const client = new FakeClient();
    const received: InboundChannelMessage[] = [];
    const adapter = new DiscordChannelAdapter(config, { client });
    await adapter.start(async (candidate) => {
      received.push(candidate);
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

  test("chunks sends at 2,000 characters and preserves thread reply", async () => {
    const client = new FakeClient();
    const adapter = new DiscordChannelAdapter(config, { client });
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

  test("classifies transient send failures as retryable and lifecycle is reconnect-safe", async () => {
    const client = new FakeClient();
    const adapter = new DiscordChannelAdapter(config, { client });
    await adapter.start(async () => {});
    client.sendError = Object.assign(new Error("rate limited"), { status: 429 });
    await expect(adapter.send({ visibility: "private", channelId: "dm-1" }, {
      id: "out-1",
      text: "hello",
    })).resolves.toEqual({ ok: false, error: "rate limited", retryable: true });
    await adapter.stop();
    expect(client.destroyCalls).toBe(1);
    await expect(adapter.send({ visibility: "private", channelId: "dm-1" }, {
      id: "out-1",
      text: "hello",
    })).resolves.toEqual({ ok: false, error: "Discord adapter is not started", retryable: false });
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
