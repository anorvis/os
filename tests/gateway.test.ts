import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/gateway/app";

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "anorvis-gateway-"));
}

describe("minimal Anorvis OS gateway", () => {
  test("serves health and wiki task route", async () => {
    const oldHome = process.env.HOME;
    process.env.HOME = tmpHome();
    try {
      const app = createApp({
        wikiAgent: ({ task }) => Promise.resolve({
          task,
          answer: "Recorded task through injected Pi Wiki Agent.",
          confidence: "high",
          sources: [],
          changed: [{ path: "wiki/queries/gateway-test.md", action: "created", why: "test" }],
          readNext: [],
          contradictions: [],
          gaps: [],
          warnings: [],
        }),
      });
      const health = await app.request("/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const wiki = await app.request("/v1/llm-wiki/wiki", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Remember gateway test" }),
      });
      expect(wiki.status).toBe(200);
      const body = await wiki.json() as { answer?: string; changed?: Array<{ path: string }> };
      expect(body.answer).toContain("Recorded task");
      expect(body.changed?.some((item) => item.path.startsWith("wiki/queries/"))).toBe(true);
    } finally {
      process.env.HOME = oldHome;
    }
  });
});
