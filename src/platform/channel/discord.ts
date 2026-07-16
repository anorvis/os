import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelDestination,
  ChannelReceiver,
  ChannelSendResult,
  OutboundChannelMessage,
  InboundChannelMessage,
} from "./channel";

const MAX_DISCORD_MESSAGE_LENGTH = 2_000;
const RETRYABLE_ERROR_CODES: Record<string, true> = {
  ECONNRESET: true,
  ECONNREFUSED: true,
  ETIMEDOUT: true,
  EAI_AGAIN: true,
  ENETUNREACH: true,
  EHOSTUNREACH: true,
};

export type DiscordPrivateHomeRoute = {
  channelId: string;
  threadId?: string;
};

export type DiscordBindingInput = {
  userId: string;
  accountId?: string;
  scopeId?: string;
  channelId?: string;
  principalId?: string;
  ownerId?: string;
  workspaceId?: string;
};

export type DiscordConfig = {
  botToken: string;
  accountId?: string;
  ownerUserId?: string;
  allowedUserIds: readonly string[];
  bindings: readonly DiscordBindingInput[];
  privateHomeRoute?: DiscordPrivateHomeRoute;
  requireMention: boolean;
};

export type DiscordAttachmentLike = {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  url?: string | null;
};

export type DiscordMessageLike = {
  id: string;
  content?: string | null;
  createdTimestamp?: number;
  createdAt?: Date;
  guildId?: string | null;
  channelId: string;
  channel?: {
    parentId?: string | null;
    isThread?: () => boolean;
  };
  author?: {
    id: string;
    bot?: boolean;
    system?: boolean;
  } | null;
  mentions?: {
    has?: (userId: string) => boolean;
  };
  reference?: {
    messageId?: string | null;
  } | null;
  attachments?:
    | Iterable<DiscordAttachmentLike>
    | { values: () => Iterable<DiscordAttachmentLike> }
    | Record<string, DiscordAttachmentLike>;
};

type DiscordSendableChannel = {
  send: (payload: unknown) => Promise<{ id: string }>;
};

export interface DiscordClientLike {
  user: { id: string } | null;
  channels: {
    fetch: (channelId: string) => Promise<DiscordSendableChannel | null>;
  };
  login: (token: string) => Promise<unknown>;
  destroy: () => void | Promise<void>;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export type DiscordClientFactory = () => DiscordClientLike;

export type DiscordChannelAdapterOptions = {
  client?: DiscordClientLike;
  clientFactory?: DiscordClientFactory;
};

export function parseDiscordConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscordConfig {
  const botToken = readRequired(env, ["ANORVIS_DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN"], "discord bot token");
  const ownerUserId = readOptional(env, [
    "ANORVIS_DISCORD_OWNER_USER_ID",
    "ANORVIS_DISCORD_ALLOWED_OWNER_USER_ID",
    "DISCORD_OWNER_USER_ID",
    "DISCORD_ALLOWED_OWNER_USER_ID",
    "ANORVIS_OWNER_USER_ID",
  ]);
  const accountId = readOptional(env, ["ANORVIS_DISCORD_ACCOUNT_ID", "DISCORD_ACCOUNT_ID"]);
  const allowedUserIds = parseCsv(env.ANORVIS_DISCORD_ALLOWED_USER_IDS ?? env.DISCORD_ALLOWED_USER_IDS);
  const bindings = parseBindings(env.ANORVIS_DISCORD_BINDINGS ?? env.DISCORD_BINDINGS);
  const homeChannelId = readOptional(env, [
    "ANORVIS_DISCORD_PRIVATE_HOME_CHANNEL_ID",
    "ANORVIS_DISCORD_HOME_CHANNEL_ID",
    "DISCORD_PRIVATE_HOME_CHANNEL_ID",
    "DISCORD_HOME_CHANNEL_ID",
  ]);
  const homeThreadId = readOptional(env, [
    "ANORVIS_DISCORD_PRIVATE_HOME_THREAD_ID",
    "ANORVIS_DISCORD_HOME_THREAD_ID",
    "DISCORD_PRIVATE_HOME_THREAD_ID",
    "DISCORD_HOME_THREAD_ID",
  ]);
  const requireMention = parseBoolean(
    env.ANORVIS_DISCORD_REQUIRE_MENTION ?? env.DISCORD_REQUIRE_MENTION,
    true,
  );

  return {
    botToken,
    ...(accountId ? { accountId } : {}),
    ...(ownerUserId ? { ownerUserId } : {}),
    allowedUserIds,
    bindings,
    ...(homeChannelId
      ? {
          privateHomeRoute: {
            channelId: homeChannelId,
            ...(homeThreadId ? { threadId: homeThreadId } : {}),
          },
        }
      : {}),
    requireMention,
  };
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id = "discord" as const;

  private readonly config: DiscordConfig;
  private readonly clientFactory: DiscordClientFactory;
  private client: DiscordClientLike | undefined;
  private listenersAttached = false;
  private receiver: ChannelReceiver | undefined;
  private started = false;
  private accountId: string | undefined;
  private readonly onMessageBound: (...args: unknown[]) => void;
  private readonly onReadyBound: (...args: unknown[]) => void;
  private readonly onErrorBound: (...args: unknown[]) => void;

  constructor(config: DiscordConfig, options: DiscordChannelAdapterOptions = {}) {
    this.config = config;
    this.clientFactory = options.clientFactory ?? (() => createDiscordClient());
    this.client = options.client;
    this.accountId = config.accountId;
    this.onMessageBound = (...args) => {
      const message = args[0] as DiscordMessageLike | undefined;
      if (message) void this.handleMessage(message);
    };
    this.onReadyBound = () => {
      const id = this.client?.user?.id;
      if (id) this.accountId = id;
    };
    this.onErrorBound = () => {
      // Keep Discord's reconnecting event emitter from surfacing an unhandled error.
    };
  }

  async start(receive: ChannelReceiver): Promise<void> {
    if (this.started) return;

    const client = this.client ?? this.clientFactory();
    this.client = client;
    this.receiver = receive;
    this.started = true;
    this.attachListeners(client);

    try {
      await client.login(this.config.botToken);
      this.accountId = client.user?.id ?? this.accountId;
      if (!this.accountId) throw new Error("Discord client did not provide a bot account ID");
    } catch (error) {
      this.started = false;
      this.receiver = undefined;
      this.detachListeners(client);
      try {
        await client.destroy();
      } catch {
        // Preserve the original login/start error.
      }
      throw error;
    }
  }
  async stop(): Promise<void> {
    const client = this.client;
    if (!client || !this.started) return;

    this.started = false;
    this.receiver = undefined;
    this.detachListeners(client);
    await client.destroy();
  }

  async send(
    destination: ChannelDestination,
    message: OutboundChannelMessage,
  ): Promise<ChannelSendResult> {
    const client = this.client;
    if (!client || !this.started) {
      return { ok: false, error: "Discord adapter is not started", retryable: false };
    }
    const targetId = destination.threadId ?? destination.channelId;
    if (!targetId) {
      return { ok: false, error: "Discord destination channel is required", retryable: false };
    }

    let channel: DiscordSendableChannel | null;
    try {
      channel = await client.channels.fetch(targetId);
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error),
        retryable: isRetryableDiscordError(error),
      };
    }
    if (!channel || typeof channel.send !== "function") {
      return { ok: false, error: "Discord destination is not sendable", retryable: false };
    }

    if (message.attachments?.some((attachment) => !attachment.url)) {
      return {
        ok: false,
        error: "Discord attachments require a URL",
        retryable: false,
      };
    }

    const files = message.attachments?.map(toDiscordFile) ?? [];

    const chunks = splitDiscordText(message.text);
    let lastMessageId: string | undefined;
    try {
      for (const [index, text] of chunks.entries()) {
        const payload: Record<string, unknown> = { content: text };
        if (index === 0 && files.length > 0) payload.files = files;
        if (index === 0 && message.replyToId) {
          payload.reply = { messageReference: message.replyToId };
        }
        const sent = await channel.send(payload);
        lastMessageId = sent.id;
      }
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error),
        retryable: isRetryableDiscordError(error),
      };
    }

    return { ok: true, messageId: lastMessageId ?? message.id };
  }

  private async handleMessage(message: DiscordMessageLike): Promise<void> {
    if (!this.started || !this.receiver || !message.author) return;
    if (message.author.bot || message.author.system) return;
    if (message.author.id === this.accountId || message.author.id === this.client?.user?.id) return;

    const isGuild = Boolean(message.guildId);
    if (isGuild && this.config.requireMention && !this.mentionsBot(message)) return;

    const candidate = normalizeDiscordMessage(message, this.accountId);
    if (!candidate) return;

    try {
      await this.receiver(candidate);
    } catch {
      // A receiver failure must not terminate the Discord event listener.
    }
  }

  private mentionsBot(message: DiscordMessageLike): boolean {
    const botId = this.client?.user?.id ?? this.accountId;
    if (!botId) return false;
    if (message.mentions?.has?.(botId)) return true;
    const escapedId = botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<@!?${escapedId}>`).test(message.content ?? "");
  }

  private attachListeners(client: DiscordClientLike): void {
    if (this.listenersAttached) return;
    client.on("ready", this.onReadyBound);
    client.on("messageCreate", this.onMessageBound);
    client.on("error", this.onErrorBound);
    this.listenersAttached = true;
  }

  private detachListeners(client: DiscordClientLike): void {
    if (client.off) {
      client.off("ready", this.onReadyBound);
      client.off("messageCreate", this.onMessageBound);
      client.off("error", this.onErrorBound);
      this.listenersAttached = false;
    } else if (client.removeListener) {
      client.removeListener("ready", this.onReadyBound);
      client.removeListener("messageCreate", this.onMessageBound);
      client.removeListener("error", this.onErrorBound);
      this.listenersAttached = false;
    }
  }
}

export function normalizeDiscordMessage(
  message: DiscordMessageLike,
  accountId = "",
): InboundChannelMessage | undefined {
  if (!message.author?.id || !message.id || !message.channelId) return undefined;

  const isGuild = Boolean(message.guildId);
  const isThread = message.channel?.isThread?.() ?? Boolean(message.channel?.parentId);
  const channelId = isThread ? message.channel?.parentId ?? message.channelId : message.channelId;
  const threadId = isThread ? message.channelId : undefined;
  const occurredAt = message.createdTimestamp ?? message.createdAt?.getTime() ?? Date.now();

  return {
    id: message.id,
    identity: {
      provider: "discord",
      accountId,
      userId: message.author.id,
    },
    destination: {
      visibility: isGuild ? "shared" : "private",
      ...(message.guildId ? { scopeId: message.guildId } : {}),
      channelId,
      ...(threadId ? { threadId } : {}),
    },
    text: message.content ?? "",
    occurredAt,
    ...(message.reference?.messageId ? { replyToId: message.reference.messageId } : {}),
    attachments: normalizeAttachments(message.attachments),
  };
}

export function splitDiscordText(text: string, maxLength = MAX_DISCORD_MESSAGE_LENGTH): string[] {
  if (maxLength <= 0) throw new RangeError("maxLength must be positive");
  if (text.length === 0) return [""];

  const chunks: string[] = [];
  let chunk = "";
  for (const codePoint of text) {
    if (chunk && chunk.length + codePoint.length > maxLength) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += codePoint;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function isRetryableDiscordError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    retryable?: unknown;
  };
  if (candidate.retryable === true) return true;
  const status = typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (typeof candidate.code === "string" && RETRYABLE_ERROR_CODES[candidate.code]) return true;
  if (typeof candidate.name === "string" && /(?:network|timeout|temporar|rate.?limit)/i.test(candidate.name)) return true;
  return false;
}

function createDiscordClient(): DiscordClientLike {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  }) as unknown as DiscordClientLike;
}

function normalizeAttachments(
  attachments: DiscordMessageLike["attachments"],
): ChannelAttachment[] {
  if (!attachments) return [];
  const iterable = "values" in attachments && typeof attachments.values === "function"
    ? attachments.values()
    : Symbol.iterator in Object(attachments)
      ? attachments as Iterable<DiscordAttachmentLike>
      : Object.values(attachments);
  return Array.from(iterable).flatMap((attachment, index) => {
    if (!attachment.url) return [];
    return [{
      id: attachment.id ?? attachment.url,
      name: attachment.name?.trim() || `attachment-${index + 1}`,
      ...(attachment.contentType ? { mediaType: attachment.contentType } : {}),
      url: attachment.url,
    }];
  });
}


function toDiscordFile(attachment: ChannelAttachment): { attachment: string; name: string } {
  return { attachment: attachment.url as string, name: attachment.name };
}

function readOptional(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readRequired(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  label: string,
): string {
  const value = readOptional(env, keys);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseBindings(value: string | undefined): DiscordBindingInput[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid Discord binding configuration");
  }
  if (!Array.isArray(parsed)) throw new Error("invalid Discord binding configuration");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid Discord binding configuration");
    const input = entry as Record<string, unknown>;
    const userId = typeof input.userId === "string" ? input.userId.trim() : "";
    if (!userId) throw new Error("invalid Discord binding configuration");
    const accountId = typeof input.accountId === "string" ? input.accountId.trim() : undefined;
    const scopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : undefined;
    const channelId = typeof input.channelId === "string" ? input.channelId.trim() : undefined;
    const principalId = typeof input.principalId === "string" ? input.principalId.trim() : undefined;
    const ownerId = typeof input.ownerId === "string" ? input.ownerId.trim() : undefined;
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : undefined;
    return {
      userId,
      ...(accountId ? { accountId } : {}),
      ...(scopeId ? { scopeId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(principalId ? { principalId } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  });
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (/^(?:1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(?:0|false|no|off)$/i.test(value.trim())) return false;
  throw new Error("invalid Discord mention configuration");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Discord operation failed";
}
