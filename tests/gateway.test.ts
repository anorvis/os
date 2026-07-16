import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createServer,
  createWorkspaceGatewayRuntime,
  type App,
  type CreateAppOptions,
} from "../src/platform/gateway/app";
import type { ContextGatewayRuntime } from "../src/capability/context/gateway-runtime";
import type { ContextRuntimeClient } from "../src/capability/context/runtime";
import type { ChannelAdapter } from "../src/platform/channel/channel";

type GatewayFixture = {
  app: App;
  home: string;
};

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "anorvis-gateway-"));
}

async function withIsolatedGateway(
  run: (fixture: GatewayFixture) => Promise<void>,
  options?: CreateAppOptions,
): Promise<void> {
  const environment = captureEnvironment(
    "HOME",
    "ANORVIS_OS_API_TOKEN",
    "ANORVIS_OS_API_TOKEN_PATH",
    "ANORVIS_OS_HANDSHAKE_ORIGINS",
  );
  const home = tmpHome();
  process.env.HOME = home;
  delete process.env.ANORVIS_OS_API_TOKEN;

  try {
    await run({ app: createApp(options), home });
  } finally {
    restoreEnvironment(environment);
  }
}

function captureEnvironment(
  ...keys: string[]
): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(
  environment: Map<string, string | undefined>,
): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("minimal Anorvis OS gateway", () => {
  test("serves health and wiki task route", async () => {
    await withIsolatedGateway(
      async ({ app }) => {
        const health = await app.request("/health");
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ ok: true });

        const wiki = await app.request("/v1/llm-wiki/wiki", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "Remember gateway test" }),
        });
        expect(wiki.status).toBe(200);
        const body = (await wiki.json()) as {
          answer?: string;
          changed?: Array<{ path: string }>;
        };
        expect(body.answer).toContain("Recorded task");
        expect(
          body.changed?.some((item) => item.path.startsWith("wiki/queries/")),
        ).toBe(true);
      },
      {
        wikiAgent: ({ task }) =>
          Promise.resolve({
            task,
            answer: "Recorded task through injected Pi Wiki Agent.",
            confidence: "high",
            sources: [],
            changed: [
              {
                path: "wiki/queries/gateway-test.md",
                action: "created",
                why: "test",
              },
            ],
            readNext: [],
            contradictions: [],
            gaps: [],
            warnings: [],
          }),
      },
    );
  });

  test("defaults wiki task for empty or non-object request bodies", async () => {
    const seenTasks: string[] = [];
    await withIsolatedGateway(
      async ({ app }) => {
        for (const body of ["", "[]", "\"x\"", "{not-json"]) {
          const wiki = await app.request("/v1/llm-wiki/wiki", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          expect(wiki.status).toBe(200);
        }
        expect(seenTasks).toEqual([
          "Orient the Anorvis LLM Wiki.",
          "Orient the Anorvis LLM Wiki.",
          "Orient the Anorvis LLM Wiki.",
          "Orient the Anorvis LLM Wiki.",
        ]);
      },
      {
        wikiAgent: ({ task }) => {
          seenTasks.push(task);
          return Promise.resolve({
            task,
            answer: "defaulted",
            confidence: "high",
            sources: [],
            changed: [],
            readNext: [],
            contradictions: [],
            gaps: [],
            warnings: [],
          });
        },
      },
    );
  });

  test("blocks cross-origin browser requests without a token but allows originless CLI POSTs", async () => {
    let wikiAgentCalls = 0;
    await withIsolatedGateway(
      async ({ app }) => {
        const malicious = await app.request("/v1/llm-wiki/wiki", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
          },
          body: JSON.stringify({ task: "must not execute" }),
        });
        expect(malicious.status).toBe(403);
        expect(await malicious.json()).toEqual({ error: "origin not allowed" });
        expect(wikiAgentCalls).toBe(0);

        const cli = await app.request("/v1/llm-wiki/wiki", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "run from CLI" }),
        });
        expect(cli.status).toBe(200);
        expect(wikiAgentCalls).toBe(1);
      },
      {
        wikiAgent: ({ task }) => {
          wikiAgentCalls += 1;
          return Promise.resolve({
            task,
            answer: "handled",
            confidence: "high",
            sources: [],
            changed: [],
            readNext: [],
            contradictions: [],
            gaps: [],
            warnings: [],
          });
        },
      },
    );
  });

  test("rejects tokenless handshakes on non-loopback binds", async () => {
    await withIsolatedGateway(
      async ({ app, home }) => {
        const handshake = await app.request("/v1/auth/handshake", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ token: "lan-takeover-token" }),
        });
        expect(handshake.status).toBe(503);
        expect(await handshake.json()).toEqual({
          error: "auth_token_required",
        });
        expect(() =>
          readFileSync(join(home, ".anorvis", "os", "api-token"), "utf8"),
        ).toThrow();
      },
      {
        config: {
          baseUrl: "http://192.0.2.10:8787",
          bindHost: "192.0.2.10",
          port: 8787,
          dataRoot: tmpdir(),
          tailnetName: null,
        },
      },
    );
  });

  test("requires a token when createServer overrides its bind host", async () => {
    await withIsolatedGateway(async () => {
      const server = createServer({
        hostname: "0.0.0.0",
        port: 0,
        startRuntime: false,
      });
      try {
        await server.ready;
        const handshake = await server.app.request("/v1/auth/handshake", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ token: "override-takeover-token" }),
        });
        expect(handshake.status).toBe(503);
        expect(await handshake.json()).toEqual({
          error: "auth_token_required",
        });
      } finally {
        await server.stop();
      }
    });
  });

  test("keeps serving and retries when the context runtime start fails", async () => {
    await withIsolatedGateway(async () => {
      let attempts = 0;
      const runtime = {
        start() {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("Convex authentication is required."));
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      };
      const server = createServer({
        port: 0,
        runtime: runtime as never,
        runtimeRetryDelayMs: 10,
      });
      try {
        await server.ready;
        expect(attempts).toBe(2);
        const health = await server.app.request("/health");
        expect(health.status).toBe(200);
      } finally {
        await server.stop();
      }
    });
  });

  test("handshakes a browser-local token before protected requests", async () => {
    await withIsolatedGateway(async ({ app, home }) => {
      const token = "web-test-browser-token";
      const handshake = await app.request("/v1/auth/handshake", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ token }),
      });
      expect(handshake.status).toBe(201);
      expect(await handshake.json()).toEqual({ ok: true });
      expect(
        readFileSync(join(home, ".anorvis", "os", "api-token"), "utf8").trim(),
      ).toBe(token);

      const unauthenticated = await app.request("/v1/os/status");
      expect(unauthenticated.status).toBe(401);

      const retiredToolkit = await app.request("/v1/os/toolkit", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(retiredToolkit.status).toBe(404);

      const authorized = await app.request("/v1/os/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);
      expect((await authorized.json()) as { ok: boolean }).toMatchObject({
        ok: true,
      });


      const retiredCrud = await app.request("/v1/overview", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(retiredCrud.status).toBe(404);

      const secondHandshake = await app.request("/v1/auth/handshake", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ token: "web-second-token" }),
      });
      expect(secondHandshake.status).toBe(409);
    });
  });

  test("records interaction turns through memory route", async () => {
    await withIsolatedGateway(
      async ({ app, home }) => {
        const response = await app.request("/v1/llm-wiki/interaction", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "gateway-session",
            turnIndex: 7,
            prompt: "Remember that gateway interactions should become memory.",
            assistant: { role: "assistant", content: "I will remember." },
            background: false,
          }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          ok?: boolean;
          rawPath?: string;
          queued?: boolean;
          wiki?: { answer?: string };
        };
        expect(body.ok).toBe(true);
        expect(body.queued).toBe(false);
        expect(body.wiki?.answer).toContain("Compiled gateway");
        expect(
          body.rawPath &&
            readFileSync(
              join(home, ".anorvis", "llm-wiki", body.rawPath),
              "utf8",
            ),
        ).toContain("gateway interactions should become memory");
      },
      {
        wikiAgent: ({ task, rootDir }) => {
          const rawPath = task.match(/Raw source: (raw\/[^\n]+)/)?.[1] ?? "";
          const page = "wiki/preferences/gateway-memory.md";
          mkdirSync(join(rootDir, "wiki", "preferences"), { recursive: true });
          writeFileSync(
            join(rootDir, page),
            `---\ntype: preference\ntitle: Gateway memory\ncreated: 2026-07-03\nupdated: 2026-07-03\nstatus: seed\ntags: []\nrelated: []\nsources: [${rawPath}]\n---\n\n# Gateway memory\n\nThe gateway can persist interaction memory.\n`,
          );
          return Promise.resolve({
            task,
            answer: "Compiled gateway interaction memory.",
            confidence: "high",
            sources: [{ path: rawPath, title: "Agent Interaction" }],
            changed: [{ path: page, action: "created", why: "test" }],
            readNext: [],
            contradictions: [],
            gaps: [],
            warnings: [],
          });
        },
      },
    );
  });

  test("rejects malformed or empty interaction memory payloads", async () => {
    let wikiAgentCalls = 0;
    await withIsolatedGateway(
      async ({ app }) => {
        const malformed = await app.request("/v1/llm-wiki/interaction", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not-json",
        });
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

        const empty = await app.request("/v1/llm-wiki/interaction", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "empty-session",
            background: false,
          }),
        });
        expect(empty.status).toBe(400);
        expect(await empty.json()).toEqual({
          error: "prompt, assistant, or interaction is required",
        });
        expect(wikiAgentCalls).toBe(0);
      },
      {
        wikiAgent: () => {
          wikiAgentCalls += 1;
          throw new Error(
            "wiki agent should not run for invalid interaction payloads",
          );
        },
      },
    );
  });

  test("does not expose retired SQLite CRUD routes", async () => {
    await withIsolatedGateway(async ({ app }) => {
      const preflight = await app.request("/v1/health/meals/example", {
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain(
        "PUT",
      );

      const missingSession = await app.request(
        "/v1/tasks/sessions/not-a-session",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            startAt: "2026-07-06T16:00:00.000Z",
            endAt: "2026-07-06T17:00:00.000Z",
          }),
        },
      );
      expect(missingSession.status).toBe(404);
      expect(await missingSession.json()).toEqual({ error: "not_found" });

      const tasksResponse = await app.request("/v1/tasks");
      expect(tasksResponse.status).toBe(404);
      expect(await tasksResponse.json()).toEqual({ error: "not_found" });
    });
  });

  test("calendar CRUD is retired from the wiki gateway", async () => {
    await withIsolatedGateway(async ({ app }) => {
      const createdResponse = await app.request("/v1/calendar/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: "Work shift",
          startAt: "2026-07-06T16:00:00.000Z",
          endAt: "2026-07-06T22:00:00.000Z",
          tag: "work",
        }),
      });
      expect(createdResponse.status).toBe(404);
      expect(await createdResponse.json()).toEqual({ error: "not_found" });

      const listResponse = await app.request(
        "/v1/calendar/events?timeMin=2026-07-06T00:00:00.000Z&timeMax=2026-07-07T00:00:00.000Z",
      );
      expect(listResponse.status).toBe(404);
      expect(await listResponse.json()).toEqual({ error: "not_found" });
    });
  });
  test("reports runtime startup rejection and cleans up before failing readiness", async () => {
    let stopCalls = 0;
    const runtime = {
      start: () => Promise.reject(new Error("discord runtime rejected startup")),
      stop: () => {
        stopCalls += 1;
        return Promise.resolve();
      },
    } as unknown as ContextGatewayRuntime;
    await withIsolatedGateway(
      async ({ app }) => {
        let startupFailure: unknown;
        try {
          await app.start();
        } catch (error) {
          startupFailure = error;
        }
        expect(startupFailure).toMatchObject({
          message: "discord runtime rejected startup",
        });
        const health = await app.request("/health");
        expect(health.status).toBe(503);
        expect(await health.json()).toEqual({
          ok: false,
          error: "discord runtime rejected startup",
        });
        await app.stop();
        expect(stopCalls).toBe(1);
      },
      { runtime },
    );
  });
  test("can restart cleanly after a rejected runtime start", async () => {
    let startCalls = 0;
    let stopCalls = 0;
    const runtime = {
      start: () => {
        startCalls += 1;
        return startCalls === 1
          ? Promise.reject(new Error("transient runtime rejection"))
          : Promise.resolve();
      },
      stop: () => {
        stopCalls += 1;
        return Promise.resolve();
      },
    } as unknown as ContextGatewayRuntime;
    await withIsolatedGateway(
      async ({ app }) => {
        try {
          await app.start();
        } catch (error) {
          expect(error).toMatchObject({ message: "transient runtime rejection" });
        }
        await app.stop();
        await app.start();
        expect(startCalls).toBe(2);
        await app.stop();
        expect(stopCalls).toBe(2);
      },
      { runtime },
    );
  });
  test("drains each configured workspace through isolated monitor and outbound workers", async () => {
    const monitorClaims: string[] = [];
    const outboundClaims: string[] = [];
    const sentWorkspaces: string[] = [];
    const completedWorkspaces: string[] = [];
    const client = {
      append: () => Promise.resolve({ inserted: true }),
      compile: () => Promise.resolve({
        scope: { kind: "owner" as const },
        summaries: [],
        events: [],
        wikiPages: [],
      }),
      claim: (input: { workspaceId?: string }) => {
        if (!input.workspaceId) throw new Error("workspace claim required");
        monitorClaims.push(input.workspaceId);
        return Promise.resolve([]);
      },
      ack: () => Promise.resolve({ acknowledged: 1, cursor: 1 }),
      saveSummary: () => Promise.resolve({ inserted: true }),
      enqueueOutbound: () => Promise.resolve({ inserted: true }),
      claimOutbound: (input: { workspaceId?: string }) => {
        if (!input.workspaceId) throw new Error("workspace outbound claim required");
        outboundClaims.push(input.workspaceId);
        return Promise.resolve([{
          workspaceId: input.workspaceId,
          id: `outbound-${input.workspaceId}`,
          destination: { surface: "discord" as const, channelId: `channel-${input.workspaceId}` },
          text: input.workspaceId,
          status: "claimed" as const,
          attempts: 1,
          claimToken: `lease-${input.workspaceId}`,
          leaseUntil: Date.now() + 1_000,
        }]);
      },
      completeOutbound: (input: { workspaceId?: string }) => {
        if (!input.workspaceId) throw new Error("workspace outbound completion required");
        completedWorkspaces.push(input.workspaceId);
        return Promise.resolve({
          id: `outbound-${input.workspaceId}`,
          status: "completed" as const,
          attempts: 1,
        });
      },
    } as unknown as ContextRuntimeClient;
    const adapter: ChannelAdapter = {
      id: "discord",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      send: (destination) => {
        if (!destination.workspaceId) throw new Error("workspace destination required");
        sentWorkspaces.push(destination.workspaceId);
        return Promise.resolve({ ok: true, messageId: `message-${destination.workspaceId}` });
      },
    };
    const runtime = createWorkspaceGatewayRuntime({
      contextClient: client,
      workspaceIds: ["workspace-1", "workspace-2"],
      adapters: [adapter],
    });

    await runtime.start();
    await runtime.stop();

    expect(monitorClaims).toEqual(["workspace-1", "workspace-2"]);
    expect([...new Set(outboundClaims)]).toEqual(["workspace-1", "workspace-2"]);
    expect(sentWorkspaces).toEqual(outboundClaims);
    expect(completedWorkspaces).toEqual(outboundClaims);
  });
  test("leaves a mismatched outbound claim fenced to its own workspace", async () => {
    const sent: string[] = [];
    const completed: string[] = [];
    const client = {
      append: () => Promise.resolve({ inserted: true }),
      compile: () => Promise.resolve({ scope: { kind: "owner" as const }, summaries: [], events: [], wikiPages: [] }),
      claim: () => Promise.resolve([]),
      ack: () => Promise.resolve({ acknowledged: 1, cursor: 1 }),
      saveSummary: () => Promise.resolve({ inserted: true }),
      enqueueOutbound: () => Promise.resolve({ inserted: true }),
      claimOutbound: () => Promise.resolve([{
        workspaceId: "workspace-2",
        id: "cross-workspace-row",
        destination: { surface: "discord" as const, channelId: "channel-2" },
        text: "must not cross",
        status: "claimed" as const,
        attempts: 1,
        claimToken: "cross-workspace-lease",
        leaseUntil: Date.now() + 1_000,
      }]),
      completeOutbound: () => {
        completed.push("workspace-2");
        return Promise.resolve({ id: "cross-workspace-row", status: "completed" as const, attempts: 1 });
      },
    } as unknown as ContextRuntimeClient;
    const adapter: ChannelAdapter = {
      id: "discord",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      send: (destination) => {
        sent.push(destination.workspaceId ?? "");
        return Promise.resolve({ ok: true, messageId: "should-not-send" });
      },
    };
    const runtime = createWorkspaceGatewayRuntime({
      contextClient: client,
      workspaceIds: ["workspace-1"],
      adapters: [adapter],
    });

    await runtime.start();
    await runtime.stop();

    expect(sent).toEqual([]);
    expect(completed).toEqual([]);
  });
});
