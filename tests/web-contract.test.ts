/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/gateway/app";
import { resetDatabaseForTests } from "../src/data/db/database";

type GatewayApp = {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

async function withIsolatedGateway(run: (app: GatewayApp) => Promise<void>): Promise<void> {
  const oldHome = process.env.HOME;
  const oldToken = process.env.ANORVIS_OS_API_TOKEN;
  const oldSecretProvider = process.env.ANORVIS_SECRET_PROVIDER;
  process.env.HOME = mkdtempSync(join(tmpdir(), "anorvis-web-contract-"));
  delete process.env.ANORVIS_OS_API_TOKEN;
  process.env.ANORVIS_SECRET_PROVIDER = "local";
  resetDatabaseForTests();

  try {
    await run(createApp());
  } finally {
    resetDatabaseForTests();
    process.env.HOME = oldHome;
    if (oldToken === undefined) delete process.env.ANORVIS_OS_API_TOKEN;
    else process.env.ANORVIS_OS_API_TOKEN = oldToken;
    if (oldSecretProvider === undefined) delete process.env.ANORVIS_SECRET_PROVIDER;
    else process.env.ANORVIS_SECRET_PROVIDER = oldSecretProvider;
  }
}

function currentWeekDate(dayOffset: number, hour: number, minute = 0): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

async function readFirstSseChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response did not expose a readable body");

  try {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value).toBeDefined();
    return new TextDecoder().decode(chunk.value);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

describe("web API contracts", () => {
  test("tasks plan exposes dated tasks and life snapshot reflects task sessions and local calendar source", async () => {
    await withIsolatedGateway(async (app) => {
      const dueDate = currentWeekDate(2, 17).toISOString().slice(0, 10);
      const dueAt = new Date(`${dueDate}T23:59:00`).toISOString();
      const sessionStart = currentWeekDate(2, 9).toISOString();
      const sessionEnd = currentWeekDate(2, 10, 30).toISOString();
      const calendarStart = currentWeekDate(2, 13).toISOString();
      const calendarEnd = currentWeekDate(2, 14).toISOString();
      const calendarDate = calendarStart.slice(0, 10);

      const createdTaskResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Prepare launch plan",
          notes: "Draft rollout risks",
          date: dueDate,
          priority: "urgent",
          durationMinutes: 90,
          links: ["obsidian://launch", "https://example.test/rollout"],
          multiSession: true,
          source: "contract-test",
        }),
      });
      expect(createdTaskResponse.status).toBe(201);
      const createdTask = await createdTaskResponse.json() as { id: string; title: string; dueAt: string; source: string };
      expect(createdTask.title).toBe("Prepare launch plan");
      expect(createdTask.dueAt).toBe(dueAt);
      expect(createdTask.source).toBe("contract-test");

      const listedTasksResponse = await app.request("/v1/tasks");
      expect(listedTasksResponse.status).toBe(200);
      const listedTasks = await listedTasksResponse.json() as { tasks: Array<{ id: string; title: string; status: string; dueAt: string; durationMinutes?: number; links: string[]; multiSession: boolean }> };
      expect(listedTasks.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdTask.id, title: "Prepare launch plan", status: "open", dueAt, durationMinutes: 90, links: ["obsidian://launch", "https://example.test/rollout"], multiSession: true }),
      ]));

      const invalidLinksPatch = await app.request(`/v1/tasks/${encodeURIComponent(createdTask.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ links: ["valid-link", 42] }),
      });
      expect(invalidLinksPatch.status).toBe(400);
      expect(await invalidLinksPatch.json()).toEqual({ error: "invalid task patch" });

      const sessionResponse = await app.request(`/v1/tasks/sessions/${encodeURIComponent(createdTask.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: sessionStart, end: sessionEnd }),
      });
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json() as { id: string; taskId: string; startAt: string; endAt: string; status: string };
      expect(session).toEqual(expect.objectContaining({ id: createdTask.id, taskId: createdTask.id, startAt: sessionStart, endAt: sessionEnd, status: "planned" }));

      const calendarResponse = await app.request("/v1/calendar/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "Local planning block", startAt: calendarStart, endAt: calendarEnd, tag: "planning" }),
      });
      expect(calendarResponse.status).toBe(201);
      const calendarEvent = await calendarResponse.json() as { id: string; source: string };
      expect(calendarEvent.source).toBe("local");

      const planResponse = await app.request("/v1/tasks/plan");
      expect(planResponse.status).toBe(200);
      const plan = await planResponse.json() as {
        tasks: Array<{ id: string; title: string; status: string; date: string; priority?: string; durationMinutes?: number; multiSession: boolean; links: unknown[] }>;
        sessions: Array<{ id: string; taskId: string; completed: boolean; start: string; end: string; conflictState: string }>;
        prepPackages: unknown[];
      };
      expect(plan.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdTask.id, title: "Prepare launch plan", status: "open", date: dueAt, priority: "urgent", durationMinutes: 90, multiSession: true, links: ["obsidian://launch", "https://example.test/rollout"] }),
      ]));
      expect(plan.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdTask.id, taskId: createdTask.id, completed: false, start: sessionStart, end: sessionEnd, conflictState: "none" }),
      ]));
      expect(plan.prepPackages).toEqual([]);

      const snapshotResponse = await app.request("/v1/life/snapshot");
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json() as {
        queue: Array<{ id: string; title: string; scheduledStart: string; scheduledEnd: string; label: string; conflictState: string }>;
        weekCalendarEvents: Array<{ id: string; summary: string; taskId?: string; source?: string; type: string; date: string; conflictState?: string }>;
      };
      expect(snapshot.queue).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdTask.id, title: "Prepare launch plan", scheduledStart: sessionStart, scheduledEnd: sessionEnd, label: "scheduled", conflictState: "none" }),
      ]));
      expect(snapshot.weekCalendarEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdTask.id, taskId: createdTask.id, summary: "Prepare launch plan", source: "task", type: "plannedTask", conflictState: "none" }),
        expect.objectContaining({ id: calendarEvent.id, summary: "Local planning block", source: "local", type: "default", date: calendarDate }),
      ]));
    });
  });

  test("health meal CRUD is reflected in dashboard meal source, items, and latest check-in fields", async () => {
    await withIsolatedGateway(async (app) => {
      const loggedAt = new Date().toISOString();
      const createResponse = await app.request("/v1/health/meals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Post-lift bowl",
          mealType: "lunch",
          loggedAt,
          calories: 640,
          proteinGrams: 48,
          carbsGrams: 72,
          fatGrams: 18,
          source: "macro-tracker",
          notes: "extra salsa",
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdMeal = await createResponse.json() as { id: string; name: string; calories: number; source: string; notes: string | null; items: unknown[] };
      expect(createdMeal).toEqual(expect.objectContaining({ name: "Post-lift bowl", calories: 640, source: "macro-tracker", notes: "extra salsa", items: [] }));

      const updateResponse = await app.request(`/v1/health/meals/${encodeURIComponent(createdMeal.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Post-lift bowl updated",
          mealType: "lunch",
          loggedAt,
          calories: 700,
          proteinGrams: 55,
          carbsGrams: 75,
          fatGrams: 20,
          source: "macro-tracker",
          notes: null,
        }),
      });
      expect(updateResponse.status).toBe(200);
      const updatedMeal = await updateResponse.json() as { id: string; name: string; calories: number; proteinGrams: number; notes: string | null };
      expect(updatedMeal).toEqual(expect.objectContaining({ id: createdMeal.id, name: "Post-lift bowl updated", calories: 700, proteinGrams: 55, notes: null }));

      const dashboardResponse = await app.request("/v1/health/dashboard");
      expect(dashboardResponse.status).toBe(200);
      const dashboard = await dashboardResponse.json() as {
        latestCheckin: null | { weightKg: number; adherencePercent: number; checkedInAt: string };
        todayMeals: Array<{ id: string; name: string; source: string; items: unknown[]; calories: number }>;
        recentMeals: Array<{ id: string; name: string; source: string; items: unknown[]; calories: number }>;
      };
      expect(dashboard.latestCheckin).toBeNull();
      expect(dashboard.todayMeals).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdMeal.id, name: "Post-lift bowl updated", source: "macro-tracker", items: [], calories: 700 }),
      ]));
      expect(dashboard.recentMeals).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: createdMeal.id, name: "Post-lift bowl updated", source: "macro-tracker", items: [], calories: 700 }),
      ]));

      const deleteResponse = await app.request(`/v1/health/meals/${encodeURIComponent(createdMeal.id)}`, { method: "DELETE" });
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toEqual({ ok: true });

      const afterDeleteResponse = await app.request("/v1/health/dashboard");
      const afterDelete = await afterDeleteResponse.json() as { recentMeals: Array<{ id: string }> };
      expect(afterDelete.recentMeals.some((meal) => meal.id === createdMeal.id)).toBe(false);
    });
  });

  test("finance CSV import skips duplicate fingerprints and portfolio cash reflects imported account balance", async () => {
    await withIsolatedGateway(async (app) => {
      const importBody = {
        source: "chase_checking",
        accountName: "Everyday Checking",
        balance: 1234.56,
        transactions: [
          { fingerprint: "chase-2026-07-01-payroll", externalId: "txn-1", date: "2026-07-01", description: "Payroll", amount: 2000, category: "income", currency: "USD" },
          { fingerprint: "chase-2026-07-02-groceries", externalId: "txn-2", date: "2026-07-02", description: "Groceries", amount: -88.45, category: "food", currency: "USD" },
        ],
      };

      const firstImportResponse = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(importBody),
      });
      expect(firstImportResponse.status).toBe(201);
      const firstImport = await firstImportResponse.json() as { imported: number; skippedDuplicates: number; accountId: string };
      expect(firstImport.imported).toBe(2);
      expect(firstImport.skippedDuplicates).toBe(0);

      const duplicateImportResponse = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(importBody),
      });
      expect(duplicateImportResponse.status).toBe(201);
      const duplicateImport = await duplicateImportResponse.json() as { imported: number; skippedDuplicates: number; accountId: string };
      expect(duplicateImport).toEqual({ imported: 0, skippedDuplicates: 2, accountId: firstImport.accountId });

      const portfolioResponse = await app.request("/v1/finance/portfolio");
      expect(portfolioResponse.status).toBe(200);
      const portfolio = await portfolioResponse.json() as { portfolio: { cash: number; equity: number; positions: unknown[] } | null; history: unknown[] };
      expect(portfolio.portfolio).toEqual({ cash: 1234.56, equity: 1234.56, positions: [] });
      expect(portfolio.history).toEqual([]);
    });
  });

  test("integration catalog, Hevy settings, sync, and overview expose persisted domain state", async () => {
    await withIsolatedGateway(async (app) => {
      const mealResponse = await app.request("/v1/health/meals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Overview breakfast", mealType: "breakfast", loggedAt: new Date().toISOString(), calories: 410, proteinGrams: 30, carbsGrams: 44, fatGrams: 12, source: "overview-test", notes: null }),
      });
      expect(mealResponse.status).toBe(201);

      const taskResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Review overview contracts", dueAt: currentWeekDate(3, 16).toISOString(), priority: "high", source: "overview-test" }),
      });
      expect(taskResponse.status).toBe(201);

      const financeResponse = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "manual", accountName: "Manual Cash", balance: 500, transactions: [] }),
      });
      expect(financeResponse.status).toBe(201);

      const catalogResponse = await app.request("/v1/integrations");
      expect(catalogResponse.status).toBe(200);
      const catalog = await catalogResponse.json() as { integrations: Array<{ id: string; displayName: string; category: string; capabilities: string[]; authType: string; status: string; setupHint?: string }> };
      expect(catalog.integrations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "hevy", displayName: "Hevy", category: "health", capabilities: ["workouts.sync"], authType: "token", status: "available", setupHint: "Add a local API token." }),
      ]));

      const settingsResponse = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "hevy_contract_token" }),
      });
      expect(settingsResponse.status).toBe(200);
      expect(await settingsResponse.json()).toEqual(expect.objectContaining({ ok: true, status: "connected", connected: true, hasApiKey: true, secretProvider: "local" }));

      const connectedCatalogResponse = await app.request("/v1/integrations");
      const connectedCatalog = await connectedCatalogResponse.json() as { integrations: Array<{ id: string; status: string }> };
      expect(connectedCatalog.integrations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "hevy", status: "connected" }),
      ]));

      const syncResponse = await app.request("/v1/integrations/hevy/sync", { method: "POST" });
      expect(syncResponse.status).toBe(200);
      expect(await syncResponse.json()).toEqual({ fetched: 0, created: 0, updated: 0 });

      const overviewResponse = await app.request("/v1/overview");
      expect(overviewResponse.status).toBe(200);
      const overview = await overviewResponse.json() as {
        health: { status: string; nudge: string; confidence: string };
        life: { status: string; doNow: string; todayEventCount: number };
        finance: { status: string; equity: number | null; cash: number | null };
        integrations: Array<{ id: string; status: string }>;
      };
      expect(overview.health).toEqual(expect.objectContaining({ status: "partial", nudge: "Meals logged today.", confidence: "medium" }));
      expect(overview.life).toEqual(expect.objectContaining({ status: "partial", doNow: "Review overview contracts", todayEventCount: 0 }));
      expect(overview.finance).toEqual(expect.objectContaining({ status: "partial", equity: 500, cash: 500 }));
      expect(overview.integrations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "hevy", status: "connected" }),
      ]));
    });
  });

  test("events stream sends SSE headers and backfills changed events emitted by writes", async () => {
    await withIsolatedGateway(async (app) => {
      const taskResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Trigger event stream", priority: "normal" }),
      });
      expect(taskResponse.status).toBe(201);
      const task = await taskResponse.json() as { id: string };

      const eventsResponse = await app.request("/v1/events?lastEventId=0");
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.headers.get("content-type")).toBe("text/event-stream");
      expect(eventsResponse.headers.get("cache-control")).toBe("no-cache");
      expect(eventsResponse.headers.get("connection")).toBe("keep-alive");

      const sseChunk = await readFirstSseChunk(eventsResponse);
      expect(sseChunk).toContain("event: task.changed\n");
      expect(sseChunk).toContain(`"entityId":"${task.id}"`);
      expect(sseChunk).toContain("\"domain\":\"life\"");
    });
  });
});
