import { describe, expect, test } from "bun:test";
import { createApp } from "../src/platform/gateway/app";
process.env.ANORVIS_OS_API_TOKEN = "context-test-token";
import type { ContextCapabilityClient } from "../src/capability/context/client";

const client: ContextCapabilityClient = {
  append: (input) => Promise.resolve({ inserted: true, input }),
  compile: (input) => Promise.resolve({ events: [], summaries: [], wikiPages: [], input }),
  enqueueOutbound: (input) => Promise.resolve({ inserted: true, input }),
};

describe("context sidecar routes", () => {
  test("forwards validated append, compile, and outbound calls to the injected client", async () => {
    const app = createApp({ contextClient: client, config: { baseUrl: "http://127.0.0.1:8787", bindHost: "127.0.0.1", port: 8787, dataRoot: "/tmp/anorvis-context-test", tailnetName: null } });
    const event = {
      id: "event-1",
      kind: "conversation_turn",
      occurredAt: 1,
      source: { surface: "pi", conversationId: "conversation-1", visibility: "private" },
      content: { text: "hello" },
    };
    const append = await app.request("/v1/context/events", {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "content-type": "application/json", authorization: "Bearer context-test-token" },
    });
    expect(append.status).toBe(200);
    expect(await append.json()).toMatchObject({ inserted: true });

    const compile = await app.request("/v1/context/compile", {
      method: "POST",
      body: JSON.stringify({ scope: { kind: "owner" } }),
      headers: { "content-type": "application/json", authorization: "Bearer context-test-token" },
    });
    expect(compile.status).toBe(200);

    const outbound = await app.request("/v1/context/outbound", {
      method: "POST",
      body: JSON.stringify({ id: "out-1", destination: { surface: "discord", channelId: "general" }, text: "reply" }),
      headers: { "content-type": "application/json", authorization: "Bearer context-test-token" },
    });
    expect(outbound.status).toBe(200);
  });

  test("rejects malformed context events", async () => {
    const app = createApp({ contextClient: client, config: { baseUrl: "http://127.0.0.1:8787", bindHost: "127.0.0.1", port: 8787, dataRoot: "/tmp/anorvis-context-test", tailnetName: null } });
    const response = await app.request("/v1/context/events", {
      method: "POST",
      body: JSON.stringify({ id: "missing-source" }),
      headers: { "content-type": "application/json", authorization: "Bearer context-test-token" },
    });
    expect(response.status).toBe(400);
  });
});
