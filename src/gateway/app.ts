import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getHomeDir } from "../paths";
import { initLlmWiki, lintLlmWiki, runWikiAgent, wikiResultAsJson } from "../llm-wiki";

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
  const fetch = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

      const unauthorized = authorize(request);
      if (unauthorized) return unauthorized;

      if (request.method === "POST" && url.pathname === "/v1/llm-wiki/init") return json(initLlmWiki());
      if (request.method === "POST" && url.pathname === "/v1/llm-wiki/wiki") {
        const body = await request.text().then((text) => JSON.parse(text) as unknown).catch(() => ({}));
        const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const task = typeof input.task === "string" && input.task.trim() ? input.task : "Orient the Anorvis LLM Wiki.";
        const vault = typeof input.vault === "string" && input.vault.trim() ? input.vault : undefined;
        const result = await runWikiAgent({ task, allowWeb: input.allowWeb === true, dryRun: input.dryRun === true, vault }, { wikiAgent: options.wikiAgent });
        return json(wikiResultAsJson(result));
      }
      if (request.method === "GET" && url.pathname === "/v1/llm-wiki/lint") return json(await lintLlmWiki());

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
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
  return actual === expected ? undefined : new Response("Unauthorized", { status: 401 });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function readToken(): string {
  try {
    return readFileSync(join(getHomeDir(), ".anorvis", "os", "api-token"), "utf8").trim();
  } catch {
    return "";
  }
}
