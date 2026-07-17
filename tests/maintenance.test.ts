import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  createMaintenanceStore,
  hashMaintenanceSessionId,
  parseMaintainerTelemetry,
  recordMaintainerUsage,
  recordMaintenanceReview,
} from "../src/capability/maintenance";
import { getMaintenanceOverview } from "../src/capability/maintenance/overview";
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
  const response = await app.request("/v1/maintainer/overview?limit=999&offset=0&status=running&sessionLimit=999&sessionOffset=1");
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
  expect(overview.usage.totals).toMatchObject({ sessions: 1, messageCount: 2, inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, cacheTokens: 3, totalTokens: 17, usdCost: 0.02, outputLimitWarningCount: 1 });
  expect(overview.usage.recent[0]).toMatchObject({ host: "pi", provider: "openai", model: "gpt-test", cacheReadTokens: 2, cacheWriteTokens: 1, reviewed: true });
  expect(overview.usage.byModel[0]).toMatchObject({ provider: "openai", model: "gpt-test", sessions: 1 });
  expect(overview.usage.recent[0]?.sessionKey).toBe(hashMaintenanceSessionId("session-secret"));
  expect(JSON.stringify(overview)).not.toContain("session-secret");
});

test("usage keeps legacy cache as read and exposes split cache counters", () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-maintenance-cache-"));
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "legacy-cache.jsonl"), JSON.stringify({
    type: "message",
    id: "legacy-cache",
    timestamp: "2026-07-13T00:00:00Z",
    provider: "openai",
    model: "gpt-test",
    message: { role: "assistant", usage: { input: 3, output: 2, cache: 7, total: 12 } },
  }));

  const overview = getMaintenanceOverview({ root, sessionRoots: { pi: sessions } });
  expect(overview.usage.recent[0]).toMatchObject({
    cacheReadTokens: 7,
    cacheWriteTokens: 0,
    cacheTokens: 7,
  });
});

test("maintainer overview loads dedicated model performance and fails closed for missing or foreign databases", () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-maintenance-performance-"));
  const perfPath = join(root, "agent.db");
  const database = new Database(perfPath);
  database.run("CREATE TABLE model_perf (model_key TEXT, samples REAL, output_tokens REAL, gen_ms REAL, ttft_samples REAL, ttft_ms REAL, updated_at ANY)");
  database.run("INSERT INTO model_perf VALUES (?, ?, ?, ?, ?, ?, ?)", ["model-b", 2, 100, 100, 2, 100, Date.parse("2026-07-14T00:00:00Z") / 1000]);
  database.run("INSERT INTO model_perf VALUES (?, ?, ?, ?, ?, ?, ?)", ["model-a", 10, 1000, 500, 5, 250, "2026-07-15T00:00:00Z"]);
  database.close();

  const overview = getMaintenanceOverview({ root, sessionScope: "maintainer", maintainerModelPerfPath: perfPath });
  expect(overview.performance.totals).toEqual({
    samples: 12,
    outputTokens: 1100,
    generationMs: 600,
    tokensPerSecond: 1100 * 1000 / 600,
    timeToFirstTokenMs: 50,
  });
  expect(overview.performance.byModel).toEqual([
    {
      modelKey: "model-a",
      samples: 10,
      outputTokens: 1000,
      generationMs: 500,
      tokensPerSecond: 2000,
      timeToFirstTokenMs: 50,
      updatedAt: "2026-07-15T00:00:00Z",
    },
    {
      modelKey: "model-b",
      samples: 2,
      outputTokens: 100,
      generationMs: 100,
      tokensPerSecond: 1000,
      timeToFirstTokenMs: 50,
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
  ]);

  const missing = getMaintenanceOverview({ root, sessionScope: "maintainer", maintainerModelPerfPath: join(root, "missing.db") });
  expect(missing.performance).toEqual({
    totals: { samples: 0, outputTokens: 0, generationMs: 0, tokensPerSecond: 0, timeToFirstTokenMs: 0 },
    byModel: [],
  });

  const foreignPath = join(root, "foreign.db");
  const foreign = new Database(foreignPath);
  foreign.run("CREATE TABLE credentials (secret TEXT)");
  foreign.run("INSERT INTO credentials VALUES (?)", ["do-not-return"]);
  foreign.close();
  const foreignOverview = getMaintenanceOverview({ root, sessionScope: "maintainer", maintainerModelPerfPath: foreignPath });
  expect(foreignOverview.performance).toEqual(missing.performance);
  expect(JSON.stringify(foreignOverview)).not.toContain("do-not-return");
  const invalidPath = join(root, "invalid.db");
  const invalid = new Database(invalidPath);
  invalid.run("CREATE TABLE model_perf (model_key TEXT, samples REAL, output_tokens REAL, gen_ms REAL, ttft_samples REAL, ttft_ms REAL, updated_at TEXT)");
  invalid.run("INSERT INTO model_perf VALUES (?, ?, ?, ?, ?, ?, ?)", ["bad-model", -1, 10, 1, 1, 1, "2026-07-14T00:00:00Z"]);
  invalid.close();
  const invalidOverview = getMaintenanceOverview({ root, sessionScope: "maintainer", maintainerModelPerfPath: invalidPath });
  expect(invalidOverview.performance).toEqual(missing.performance);
});

test("maintainer telemetry parses every assistant turn and persists an allowlisted private ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-maintainer-telemetry-"));
  const stdout = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "worker-model",
        content: [{ type: "text", text: "private answer /Users/secret/project" }],
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17, cost: { total: 0.02 } },
      },
    }),
    JSON.stringify({
      type: "message",
      role: "assistant",
      content: "non-final private event",
      usage: { input: 999, output: 999, cost: 99 },
    }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 20, output: 8, cacheRead: 3, cacheWrite: 2, total: 33, cost: { total: 0.03 } },
      },
    }),
  ].join("\n");
  const metrics = parseMaintainerTelemetry(stdout, {
    stage: "worker",
    outcome: "output_limited",
    startedAt: "2026-07-14T00:00:00Z",
    completedAt: "2026-07-14T00:01:00Z",
  });
  expect(metrics).toMatchObject({
    provider: "openai-codex",
    model: "worker-model",
    stage: "worker",
    outcome: "output_limited",
    messageCount: 2,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    totalTokens: 50,
    usdCost: 0.05,
  });
  const record = recordMaintainerUsage({ ...metrics!, content: "do not persist" } as typeof metrics & { content: string }, { root });
  expect(record?.scope).toBe("maintainer");
  expect(record?.sessionKey).toMatch(/^[0-9a-f]{64}$/);
  recordMaintainerUsage(
    {
      ...metrics!,
      startedAt: "2026-06-30T23:58:00Z",
      completedAt: "2026-06-30T23:59:00Z",
    },
    { root },
  );
  const ledger = readFileSync(join(root, "maintainer-usage.jsonl"), "utf8");
  expect(ledger).not.toContain("private answer");
  expect(ledger).not.toContain("do not persist");
  expect(ledger).not.toContain("secret/project");
  const overview = getMaintenanceOverview({
    root,
    sessionScope: "maintainer",
    now: new Date("2026-07-16T12:00:00Z"),
  });
  expect(overview).toMatchObject({
    usagePeriod: "current_month",
    usageSince: "2026-07-01T00:00:00.000Z",
  });
  expect(overview.usage.totals).toMatchObject({
    sessions: 1,
    messageCount: 2,
    inputTokens: 30,
    outputTokens: 12,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    cacheTokens: 8,
    totalTokens: 50,
    usdCost: 0.05,
  });
});

test("maintainer overview validates scope and removes the old route", async () => {
  const app = new Hono();
  maintenanceRoutes({})(app);
  expect((await app.request("/v1/maintainer/overview?sessionScope=private")).status).toBe(400);
  expect((await app.request("/v1/maintenance/overview")).status).toBe(404);
});

test("foreground performance filters stats rows by foreground session roots", () => {
  const root = mkdtempSync(join(tmpdir(), "anorvis-foreground-stats-"));
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const statsPath = join(root, "stats.db");
  const database = new Database(statsPath);
  database.run("CREATE TABLE messages (session_file TEXT, provider TEXT, model TEXT, input_tokens REAL, output_tokens REAL, duration_ms REAL, ttft_ms REAL, timestamp TEXT)");
  database.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [join(sessions, "foreground.jsonl"), "openai", "foreground-model", 10, 20, 120, 20, "2026-07-14T00:00:00Z"]);
  database.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [join(sessions, "foreground.jsonl"), "openai", "foreground-model", 10, 10, 60, null, "2026-07-14T00:00:01Z"]);
  database.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [join(sessions, "foreground.jsonl"), "openai", "foreground-model", 10, 100, null, 10, "2026-07-14T00:00:02Z"]);
  database.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [`${sessions}/nested/../../background.jsonl`, "openai", "escaped-model", 10, 500, 120, 20, "2026-07-14T00:00:03Z"]);
  database.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [join(root, "no-session.jsonl"), "openai", "background-model", 10, 200, 120, 20, "2026-07-14T00:00:00Z"]);
  database.close();
  const overview = getMaintenanceOverview({
    root,
    sessionRoots: { omp: sessions },
    foregroundStatsPath: statsPath,
  });
  expect(overview.performance.totals).toMatchObject({
    samples: 2,
    outputTokens: 30,
    generationMs: 160,
    tokensPerSecond: 187.5,
    timeToFirstTokenMs: 15,
  });
  expect(overview.performance.byModel.map((row) => row.modelKey)).toEqual(["openai/foreground-model"]);
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
      const response = await createApp().request("/v1/maintainer/overview");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ usage: { totals: { sessions: 0 }, recent: [], byModel: [] }, tickets: [] });
      expect((await createApp().request("/v1/maintenance/overview")).status).toBe(404);
    } finally {
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
