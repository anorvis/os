import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMaintenanceStore,
  getMaintenanceOverview,
  hashMaintenanceSessionId,
  recordMaintenanceReview,
} from "../src/capability/maintenance";
import { maintenanceRoutes } from "../src/capability/maintenance/route";
import { createApp } from "../src/platform/gateway/app";

test("maintenance store is private and atomic, with idempotent lifecycle updates", () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-maintenance-"));
  const store = createMaintenanceStore({ root, now: () => new Date("2026-07-14T00:00:00.000Z") });
  const first = store.createTicket({ task: "Fix queue duplication", project: "/private/project" });
  const replay = store.createTicket({ task: "  Fix   queue duplication ", project: "/private/project" });
  expect(replay.id).toBe(first.id);
  expect(store.updateTicket(first.id, { status: "approved" })?.status).toBe("approved");
  expect(store.updateTicket(first.id, { status: "running" })?.status).toBe("running");
  expect(store.updateTicket(first.id, { status: "fixed", answer: "done", verification: ["bun test"], warnings: [] })?.status).toBe("fixed");
  const path = join(root, "maintenance.json");
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain("/private/project");
});

test("overview paginates tickets with a bounded total and optional status filter", () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-maintenance-pagination-"));
  let tick = 0;
  const store = createMaintenanceStore({ root, now: () => new Date(Date.UTC(2026, 6, 14, 0, 0, 0, tick++)) });
  const first = store.createTicket({ task: "First task" });
  const second = store.createTicket({ task: "Second task" });
  store.updateTicket(first.id, { status: "running" });
  store.updateTicket(second.id, { status: "fixed" });
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  for (let index = 0; index < 105; index += 1) {
    writeFileSync(join(sessions, `session-${index}.jsonl`), JSON.stringify({
      type: "session",
      id: `session-${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
      provider: "openai",
      model: `model-${index}`,
    }));
  }

  const page = getMaintenanceOverview({ root, sessionRoots: { pi: sessions }, limit: 1, offset: 1 });
  expect(page.total).toBe(2);
  expect(page.tickets).toHaveLength(1);
  expect(page.tickets[0]?.status).toBe("running");

  const running = getMaintenanceOverview({ root, sessionRoots: { pi: sessions }, ticketStatuses: ["running"], limit: 20, offset: 0 });
  expect(running.total).toBe(1);
  expect(running.tickets.map((ticket) => ticket.status)).toEqual(["running"]);
  const sessionPage = getMaintenanceOverview({ root, sessionRoots: { pi: sessions }, sessionLimit: 2, sessionOffset: 2 });
  expect(sessionPage.usageTotal).toBe(105);
  expect(sessionPage.usage.recent).toHaveLength(2);
  const capped = getMaintenanceOverview({ root, sessionRoots: { pi: sessions }, sessionLimit: 999, sessionOffset: 0 });
  expect(capped.usage.recent).toHaveLength(100);
});

test("overview route applies bounded pagination and status filtering", async () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-maintenance-route-pagination-"));
  const store = createMaintenanceStore({ root, now: () => new Date("2026-07-14T00:00:00.000Z") });
  const ticket = store.createTicket({ task: "Route pagination" });
  store.updateTicket(ticket.id, { status: "running" });
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    writeFileSync(join(sessions, `route-session-${index}.jsonl`), JSON.stringify({
      type: "session",
      id: `route-session-${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 14, 0, 0, index)).toISOString(),
      provider: "openai",
      model: `route-model-${index}`,
    }));
  }
  const app = new Hono();
  maintenanceRoutes({ root, sessionRoots: { pi: sessions } })(app);
  const response = await app.request("/v1/maintenance/overview?limit=999&offset=0&status=running&sessionLimit=999&sessionOffset=1");
  expect(response.status).toBe(200);
  const body = await response.json() as {
    total: number;
    usageTotal: number;
    tickets: Array<{ status: string }>;
    usage: { recent: unknown[] };
  };
  expect(body).toMatchObject({ total: 1, usageTotal: 3, tickets: [{ status: "running" }] });
  expect(body.usage.recent).toHaveLength(2);
});

test("usage aggregation tolerates malformed JSONL and matches hashed reviews", () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-maintenance-"));
  const sessions = join(root, "pi");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "session-secret.jsonl"), [
    JSON.stringify({ type: "session", id: "session-secret", timestamp: "2026-07-13T00:00:00Z", provider: "openai", model: "gpt-test" }),
    "not-json",
    JSON.stringify({ type: "message", timestamp: "2026-07-13T00:01:00Z", provider: "openai", model: "gpt-test", message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.02 } } } }),
    JSON.stringify({ type: "message", timestamp: "2026-07-13T00:02:00Z", message: { role: "toolResult", content: [{ type: "text", text: "{\"warnings\":[\"Anorvis Wiki Agent exceeded the output limit.\"]}" }] } }),
  ].join("\n"));
  recordMaintenanceReview({ sessionId: "session-secret" }, { root });
  const overview = getMaintenanceOverview({ root, sessionRoots: { pi: sessions } });
  expect(overview.usage.totals).toMatchObject({ sessions: 1, messageCount: 2, inputTokens: 10, outputTokens: 4, cacheTokens: 3, totalTokens: 17, usdCost: 0.02, outputLimitWarningCount: 1 });
  expect(overview.usage.recent[0]).toMatchObject({ host: "pi", provider: "openai", model: "gpt-test", reviewed: true });
  expect(overview.usage.recent[0]?.sessionKey).toBe(hashMaintenanceSessionId("session-secret"));
  expect(JSON.stringify(overview)).not.toContain("session-secret");
});

describe("maintenance gateway route", () => {
  test("returns authenticated overview through the OS gateway", async () => {
    const environment = new Map([
      ["HOME", process.env.HOME],
      ["ANORVIS_MONITOR_ROOT", process.env.ANORVIS_MONITOR_ROOT],
      ["ANORVIS_PI_SESSION_ROOT", process.env.ANORVIS_PI_SESSION_ROOT],
      ["ANORVIS_OS_API_TOKEN", process.env.ANORVIS_OS_API_TOKEN],
      ["ANORVIS_OS_API_TOKEN_PATH", process.env.ANORVIS_OS_API_TOKEN_PATH],
    ]);
    const home = mkdtempSync(join(tmpdir(), "anorvis-maintenance-gateway-"));
    process.env.HOME = home;
    process.env.ANORVIS_MONITOR_ROOT = join(home, "monitor");
    process.env.ANORVIS_PI_SESSION_ROOT = join(home, "missing-sessions");
    delete process.env.ANORVIS_OS_API_TOKEN;
    process.env.ANORVIS_OS_API_TOKEN_PATH = join(home, "missing-token");
    try {
      const response = await createApp().request("/v1/maintenance/overview");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ usage: { totals: { sessions: 0 }, recent: [], byModel: [] }, tickets: [] });
    } finally {
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
