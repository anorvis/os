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

type CreateServerOptions = {
  port?: number;
  hostname?: string;
};

export type CreateAppOptions = {
  wikiAgent?: NonNullable<Parameters<typeof runWikiAgent>[1]>["wikiAgent"];
  config?: LocalAuthorityConfig;
};

export type App = {
  fetch(request: Request): Promise<Response>;
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

type AppServiceContext = {
  config: LocalAuthorityConfig;
  now(): Date;
  wikiAgent?: NonNullable<Parameters<typeof runWikiAgent>[1]>["wikiAgent"];
  serviceIds?: () => string[];
};

export function createApp(options: CreateAppOptions = {}): App {
  const config = options.config ?? readLocalAuthorityConfig();
  let serviceIds: string[] = [];
  const context: AppServiceContext = {
    config,
    now: () => new Date(),
    wikiAgent: options.wikiAgent,
    serviceIds: () => serviceIds,
  };
  const registry = createServiceRegistry(context, serviceFactories);
  serviceIds = registry.serviceIds;

  const app = new Hono();
  app.use("*", cors());
  app.onError((error) => json({ error: error instanceof Error ? error.message : String(error) }, 500));

  app.get("/health", () => json({ ok: true }));
  app.post("/v1/auth/handshake", (c) => authHandshake(c.req.raw));

  app.use("*", async (c, next) => {
    const unauthorized = authorize(c.req.raw, new URL(c.req.url), config);
    if (unauthorized) return unauthorized;
    await next();
  });

  for (const register of registry.routes) register(app);

  app.notFound(() => json({ error: "not_found" }, 404));

  const fetch = (request: Request): Promise<Response> => Promise.resolve(app.fetch(request));

  return {
    fetch,
    request(input, init) {
      const request = typeof input === "string" ? new Request(`http://127.0.0.1${input}`, init) : input;
      return fetch(request);
    },
  };
}

export function createServer(options: CreateServerOptions = {}) {
  const config = readLocalAuthorityConfig();
  const port = options.port ?? config.port;
  const hostname = options.hostname ?? config.bindHost;
  const app = createApp({ config });
  const server = Bun.serve({
    port,
    hostname,
    fetch: (request) => app.fetch(request),
  });
  return { app, server };
}

async function authHandshake(request: Request): Promise<Response> {
  if (!isAllowedHandshakeOrigin(request))
    return json({ error: "origin not allowed" }, 403);
  if (process.env.ANORVIS_OS_API_TOKEN || readToken())
    return json({ error: "token already configured" }, 409);
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
    return requiresConfiguredToken(config)
      ? json({ error: "auth_token_required" }, 503)
      : undefined;
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

function isAllowedHandshakeOrigin(request: Request): boolean {
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
