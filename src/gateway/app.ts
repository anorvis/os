import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getHomeDir } from "../paths";
import { runWikiAgent } from "../llm-wiki";
import { corsHeaders, json, type RouteHandler } from "./http";
import { calendarRoutes } from "./routes/calendar";
import { eventRoutes } from "./routes/events";
import { financeRoutes } from "./routes/finance";
import { healthRoutes } from "./routes/health";
import { integrationRoutes } from "./routes/integrations";
import { lifeRoutes } from "./routes/life";
import { llmWikiRoutes } from "./routes/llm-wiki";
import { overviewRoutes } from "./routes/overview";
import { taskRoutes } from "./routes/tasks";

type CreateServerOptions = {
  port?: number;
  hostname?: string;
};

type CreateAppOptions = {
  wikiAgent?: NonNullable<Parameters<typeof runWikiAgent>[1]>["wikiAgent"];
};

type App = {
  fetch(request: Request): Promise<Response>;
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

export function createApp(options: CreateAppOptions = {}): App {
  const handlers: RouteHandler[] = [
    llmWikiRoutes(options),
    eventRoutes(),
    overviewRoutes(),
    integrationRoutes(),
    healthRoutes(),
    financeRoutes(),
    taskRoutes(),
    calendarRoutes(),
    lifeRoutes(),
  ];

  const fetch = async (request: Request): Promise<Response> => {
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

      const unauthorized = authorize(request);
      if (unauthorized) return unauthorized;

      for (const handler of handlers) {
        const response = await handler(request, url);
        if (response) return response;
      }

      return new Response("Not found", { status: 404, headers: corsHeaders() });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500, headers: corsHeaders() });
    }
  };

  return {
    fetch,
    request(input, init) {
      const request = typeof input === "string" ? new Request(`http://127.0.0.1${input}`, init) : input;
      return fetch(request);
    },
  };
}

export function createServer(options: CreateServerOptions = {}) {
  const port = options.port ?? Number(process.env.ANORVIS_OS_PORT ?? process.env.PORT ?? 8787);
  const hostname = options.hostname ?? process.env.ANORVIS_OS_HOST ?? "127.0.0.1";
  const app = createApp();
  const server = Bun.serve({ port, hostname, fetch: (request) => app.fetch(request) });
  return { app, server };
}

function authorize(request: Request): Response | undefined {
  const expected = process.env.ANORVIS_OS_API_TOKEN || readToken();
  if (!expected) return undefined;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return actual === expected ? undefined : new Response("Unauthorized", { status: 401, headers: corsHeaders() });
}

function readToken(): string {
  try {
    return readFileSync(join(getHomeDir(), ".anorvis", "os", "api-token"), "utf8").trim();
  } catch {
    return "";
  }
}
