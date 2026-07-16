import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readLocalAuthorityConfig, type LocalAuthorityConfig } from "../../core/config/local-authority";
import { corsHeaders, isJsonObject, json, parseJsonRequest } from "../../core/http/http";
import { createServiceRegistry } from "../../core/service/service";
import { runWikiAgent } from "../../llm-wiki";
import { getHomeDir } from "../../paths";
import { serviceFactories } from "../../registry";
import type { MaintenanceSessionRoots } from "../../capability/maintenance";
import type { ContextCapabilityClient } from "../../capability/context/client";
import { createContextClient, hasConvexConfiguration } from "../../capability/context/client";
import { ContextGatewayRuntime } from "../../capability/context/gateway-runtime";
import {
  ContextMonitorRuntime,
  ContextOutboundRuntime,
  type ContextRuntimeClient,
  type OwnerNotificationDestination,
} from "../../capability/context/runtime";
import { DiscordContextRuntime } from "../../capability/context/runtime";
import { DiscordChannelAdapter, parseDiscordConfig, type DiscordConfig } from "../channel/discord";
import type { ChannelAdapter } from "../channel/channel";
import type { ChannelBinding } from "../channel/authorization";

export type CreateServerOptions = {
  port?: number;
  hostname?: string;
  contextClient?: ContextCapabilityClient;
  runtime?: ContextGatewayRuntime;
  startRuntime?: boolean;
  runtimeRetryDelayMs?: number;
};
export type CreateAppOptions = {
  wikiAgent?: NonNullable<Parameters<typeof runWikiAgent>[1]>["wikiAgent"];
  config?: LocalAuthorityConfig;
  contextClient?: ContextCapabilityClient;
  runtime?: ContextGatewayRuntime;
  maintenanceRoot?: string;
  maintenanceSessionRoots?: MaintenanceSessionRoots;
};

export type App = {
  fetch(request: Request): Promise<Response>;
  request(input: string | Request, init?: RequestInit): Promise<Response>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type AppLifecycle = "idle" | "starting" | "ready" | "failed" | "stopped";
type AppServiceContext = {
  config: LocalAuthorityConfig;
  now(): Date;
  wikiAgent?: NonNullable<Parameters<typeof runWikiAgent>[1]>["wikiAgent"];
  contextClient?: ContextCapabilityClient;
  maintenanceRoot?: string;
  maintenanceSessionRoots?: MaintenanceSessionRoots;
  serviceIds?: () => string[];
};

export function createApp(options: CreateAppOptions = {}): App {
  const config = options.config ?? readLocalAuthorityConfig();
  let serviceIds: string[] = [];
  let lifecycle: AppLifecycle = "idle";
  let startupError: unknown;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const context: AppServiceContext = {
    config,
    now: () => new Date(),
    wikiAgent: options.wikiAgent,
    contextClient: options.contextClient,
    maintenanceRoot: options.maintenanceRoot,
    maintenanceSessionRoots: options.maintenanceSessionRoots,
    serviceIds: () => serviceIds,
  };
  const registry = createServiceRegistry(context, serviceFactories);
  serviceIds = registry.serviceIds;

  const stopRuntime = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = Promise.resolve(options.runtime?.stop());
    await stopPromise;
  };

  const app = new Hono();
  app.use("*", cors());
  app.onError((error) => json({ error: error instanceof Error ? error.message : String(error) }, 500));
  app.get("/health", () => {
    if (lifecycle === "starting") return json({ ok: false, error: "gateway_starting" }, 503);
    if (lifecycle === "failed") {
      const error = startupError instanceof Error ? startupError.message : String(startupError);
      return json({ ok: false, error }, 503);
    }
    return json({ ok: true });
  });
  app.post("/v1/auth/handshake", (c) => authHandshake(c.req.raw, config));
  app.use("*", async (c, next) => {
    const unauthorized = authorize(c.req.raw, new URL(c.req.url), config);
    if (unauthorized) return unauthorized;
    await next();
  });
  for (const register of registry.routes) register(app);
  app.notFound(() => json({ error: "not_found" }, 404));
  const fetch = (request: Request): Promise<Response> => Promise.resolve(app.fetch(request));
  const start = async (): Promise<void> => {
    if (lifecycle === "ready") return;
    if (lifecycle === "starting" && startPromise) return startPromise;
    if (lifecycle === "failed" || lifecycle === "stopped") {
      lifecycle = "idle";
      startupError = undefined;
      startPromise = undefined;
      stopPromise = undefined;
    }
    lifecycle = "starting";
    startPromise = (async () => {
      try {
        await options.runtime?.start();
        lifecycle = "ready";
      } catch (error) {
        startupError = error;
        lifecycle = "failed";
        try {
          await stopRuntime();
        } catch (cleanupError) {
          console.error(
            `anorvis: gateway runtime cleanup failed after startup rejection: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        }
        throw error;
      }
    })();
    return startPromise;
  };
  const stop = async (): Promise<void> => {
    if (lifecycle === "stopped") return;
    if (lifecycle === "starting" && startPromise) {
      try {
        await startPromise;
      } catch {
        // Startup performs runtime cleanup before exposing its rejection.
      }
    }
    await stopRuntime();
    lifecycle = "stopped";
  };
  return {
    fetch,
    request(input, init) {
      const request = typeof input === "string" ? new Request(`http://127.0.0.1${input}`, init) : input;
      return fetch(request);
    },
    start,
    stop,
  };
}


export function createServer(options: CreateServerOptions = {}) {
  const config = readLocalAuthorityConfig();
  const port = options.port ?? config.port;
  const hostname = options.hostname ?? config.bindHost;
  const contextClient = options.contextClient ?? (hasConvexConfiguration() ? createContextClient() : undefined);
  const runtime = options.runtime ?? createConfiguredRuntime(contextClient);
  const app = createApp({ config: { ...config, bindHost: hostname }, contextClient, runtime });
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 120,
    fetch: (request) => app.fetch(request),
  });
  // Convex often finishes booting after the gateway binds; keep the HTTP
  // surface alive and converge the context runtime with bounded backoff
  // instead of tearing the whole process down on a transient start failure.
  let stopping = false;
  let wake: (() => void) | undefined;
  const ready = (async () => {
    if (options.startRuntime === false) return;
    let delayMs = options.runtimeRetryDelayMs ?? 5_000;
    while (!stopping) {
      try {
        await app.start();
        return;
      } catch (error) {
        if (stopping) return;
        console.error(
          `anorvis: context runtime start failed (retrying in ${Math.round(delayMs / 1000)}s): ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        delayMs = Math.min(delayMs * 2, 60_000);
      }
    }
  })();

  const stop = async () => {
    stopping = true;
    wake?.();
    await ready;
    await app.stop();
    await server.stop();
  };
  return { app, server, ready, stop };
}
export type WorkspaceGatewayRuntimeOptions = {
  contextClient: ContextRuntimeClient;
  workspaceIds: readonly string[];
  ownerDestinations?: readonly OwnerNotificationDestination[];
  adapters?: readonly ChannelAdapter[];
  discord?: DiscordContextRuntime;
};

/**
 * Compose one isolated monitor and outbound worker pair for every workspace.
 * The singular gateway runtime remains responsible for globally ordered
 * monitor/inbound stop, outbound drain, and adapter teardown.
 */
export function createWorkspaceGatewayRuntime(
  options: WorkspaceGatewayRuntimeOptions,
): ContextGatewayRuntime {
  const workspaceIds = uniqueWorkspaceIds(options.workspaceIds);
  const partitions: readonly (string | undefined)[] = workspaceIds.length ? workspaceIds : [undefined];
  const monitors = partitions.map((workspaceId) =>
    new ContextMonitorRuntime({
      contextClient: options.contextClient,
      ...(workspaceId ? { workspaceId, consumer: workspaceConsumer("monitor", workspaceId) } : {}),
      ownerDestinations: (options.ownerDestinations ?? []).filter((destination) =>
        workspaceId ? destination.workspaceId === workspaceId : destination.workspaceId === undefined,
      ),
    }),
  );
  const outbounds = partitions.map((workspaceId) =>
    new ContextOutboundRuntime({
      contextClient: options.contextClient,
      adapters: options.adapters ?? [],
      ...(workspaceId ? { workspaceId, consumer: workspaceConsumer("outbound", workspaceId) } : {}),
    }),
  );
  return new ContextGatewayRuntime({
    monitor: new MonitorCollection(monitors),
    outbound: new OutboundCollection(outbounds),
    ...(options.discord ? { discord: options.discord } : {}),
  });
}

class MonitorCollection {
  constructor(private readonly runtimes: readonly ContextMonitorRuntime[]) {}

  async start(): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of this.runtimes) {
      try {
        await runtime.start();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollectionErrors(errors, "Context monitor startup failed");
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of this.runtimes) {
      try {
        await runtime.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollectionErrors(errors, "Context monitor shutdown failed");
  }
}

class OutboundCollection {
  constructor(private readonly runtimes: readonly ContextOutboundRuntime[]) {}

  async start(): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of this.runtimes) {
      try {
        await runtime.start();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollectionErrors(errors, "Context outbound startup failed");
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of this.runtimes) {
      try {
        await runtime.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollectionErrors(errors, "Context outbound shutdown failed");
  }

  async drain(): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of this.runtimes) {
      try {
        await runtime.drain();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollectionErrors(errors, "Context outbound drain failed");
  }
}

function throwCollectionErrors(errors: readonly unknown[], message: string): void {
  if (!errors.length) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

function workspaceConsumer(kind: "monitor" | "outbound", workspaceId: string): string {
  return `os-${kind}:${encodeURIComponent(workspaceId)}`;
}

function uniqueWorkspaceIds(workspaceIds: readonly string[]): string[] {
  return [...new Set(workspaceIds.map((workspaceId) => workspaceId.trim()).filter(Boolean))];
}

function configuredWorkspaceIds(bindings: readonly ChannelBinding[]): string[] {
  return uniqueWorkspaceIds(bindings.flatMap((binding) => binding.workspaceId ? [binding.workspaceId] : []));
}


function createConfiguredRuntime(client: ContextCapabilityClient | undefined): ContextGatewayRuntime | undefined {
  if (
    !client ||
    typeof client.append !== "function" ||
    typeof client.compile !== "function" ||
    typeof client.enqueueOutbound !== "function" ||
    typeof client.claim !== "function" ||
    typeof client.ack !== "function" ||
    typeof client.saveSummary !== "function" ||
    typeof client.claimOutbound !== "function" ||
    typeof client.completeOutbound !== "function" ||
    typeof client.renewClaim !== "function" ||
    typeof client.claimMonitorWikiEffects !== "function" ||
    typeof client.completeMonitorWikiEffect !== "function" ||
    typeof client.commitMonitorEffect !== "function"
  ) return undefined;
  const richClient = client as ContextRuntimeClient;
  let bindings: ChannelBinding[] = [];
  const botToken = process.env.ANORVIS_DISCORD_BOT_TOKEN?.trim() || process.env.DISCORD_BOT_TOKEN?.trim();
  if (botToken) {
    try {
      const discordConfig = parseDiscordConfig();
      const configuredBindings = discordBindings(discordConfig);
      const adapter = new DiscordChannelAdapter(discordConfig);
      const discordRuntime = new DiscordContextRuntime({
        contextClient: client,
        adapter,
        bindings: configuredBindings,
      });
      bindings = configuredBindings;
      const workspaceIds = configuredWorkspaceIds(bindings);
      const ownerDestinations: OwnerNotificationDestination[] = discordConfig.privateHomeRoute
        ? (workspaceIds.length
          ? workspaceIds.map((workspaceId) => ({
              visibility: "private" as const,
              surface: "discord" as const,
              workspaceId,
              channelId: discordConfig.privateHomeRoute!.channelId,
              ...(discordConfig.privateHomeRoute!.threadId ? { threadId: discordConfig.privateHomeRoute!.threadId } : {}),
            }))
          : [{
              visibility: "private" as const,
              surface: "discord" as const,
              channelId: discordConfig.privateHomeRoute.channelId,
              ...(discordConfig.privateHomeRoute.threadId ? { threadId: discordConfig.privateHomeRoute.threadId } : {}),
            }])
        : [];
      return createWorkspaceGatewayRuntime({
        contextClient: richClient,
        workspaceIds,
        ownerDestinations,
        adapters: [adapter],
        discord: discordRuntime,
      });
    } catch {
      // Invalid optional Discord configuration must not take down the gateway.
      bindings = [];
    }
  }
  return createWorkspaceGatewayRuntime({
    contextClient: richClient,
    workspaceIds: configuredWorkspaceIds(bindings),
  });
}

function discordBindings(config: DiscordConfig): ChannelBinding[] {
  const accountId = config.accountId ?? "";
  const configured = config.bindings.map((binding) => ({
    identity: {
      provider: "discord" as const,
      accountId: binding.accountId ?? accountId,
      userId: binding.userId,
    },
    principalId: binding.principalId ?? binding.ownerId ?? binding.userId,
    ...(binding.ownerId ? { ownerId: binding.ownerId } : config.ownerUserId ? { ownerId: config.ownerUserId } : {}),
    ...(binding.scopeId ? { scopeId: binding.scopeId } : {}),
    ...(binding.channelId ? { channelId: binding.channelId } : {}),
    ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
  }));
  for (const userId of config.allowedUserIds) {
    if (config.bindings.some((binding) => binding.userId === userId)) continue;
    configured.push({
      identity: { provider: "discord" as const, accountId, userId },
      principalId: userId,
      ...(config.ownerUserId ? { ownerId: config.ownerUserId } : {}),
    });
  }
  return configured;
}

async function authHandshake(request: Request, config: LocalAuthorityConfig): Promise<Response> {
  if (!isAllowedLocalOrigin(request))
    return json({ error: "origin not allowed" }, 403);
  const expected = process.env.ANORVIS_OS_API_TOKEN || readToken();
  if (expected) return json({ error: "token already configured" }, 409);
  if (requiresConfiguredToken(config)) return json({ error: "auth_token_required" }, 503);
  const parsed = await parseJsonRequest(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  if (
    !isJsonObject(parsed.value) ||
    typeof parsed.value.token !== "string" ||
    parsed.value.token.trim().length < 16
  ) {
    return json({ error: "token is required" }, 400);
  }
  const path = tokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${parsed.value.token.trim()}\n`, { mode: 0o600 });
  return json({ ok: true }, 201);
}

export function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export function requiresConfiguredToken(config: LocalAuthorityConfig): boolean {
  return !isLoopbackBindHost(config.bindHost);
}

function authorize(request: Request, url: URL, config: LocalAuthorityConfig): Response | undefined {
  const expected = process.env.ANORVIS_OS_API_TOKEN || readToken();
  if (!expected) {
    if (requiresConfiguredToken(config)) return json({ error: "auth_token_required" }, 503);
    return isAllowedLocalOrigin(request) ? undefined : json({ error: "origin not allowed" }, 403);
  }
  const actual =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("access_token") ||
    "";
  return actual === expected
    ? undefined
    : new Response("Unauthorized", { status: 401, headers: corsHeaders() });
}
 
function tokenPath(): string {
  return (
    process.env.ANORVIS_OS_API_TOKEN_PATH?.trim() ||
    join(getHomeDir(), ".anorvis", "os", "api-token")
  );
}
 
function readToken(): string {
  try {
    return readFileSync(tokenPath(), "utf8").trim();
  } catch {
    return "";
  }
}
 
function isAllowedLocalOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    process.env.NEXT_PUBLIC_APP_URL ?? "",
    process.env.ANORVIS_WEB_URL ?? "",
    ...(process.env.ANORVIS_OS_HANDSHAKE_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ]);
  if (allowed.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}
