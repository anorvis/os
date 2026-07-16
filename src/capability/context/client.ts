import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";
import { ConvexHttpClient } from "convex/browser";
import { getHomeDir } from "../../paths";
import { decodeUnknown } from "../../core/effect/schema";
import { api } from "../../../convex/_generated/api";
import { ContextEventAttachmentSchema, type ContextEventInput, type ContextEventKind, type ContextSurface } from "./schema";

export type ContextScopeRequest = {
  kind: "owner" | "workspace" | "channel";
  ownerId?: string;
  workspaceId?: string;
  channelId?: string;
  scopeId?: string;
};
export type ContextAppendRequest = ContextEventInput & { workspaceId?: string };
export type ContextCompileRequest = {
  workspaceId?: string;
  scope: ContextScopeRequest;
  query?: string;
  since?: number;
  limit?: number;
};
export type ContextClaimRequest = {
  workspaceId?: string;
  scope?: ContextScopeRequest;
  consumer: string;
  since?: number;
  limit?: number;
  leaseMs?: number;
  surface?: ContextSurface;
  kind?: ContextEventKind;
};
export type ContextAckRequest = {
  workspaceId?: string;
  consumer: string;
  eventIds: readonly string[];
  claimToken?: string;
};
export type ContextSummaryRequest = {
  workspaceId?: string;
  scope: ContextScopeRequest;
  summary: string;
  updatedAt?: number;
};
export type ContextOutboundRequest = {
  workspaceId?: string;
  id: string;
  destination: {
    surface: ContextSurface;
    channelId: string;
    threadId?: string;
    conversationId?: string;
  };
  text: string;
  attachments?: Array<{
    id: string;
    name: string;
    mediaType?: string;
    url?: string;
  }>;
  replyToId?: string;
  nextAttemptAt?: number;
};
export type ContextClaimOutboundRequest = {
  workspaceId?: string;
  consumer: string;
  limit?: number;
  leaseMs?: number;
};
export type ContextCompleteOutboundRequest = {
  workspaceId?: string;
  id?: string;
  messageId?: string;
  consumer?: string;
  claimToken?: string;
  success?: boolean;
  ok?: boolean;
  retryable?: boolean;
  error?: string;
  retryAt?: number;
};
export type ContextEventRecord = ContextEventInput & {
  _id?: string;
  workspaceId?: string;
  ownerId?: string;
};
export type ContextClaimedEvent = {
  event: ContextEventRecord;
  claimToken: string;
  batchId?: string;
  attempts: number;
  leaseUntil: number;
};
export type ContextCompileResult = {
  scope: ContextScopeRequest;
  summaries: Array<{
    summary: string;
    scopeKind?: string;
    scopeId?: string;
    visibility?: "private" | "shared";
    channelId?: string;
    updatedAt?: number;
    summaryId?: string;
  }>;
  events: ContextEventRecord[];
  wikiPages: Array<{ pageId?: string; path: string; title: string }>;
};
export type ContextOutboundRecord = ContextOutboundRequest & {
  status: "queued" | "claimed" | "completed" | "failed";
  attempts: number;
  claimToken: string;
  leaseUntil: number;
  messageId?: string;
};
export type ContextClaimFence = { eventId: string; claimToken: string };
export type ContextRenewClaimRequest = {
  workspaceId?: string;
  consumer: string;
  claims: readonly ContextClaimFence[];
  leaseMs?: number;
};
export type ContextRenewClaimResult = {
  claims: readonly ContextClaimFence[];
  leaseUntil: number;
};
export type ContextMonitorEffectKind = "summary" | "wiki" | "notification";
export type ContextMonitorEffectRequest = {
  workspaceId?: string;
  consumer: string;
  effectKey: string;
  kind: ContextMonitorEffectKind;
  claims: readonly ContextClaimFence[];
  scope: ContextScopeRequest;
  summary?: string;
  wikiTask?: string;
  notification?: Omit<ContextOutboundRequest, "id">;
};
export type ContextMonitorEffectResult = {
  effectKey: string;
  status: "pending" | "running" | "completed" | "replayed" | "needs_reconciliation";
};
export type ContextMonitorWikiJob = {
  effectKey: string;
  wikiTask: string;
  jobClaimToken: string;
  leaseUntil: number;
};
export type ContextClaimMonitorWikiEffectsRequest = {
  workspaceId?: string;
  consumer: string;
  limit?: number;
  leaseMs?: number;
};
export type ContextCompleteMonitorWikiEffectRequest = {
  workspaceId?: string;
  consumer: string;
  effectKey: string;
  jobClaimToken: string;
  success: boolean;
  result?: string;
  error?: string;
};
export type ContextCapabilityClient = {
  append(input: ContextAppendRequest): Promise<unknown>;
  compile(input: ContextCompileRequest): Promise<unknown>;
  claim?(input: ContextClaimRequest): Promise<readonly ContextClaimedEvent[]>;
  ack?(input: ContextAckRequest): Promise<{ acknowledged: number; cursor: number }>;
  saveSummary?(input: ContextSummaryRequest): Promise<{ summaryId?: string; inserted: boolean }>;
  enqueueOutbound(input: ContextOutboundRequest): Promise<unknown>;
  claimOutbound?(input: ContextClaimOutboundRequest): Promise<readonly ContextOutboundRecord[]>;
  completeOutbound?(input: ContextCompleteOutboundRequest): Promise<{
    id: string;
    status: "completed" | "queued" | "failed";
    attempts: number;
  }>;
  renewClaim?(input: ContextRenewClaimRequest): Promise<ContextRenewClaimResult>;
  commitMonitorEffect?(input: ContextMonitorEffectRequest): Promise<ContextMonitorEffectResult>;
  claimMonitorWikiEffects?(input: ContextClaimMonitorWikiEffectsRequest): Promise<readonly ContextMonitorWikiJob[]>;
  completeMonitorWikiEffect?(input: ContextCompleteMonitorWikiEffectRequest): Promise<ContextMonitorEffectResult>;
};

type ConvexTransport = {
  query(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  action(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
  setAuth?: (token: string) => void;
};
export type ConvexAuthSession = { token: string; refreshToken: string };
export type ContextClientOptions = {
  url?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  sessionPath?: string;
  setupKeyPath?: string;
  client?: ConvexTransport;
  authRequired?: boolean;
};

const appendResultSchema = Schema.Struct({
  id: Schema.String,
  eventId: Schema.optional(Schema.String),
  inserted: Schema.Boolean,
});
const sourceSchema = Schema.Struct({
  surface: Schema.Literal("pi", "discord", "web", "sms", "integration", "system"),
  principalId: Schema.optional(Schema.String),
  conversationId: Schema.String,
  visibility: Schema.Literal("private", "shared"),
  workspaceId: Schema.optional(Schema.String),
  channelId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
});
const contentSchema = Schema.Struct({
  text: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  assistant: Schema.optional(Schema.Unknown),
  toolResults: Schema.optional(Schema.Unknown),
  resource: Schema.optional(Schema.String),
  resourceId: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(ContextEventAttachmentSchema)),
});
const eventSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("conversation_turn", "integration_update", "agent_action", "context_note"),
  occurredAt: Schema.Number,
  source: sourceSchema,
  content: contentSchema,
  _id: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  ownerId: Schema.optional(Schema.String),
});
const scopeSchema = Schema.Struct({
  kind: Schema.Literal("owner", "workspace", "channel"),
  ownerId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  channelId: Schema.optional(Schema.String),
  scopeId: Schema.optional(Schema.String),
});
const compileResultSchema = Schema.Struct({
  scope: scopeSchema,
  summaries: Schema.Array(Schema.Struct({
    summary: Schema.String,
    scopeKind: Schema.optional(Schema.String),
    scopeId: Schema.optional(Schema.String),
    visibility: Schema.optional(Schema.Literal("private", "shared")),
    channelId: Schema.optional(Schema.String),
    updatedAt: Schema.optional(Schema.Number),
    summaryId: Schema.optional(Schema.String),
  })),
  events: Schema.Array(eventSchema),
  wikiPages: Schema.Array(Schema.Struct({
    pageId: Schema.optional(Schema.String),
    path: Schema.String,
    title: Schema.String,
  })),
});
const claimedEventSchema = Schema.Struct({
  event: eventSchema,
  claimToken: Schema.String,
  batchId: Schema.optional(Schema.String),
  attempts: Schema.Number,
  leaseUntil: Schema.Number,
});
const ackResultSchema = Schema.Struct({ acknowledged: Schema.Number, cursor: Schema.Number });
const summaryResultSchema = Schema.Struct({ summaryId: Schema.optional(Schema.String), inserted: Schema.Boolean });
const outboundEnqueueResultSchema = Schema.Struct({
  id: Schema.String,
  messageId: Schema.optional(Schema.String),
  inserted: Schema.Boolean,
});
const outboundSchema = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  destination: Schema.Struct({
    surface: Schema.Literal("pi", "discord", "web", "sms", "integration", "system"),
    channelId: Schema.String,
    threadId: Schema.optional(Schema.String),
    conversationId: Schema.optional(Schema.String),
  }),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    mediaType: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
  }))),
  replyToId: Schema.optional(Schema.String),
  nextAttemptAt: Schema.optional(Schema.Number),
  status: Schema.Literal("queued", "claimed", "completed", "failed"),
  attempts: Schema.Number,
  claimToken: Schema.String,
  leaseUntil: Schema.Number,
  messageId: Schema.optional(Schema.String),
});
const completeResultSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("completed", "queued", "failed"),
  attempts: Schema.Number,
});
const renewClaimResultSchema = Schema.Struct({
  claims: Schema.Array(Schema.Struct({ eventId: Schema.String, claimToken: Schema.String })),
  leaseUntil: Schema.Number,
});
const monitorEffectResultSchema = Schema.Struct({
  effectKey: Schema.String,
  status: Schema.Literal("pending", "running", "completed", "replayed", "needs_reconciliation"),
});
const monitorWikiJobSchema = Schema.Struct({
  effectKey: Schema.String,
  wikiTask: Schema.String,
  jobClaimToken: Schema.String,
  leaseUntil: Schema.Number,
});

export function resolveConvexUrl(
  env: Record<string, string | undefined> = process.env,
  home = getHomeDir(),
): string {
  const explicit = env.ANORVIS_CONVEX_URL?.trim() || env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (explicit) return explicit;
  try {
    const decoded: unknown = JSON.parse(readFileSync(`${home}/.anorvis/convex/deployment.json`, "utf8"));
    if (isRecord(decoded) && typeof decoded.url === "string" && decoded.url.trim()) return decoded.url.trim();
  } catch {
    // A deployment registry is optional.
  }
  return "http://127.0.0.1:3210";
}

export function convexAuthSessionPath(home = getHomeDir()): string {
  return `${home}/.anorvis/convex/session.json`;
}
export function convexLegacyAuthSessionPath(home = getHomeDir()): string {
  return `${home}/.anorvis/convex/auth-token`;
}
export function convexSetupKeyPath(home = getHomeDir()): string {
  return `${home}/.anorvis/convex-setup-key`;
}
export function readConvexSession(path = convexAuthSessionPath()): ConvexAuthSession | null {
  try {
    return parseAuthTokens(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}
export function writeConvexSession(session: ConvexAuthSession, path = convexAuthSessionPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

function convexTokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1_000 : null;
  } catch {
    return null;
  }
}

export function isConvexTokenValid(token: string): boolean {
  const expiresAt = convexTokenExpiry(token);
  return expiresAt !== null && expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS;
}

function isUnauthenticatedError(error: unknown): boolean {
  const unauthenticatedMessage = /unauthenticated|unauthorized|authentication required|sign in is required|invalid token|token expired/i;
  if (isRecord(error)) {
    const status = error.status ?? error.statusCode ?? error.httpStatus;
    if (status === 401 || status === "401") return true;
    const code = error.code;
    if (typeof code === "string" && unauthenticatedMessage.test(code)) return true;
    const data = error.data;
    if (isRecord(data)) {
      const nestedCode = data.code;
      if (typeof nestedCode === "string" && unauthenticatedMessage.test(nestedCode)) return true;
      const nestedMessage = data.message;
      if (typeof nestedMessage === "string" && unauthenticatedMessage.test(nestedMessage)) return true;
    }
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : "";
  return unauthenticatedMessage.test(message);
}

export class ConvexContextClient implements ContextCapabilityClient {
  private readonly options: ContextClientOptions;
  private transport: ConvexTransport | undefined;
  private authPromise: Promise<void> | undefined;
  private authToken: string | undefined;
  private authTokenExpiresAt: number | null | undefined;
  private authGeneration = 0;
  constructor(options: ContextClientOptions = {}) {
    this.options = options;
    this.transport = options.client;
  }
  append(input: ContextAppendRequest) {
    return this.invoke<{ id: string; eventId?: string; inserted: boolean }, ContextAppendRequest>("mutation", api.capability.context.append, input, appendResultSchema);
  }
  compile(input: ContextCompileRequest) {
    return this.invoke<ContextCompileResult, ContextCompileRequest>("query", api.capability.context.compile, input, compileResultSchema);
  }
  renewClaim(input: ContextRenewClaimRequest) {
    return this.invoke<ContextRenewClaimResult, ContextRenewClaimRequest>("mutation", api.capability.context.renewClaim, input, renewClaimResultSchema);
  }
  commitMonitorEffect(input: ContextMonitorEffectRequest) {
    return this.invoke<ContextMonitorEffectResult, ContextMonitorEffectRequest>("mutation", api.capability.context.commitMonitorEffect, input, monitorEffectResultSchema);
  }
  claimMonitorWikiEffects(input: ContextClaimMonitorWikiEffectsRequest) {
    return this.invoke<readonly ContextMonitorWikiJob[], ContextClaimMonitorWikiEffectsRequest>("mutation", api.capability.context.claimMonitorWikiEffects, input, Schema.Array(monitorWikiJobSchema));
  }
  completeMonitorWikiEffect(input: ContextCompleteMonitorWikiEffectRequest) {
    return this.invoke<ContextMonitorEffectResult, ContextCompleteMonitorWikiEffectRequest>("mutation", api.capability.context.completeMonitorWikiEffect, input, monitorEffectResultSchema);
  }
  claim(input: ContextClaimRequest) {
    return this.invoke<readonly ContextClaimedEvent[], ContextClaimRequest>("mutation", api.capability.context.claim, input, Schema.Array(claimedEventSchema));
  }
  ack(input: ContextAckRequest) {
    return this.invoke<{ acknowledged: number; cursor: number }, ContextAckRequest>("mutation", api.capability.context.ack, input, ackResultSchema);
  }
  saveSummary(input: ContextSummaryRequest) {
    return this.invoke<{ summaryId?: string; inserted: boolean }, ContextSummaryRequest>("mutation", api.capability.context.saveSummary, input, summaryResultSchema);
  }
  enqueueOutbound(input: ContextOutboundRequest) {
    return this.invoke<{ id: string; messageId?: string; inserted: boolean }, ContextOutboundRequest>("mutation", api.capability.context.enqueueOutbound, input, outboundEnqueueResultSchema);
  }
  claimOutbound(input: ContextClaimOutboundRequest) {
    return this.invoke<readonly ContextOutboundRecord[], ContextClaimOutboundRequest>("mutation", api.capability.context.claimOutbound, input, Schema.Array(outboundSchema));
  }
  completeOutbound(input: ContextCompleteOutboundRequest) {
    return this.invoke<{ id: string; status: "completed" | "queued" | "failed"; attempts: number }, ContextCompleteOutboundRequest>("mutation", api.capability.context.completeOutbound, input, completeResultSchema);
  }
  private async invoke<A, I>(
    kind: "query" | "mutation",
    reference: unknown,
    input: I,
    resultSchema: unknown,
  ): Promise<A> {
    await this.ensureAuthenticated();
    const transport = this.transport;
    if (!transport) throw new Error("Convex client is unavailable");
    const authGeneration = this.authGeneration;
    let result: unknown;
    try {
      result = kind === "query"
        ? await transport.query(reference, input as Record<string, unknown>)
        : await transport.mutation(reference, input as Record<string, unknown>);
    } catch (error) {
      if (this.options.authRequired === false || !isUnauthenticatedError(error)) throw error;
      const sameAuthentication = authGeneration === this.authGeneration;
      if (sameAuthentication) this.clearAuthentication();
      await this.ensureAuthenticated(sameAuthentication);
      result = kind === "query"
        ? await transport.query(reference, input as Record<string, unknown>)
        : await transport.mutation(reference, input as Record<string, unknown>);
    }
    return decodeUnknown(resultSchema as Schema.Schema<A, never, never>, result);
  }
  private async ensureAuthenticated(force = false): Promise<void> {
    if (this.options.authRequired === false) {
      if (!this.transport) this.transport = await this.newTransport();
      return;
    }
    if (!force && this.hasValidCachedAuthentication()) return;
    if (!this.authPromise) {
      const authentication = this.authenticate(force);
      this.authPromise = authentication;
      try {
        await authentication;
      } finally {
        if (this.authPromise === authentication) this.authPromise = undefined;
      }
      return;
    }
    await this.authPromise;
  }
  private hasValidCachedAuthentication(): boolean {
    if (!this.authToken) return false;
    if (this.authTokenExpiresAt === null || this.authTokenExpiresAt === undefined) return true;
    return this.authTokenExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS;
  }
  private clearAuthentication(): void {
    this.authToken = undefined;
    this.authTokenExpiresAt = undefined;
    this.authGeneration += 1;
  }
  private rememberAuthentication(token: string): void {
    this.authToken = token;
    this.authTokenExpiresAt = convexTokenExpiry(token);
    this.authGeneration += 1;
  }
  private async authenticate(force = false): Promise<void> {
    this.clearAuthentication();
    if (!this.transport) this.transport = await this.newTransport();
    const env = this.options.env ?? process.env;
    const envToken = env.ANORVIS_CONVEX_AUTH_TOKEN?.trim();
    if (envToken) {
      this.transport.setAuth?.(envToken);
      this.rememberAuthentication(envToken);
      return;
    }
    const home = this.options.home ?? getHomeDir();
    const sessionPath = this.options.sessionPath ?? convexAuthSessionPath(home);
    const session = readConvexSession(sessionPath) ?? readConvexSession(this.options.sessionPath ?? convexLegacyAuthSessionPath(home));
    if (!force && session && isConvexTokenValid(session.token)) {
      this.transport.setAuth?.(session.token);
      this.rememberAuthentication(session.token);
      return;
    }
    if (session?.refreshToken) {
      try {
        const refreshed = parseAuthTokens(await this.transport.action("auth:signIn", { refreshToken: session.refreshToken }));
        if (refreshed) {
          this.adoptSession(refreshed);
          return;
        }
      } catch {
        // Try the machine key when refresh is rejected.
      }
    }
    let key = "";
    try {
      key = readFileSync(this.options.setupKeyPath ?? convexSetupKeyPath(home), "utf8").trim();
    } catch {
      // No machine key configured.
    }
    if (key) {
      try {
        const local = parseAuthTokens(await this.transport.action("auth:signIn", {
          provider: "local-key",
          params: { key },
        }));
        if (local) {
          this.adoptSession(local);
          return;
        }
      } catch {
        // Report a stable error below.
      }
    }
    throw new Error("Convex authentication is required. Set ANORVIS_CONVEX_AUTH_TOKEN or connect this machine.");
  }
  private adoptSession(session: ConvexAuthSession): void {
    const home = this.options.home ?? getHomeDir();
    writeConvexSession(session, this.options.sessionPath ?? convexAuthSessionPath(home));
    this.transport?.setAuth?.(session.token);
    this.rememberAuthentication(session.token);
  }
  private async newTransport(): Promise<ConvexTransport> {
    return Promise.resolve(new ConvexHttpClient(
      this.options.url ?? resolveConvexUrl(this.options.env ?? process.env, this.options.home ?? getHomeDir()),
    ));
  }
}

export function createContextClient(options: ContextClientOptions = {}): ContextCapabilityClient {
  return new ConvexContextClient(options);
}
export function hasConvexConfiguration(
  env: Record<string, string | undefined> = process.env,
  home = getHomeDir(),
): boolean {
  if (env.ANORVIS_CONVEX_URL || env.NEXT_PUBLIC_CONVEX_URL || env.ANORVIS_CONVEX_AUTH_TOKEN) return true;
  try {
    return Boolean(
      readConvexSession(convexAuthSessionPath(home)) ||
      readConvexSession(convexLegacyAuthSessionPath(home)) ||
      readFileSync(`${home}/.anorvis/convex/deployment.json`, "utf8"),
    );
  } catch {
    return false;
  }
}
function parseAuthTokens(value: unknown): ConvexAuthSession | null {
  if (!isRecord(value)) return null;
  const tokens = isRecord(value.tokens) ? value.tokens : value;
  return typeof tokens.token === "string" && tokens.token.trim() &&
    typeof tokens.refreshToken === "string" && tokens.refreshToken.trim()
    ? { token: tokens.token, refreshToken: tokens.refreshToken }
    : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
