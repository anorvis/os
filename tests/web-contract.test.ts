/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/platform/gateway/app";
import { resetDatabaseForTests } from "../src/core/db/database";
import {
  saveMacroProfile,
  type MacroProfileInput,
} from "../src/capability/health/data";
import { getFinanceDashboard } from "../src/capability/finance/data";

type GatewayApp = {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

async function withIsolatedGateway(
  run: (app: GatewayApp) => Promise<void>,
): Promise<void> {
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
    if (oldSecretProvider === undefined)
      delete process.env.ANORVIS_SECRET_PROVIDER;
    else process.env.ANORVIS_SECRET_PROVIDER = oldSecretProvider;
  }
}

async function createFinanceAccountViaApi(
  app: GatewayApp,
  input: {
    name: string;
    type: string;
    currency: string;
    balance?: number | null;
  },
): Promise<string> {
  const response = await app.request("/v1/finance/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { account: { id: string } };
  return body.account.id;
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

function macroProfileInput(weightKg: number): MacroProfileInput {
  return {
    goal: "cut",
    sex: "male",
    age: 30,
    heightCm: 180,
    weightKg,
    bodyFatPercent: null,
    activityLevel: "moderate",
    birthdate: null,
    trainingDaysPerWeek: 4,
    targetCalories: 2200,
    proteinGrams: 180,
    carbsGrams: 200,
    fatGrams: 60,
  };
}

const HEVY_WORKOUTS_URL = "https://api.hevyapp.com/v1/workouts";

// Mirrors os/tests/hevy-secrets.test.ts: swap globalThis.fetch for the Hevy workouts request
// so the sync contract is exercised deterministically instead of hitting the live API.
function withFakeHevyFetch(
  handler: () => { status?: number; payload: unknown },
): {
  restore: () => void;
} {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!url.startsWith(HEVY_WORKOUTS_URL)) {
      return Promise.reject(
        new Error(`unexpected network fetch in test: ${url}`),
      );
    }
    const { status = 200, payload } = handler();
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { restore: () => void (globalThis.fetch = original) };
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
          dueAt,
          priority: "urgent",
          durationMinutes: 90,
          links: ["obsidian://launch", "https://example.test/rollout"],
          multiSession: true,
          source: "contract-test",
        }),
      });
      expect(createdTaskResponse.status).toBe(201);
      const createdTask = (await createdTaskResponse.json()) as {
        id: string;
        title: string;
        dueAt: string;
        source: string;
      };
      expect(createdTask.title).toBe("Prepare launch plan");
      expect(createdTask.dueAt).toBe(dueAt);
      expect(createdTask.source).toBe("contract-test");

      const listedTasksResponse = await app.request("/v1/tasks");
      expect(listedTasksResponse.status).toBe(200);
      const listedTasks = (await listedTasksResponse.json()) as {
        tasks: Array<{
          id: string;
          title: string;
          status: string;
          dueAt: string;
          durationMinutes?: number;
          links: string[];
          multiSession: boolean;
        }>;
      };
      expect(listedTasks.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdTask.id,
            title: "Prepare launch plan",
            status: "open",
            dueAt,
            durationMinutes: 90,
            links: ["obsidian://launch", "https://example.test/rollout"],
            multiSession: true,
          }),
        ]),
      );

      const invalidLinksPatch = await app.request(
        `/v1/tasks/${encodeURIComponent(createdTask.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ links: ["valid-link", 42] }),
        },
      );
      expect(invalidLinksPatch.status).toBe(400);
      expect(await invalidLinksPatch.json()).toEqual({
        error: "invalid task patch",
      });

      const sessionResponse = await app.request(
        `/v1/tasks/sessions/${encodeURIComponent(createdTask.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ startAt: sessionStart, endAt: sessionEnd }),
        },
      );
      expect(sessionResponse.status).toBe(200);
      const session = (await sessionResponse.json()) as {
        id: string;
        taskId: string;
        startAt: string;
        endAt: string;
        status: string;
      };
      expect(session).toEqual(
        expect.objectContaining({
          id: createdTask.id,
          taskId: createdTask.id,
          startAt: sessionStart,
          endAt: sessionEnd,
          status: "planned",
        }),
      );

      const calendarResponse = await app.request("/v1/calendar/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: "Local planning block",
          startAt: calendarStart,
          endAt: calendarEnd,
          tag: "planning",
        }),
      });
      expect(calendarResponse.status).toBe(201);
      const calendarEvent = (await calendarResponse.json()) as {
        id: string;
        source: string;
      };
      expect(calendarEvent.source).toBe("local");

      const planResponse = await app.request("/v1/tasks/plan");
      expect(planResponse.status).toBe(200);
      const plan = (await planResponse.json()) as {
        tasks: Array<{
          id: string;
          title: string;
          status: string;
          dueAt: string;
          priority?: string;
          durationMinutes?: number;
          multiSession: boolean;
          links: unknown[];
        }>;
        sessions: Array<{
          id: string;
          taskId: string;
          status: string;
          startAt: string;
          endAt: string;
        }>;
        prepPackages: unknown[];
      };
      expect(plan.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdTask.id,
            title: "Prepare launch plan",
            status: "open",
            dueAt,
            priority: "urgent",
            durationMinutes: 90,
            multiSession: true,
            links: ["obsidian://launch", "https://example.test/rollout"],
          }),
        ]),
      );
      expect(plan.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdTask.id,
            taskId: createdTask.id,
            status: "planned",
            startAt: sessionStart,
            endAt: sessionEnd,
          }),
        ]),
      );
      expect(plan.prepPackages).toEqual([]);

      const snapshotResponse = await app.request("/v1/life/snapshot");
      expect(snapshotResponse.status).toBe(200);
      const snapshot = (await snapshotResponse.json()) as {
        queue: Array<{
          id: string;
          title: string;
          scheduledStart: string;
          scheduledEnd: string;
          label: string;
        }>;
        weekCalendarEvents: Array<{
          id: string;
          summary: string;
          taskId?: string;
          source?: string;
          type: string;
          date: string;
        }>;
      };
      expect(snapshot.queue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdTask.id,
            title: "Prepare launch plan",
            scheduledStart: sessionStart,
            scheduledEnd: sessionEnd,
            label: "scheduled",
          }),
        ]),
      );
      expect(snapshot.weekCalendarEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdTask.id,
            taskId: createdTask.id,
            summary: "Prepare launch plan",
            source: "task",
            type: "plannedTask",
          }),
          expect.objectContaining({
            id: calendarEvent.id,
            summary: "Local planning block",
            source: "local",
            type: "default",
            date: calendarDate,
          }),
        ]),
      );
    });
  });

  test("task patches preserve archived status and reject invalid links without corrupting stored links", async () => {
    await withIsolatedGateway(async (app) => {
      const links = [
        "obsidian://archive-review",
        "https://example.test/archive-review",
      ];
      const createdResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Archive schema boundary",
          links,
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { id: string };

      const archivedResponse = await app.request(
        `/v1/tasks/${encodeURIComponent(created.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "archived" }),
        },
      );
      expect(archivedResponse.status).toBe(200);
      const archived = (await archivedResponse.json()) as { status: string };
      expect(archived.status).toBe("archived");

      const invalidLinksPatch = await app.request(
        `/v1/tasks/${encodeURIComponent(created.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ links: ["obsidian://archive-review", 42] }),
        },
      );
      expect(invalidLinksPatch.status).toBe(400);
      expect(await invalidLinksPatch.json()).toEqual({
        error: "invalid task patch",
      });

      const listedResponse = await app.request("/v1/tasks");
      expect(listedResponse.status).toBe(200);
      const listed = (await listedResponse.json()) as {
        tasks: Array<{ id: string; status: string; links: string[] }>;
      };
      expect(listed.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: created.id,
            status: "archived",
            links,
          }),
        ]),
      );
    });
  });

  test("rejects malformed task session bodies with the public startAt/endAt validation error", async () => {
    await withIsolatedGateway(async (app) => {
      const createdResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Session schema boundary" }),
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { id: string };

      const malformedBodies = [
        {
          name: "missing endAt",
          body: { startAt: "2026-07-06T16:00:00.000Z" },
        },
        {
          name: "non-string startAt",
          body: { startAt: 123, endAt: "2026-07-06T17:00:00.000Z" },
        },
      ];
      for (const { name, body } of malformedBodies) {
        const response = await app.request(
          `/v1/tasks/sessions/${encodeURIComponent(created.id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const responseBody = (await response.json()) as { error: string };
        expect({ name, status: response.status, body: responseBody }).toEqual({
          name,
          status: 400,
          body: { error: "startAt and endAt are required" },
        });
      }

      const planResponse = await app.request("/v1/tasks/plan");
      expect(planResponse.status).toBe(200);
      const plan = (await planResponse.json()) as {
        sessions: Array<{ taskId: string }>;
      };
      expect(
        plan.sessions.some((session) => session.taskId === created.id),
      ).toBe(false);
    });
  });

  test("health meal CRUD is reflected in dashboard meal source, items, and measurement history", async () => {
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
      const createdMeal = (await createResponse.json()) as {
        id: string;
        name: string;
        calories: number;
        source: string;
        notes: string | null;
        items: unknown[];
      };
      expect(createdMeal).toEqual(
        expect.objectContaining({
          name: "Post-lift bowl",
          calories: 640,
          source: "macro-tracker",
          notes: "extra salsa",
          items: [],
        }),
      );

      const updateResponse = await app.request(
        `/v1/health/meals/${encodeURIComponent(createdMeal.id)}`,
        {
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
        },
      );
      expect(updateResponse.status).toBe(200);
      const updatedMeal = (await updateResponse.json()) as {
        id: string;
        name: string;
        calories: number;
        proteinGrams: number;
        notes: string | null;
      };
      expect(updatedMeal).toEqual(
        expect.objectContaining({
          id: createdMeal.id,
          name: "Post-lift bowl updated",
          calories: 700,
          proteinGrams: 55,
          notes: null,
        }),
      );

      const dashboardResponse = await app.request("/v1/health/dashboard");
      expect(dashboardResponse.status).toBe(200);
      const dashboard = (await dashboardResponse.json()) as {
        measurementHistory: Array<{
          id: string;
          weightKg: number | null;
          bodyFatPercent: number | null;
          heightCm: number | null;
          recordedAt: string;
        }>;
        todayMeals: Array<{
          id: string;
          name: string;
          source: string;
          items: unknown[];
          calories: number;
        }>;
        recentMeals: Array<{
          id: string;
          name: string;
          source: string;
          items: unknown[];
          calories: number;
        }>;
      };
      expect(dashboard.measurementHistory).toEqual([]);
      expect(dashboard.todayMeals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdMeal.id,
            name: "Post-lift bowl updated",
            source: "macro-tracker",
            items: [],
            calories: 700,
          }),
        ]),
      );
      expect(dashboard.recentMeals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdMeal.id,
            name: "Post-lift bowl updated",
            source: "macro-tracker",
            items: [],
            calories: 700,
          }),
        ]),
      );

      const deleteResponse = await app.request(
        `/v1/health/meals/${encodeURIComponent(createdMeal.id)}`,
        { method: "DELETE" },
      );
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toEqual({ ok: true });

      const afterDeleteResponse = await app.request("/v1/health/dashboard");
      const afterDelete = (await afterDeleteResponse.json()) as {
        recentMeals: Array<{ id: string }>;
      };
      expect(
        afterDelete.recentMeals.some((meal) => meal.id === createdMeal.id),
      ).toBe(false);
    });
  });

  test("dashboard measurement history returns every macro profile snapshot in ascending recorded order", async () => {
    await withIsolatedGateway(async (app) => {
      // Injected clock makes recorded timestamps distinct; rows are seeded out of chronological
      // order so the assertion proves the query sorts ascending rather than echoing insertion order.
      saveMacroProfile(
        macroProfileInput(80),
        new Date("2026-04-01T08:00:00.000Z"),
      );
      saveMacroProfile(
        macroProfileInput(78),
        new Date("2026-05-01T08:00:00.000Z"),
      );
      saveMacroProfile(
        macroProfileInput(82),
        new Date("2026-03-01T08:00:00.000Z"),
      );

      const dashboardResponse = await app.request("/v1/health/dashboard");
      expect(dashboardResponse.status).toBe(200);
      const dashboard = (await dashboardResponse.json()) as {
        measurementHistory: Array<{
          id: string;
          weightKg: number | null;
          bodyFatPercent: number | null;
          heightCm: number | null;
          recordedAt: string;
        }>;
      };

      expect(dashboard.measurementHistory.map((m) => m.recordedAt)).toEqual([
        "2026-03-01T08:00:00.000Z",
        "2026-04-01T08:00:00.000Z",
        "2026-05-01T08:00:00.000Z",
      ]);
      // Weight rides alongside recordedAt, proving each row maps to its own timestamp.
      expect(dashboard.measurementHistory.map((m) => m.weightKg)).toEqual([
        82, 80, 78,
      ]);
      expect(dashboard.measurementHistory.map((m) => m.heightCm)).toEqual([
        180, 180, 180,
      ]);
      expect(
        dashboard.measurementHistory.every((m) => m.bodyFatPercent === null),
      ).toBe(true);
      expect(
        dashboard.measurementHistory.every(
          (m) => typeof m.id === "string" && m.id.length > 0,
        ),
      ).toBe(true);
    });
  });

  test("finance CSV import skips duplicate fingerprints and portfolio cash reflects imported account balance", async () => {
    await withIsolatedGateway(async (app) => {
      const accountId = await createFinanceAccountViaApi(app, {
        name: "Everyday Checking",
        type: "checking",
        currency: "USD",
      });
      const importBody = {
        source: "chase_checking",
        accountId,
        balance: 1234.56,
        transactions: [
          {
            fingerprint: "chase-2026-07-01-payroll",
            externalId: "txn-1",
            date: "2026-07-01",
            description: "Payroll",
            amount: 2000,
            category: "income",
            currency: "USD",
          },
          {
            fingerprint: "chase-2026-07-02-groceries",
            externalId: "txn-2",
            date: "2026-07-02",
            description: "Groceries",
            amount: -88.45,
            category: "food",
            currency: "USD",
          },
        ],
      };

      const firstImportResponse = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(importBody),
      });
      expect(firstImportResponse.status).toBe(201);
      const firstImport = (await firstImportResponse.json()) as {
        imported: number;
        skippedDuplicates: number;
        accountId: string;
      };
      expect(firstImport.imported).toBe(2);
      expect(firstImport.skippedDuplicates).toBe(0);

      const duplicateImportResponse = await app.request(
        "/v1/finance/imports/csv",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(importBody),
        },
      );
      expect(duplicateImportResponse.status).toBe(201);
      const duplicateImport = (await duplicateImportResponse.json()) as {
        imported: number;
        skippedDuplicates: number;
        accountId: string;
        status: string;
      };
      // objectContaining defends the duplicate-skip fields while tolerating canonical import
      // metadata (importId) that the response now also carries. A duplicate-only re-import is a
      // successful no-op, so status stays "completed".
      expect(duplicateImport).toEqual(
        expect.objectContaining({
          imported: 0,
          skippedDuplicates: 2,
          accountId: firstImport.accountId,
          status: "completed",
        }),
      );

      const portfolioResponse = await app.request("/v1/finance/portfolio");
      expect(portfolioResponse.status).toBe(200);
      const portfolio = (await portfolioResponse.json()) as {
        portfolio: {
          cash: number;
          equity: number;
          positions: unknown[];
        } | null;
        history: unknown[];
      };
      expect(portfolio.portfolio).toEqual({
        cash: 1234.56,
        equity: 1234.56,
        positions: [],
      });
      expect(portfolio.history).toEqual([]);
    });
  });

  test("CSV import keeps same-name accounts separate per currency and never merges the two currency groups", async () => {
    await withIsolatedGateway(async (app) => {
      // Two accounts share a name but differ by currency. Each is created up
      // front, then a matching-currency CSV import posts against its accountId;
      // the dashboard must keep them as two rows and never merge the currencies.
      const importForCurrency = async (
        currency: string,
        balance: number,
      ): Promise<string> => {
        const accountId = await createFinanceAccountViaApi(app, {
          name: "Invest",
          type: "savings",
          currency,
        });
        const response = await app.request("/v1/finance/imports/csv", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "wealthsimple",
            accountId,
            balance,
            transactions: [
              {
                fingerprint: `ws-${currency}-open`,
                date: "2026-06-01",
                description: `${currency} deposit`,
                amount: balance,
                category: "investing",
                currency,
              },
            ],
          }),
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as {
          accountId: string;
          imported: number;
        };
        expect(body.imported).toBe(1);
        return body.accountId;
      };

      const cadAccountId = await importForCurrency("CAD", 1000);
      const usdAccountId = await importForCurrency("USD", 500);

      // Same name but different currency must stay two distinct accounts.
      expect(usdAccountId).not.toBe(cadAccountId);

      // Mixed currencies: read the raw canonical dashboard directly, since the
      // reporting endpoint requires a single ?currency= and would convert.
      const dashboard = getFinanceDashboard();

      const investAccounts = dashboard.accounts.filter(
        (account) => account.name === "Invest",
      );
      expect(investAccounts).toHaveLength(2);
      // Both accounts keep the explicit "savings" type set at creation.
      expect(
        investAccounts.every((account) => account.type === "savings"),
      ).toBe(true);
      // Each currency is preserved on its own row rather than merged.
      expect(investAccounts.map((account) => account.currency).sort()).toEqual([
        "CAD",
        "USD",
      ]);
      expect(
        investAccounts.find((account) => account.id === cadAccountId)?.currency,
      ).toBe("CAD");
      expect(
        investAccounts.find((account) => account.id === usdAccountId)?.currency,
      ).toBe("USD");

      // The dashboard groups by original currency and never merges the two.
      expect(dashboard.byCurrency.map((group) => group.currency)).toEqual([
        "CAD",
        "USD",
      ]);
      const cadGroup = dashboard.byCurrency.find(
        (group) => group.currency === "CAD",
      );
      const usdGroup = dashboard.byCurrency.find(
        (group) => group.currency === "USD",
      );
      expect(cadGroup?.accounts.map((account) => account.id)).toEqual([
        cadAccountId,
      ]);
      expect(usdGroup?.accounts.map((account) => account.id)).toEqual([
        usdAccountId,
      ]);
      // Imported transactions keep the csv provenance and their own currency.
      expect(
        cadGroup?.transactions.every(
          (transaction) =>
            transaction.currency === "CAD" &&
            transaction.source === "csv" &&
            transaction.sourceVariant === "wealthsimple",
        ),
      ).toBe(true);
      expect(
        usdGroup?.transactions.every(
          (transaction) =>
            transaction.currency === "USD" &&
            transaction.source === "csv" &&
            transaction.sourceVariant === "wealthsimple",
        ),
      ).toBe(true);
    });
  });

  test("per-currency balances are never summed: the USD-scoped portfolio ignores the CAD account balance", async () => {
    await withIsolatedGateway(async (app) => {
      const cadAccountId = await createFinanceAccountViaApi(app, {
        name: "TD Chequing",
        type: "checking",
        currency: "CAD",
      });
      const cadResponse = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "td_canada",
          accountId: cadAccountId,
          balance: 1000,
          transactions: [],
        }),
      });
      expect(cadResponse.status).toBe(201);

      const usdAccountId = await createFinanceAccountViaApi(app, {
        name: "Chase Checking",
        type: "checking",
        currency: "USD",
      });
      const usdResponse = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "chase_checking",
          accountId: usdAccountId,
          balance: 500,
          transactions: [],
        }),
      });
      expect(usdResponse.status).toBe(201);

      // Mixed currencies: the raw canonical dashboard keeps each balance in its
      // own currency group and never sums across them.
      const dashboard = getFinanceDashboard();
      const cadGroup = dashboard.byCurrency.find(
        (group) => group.currency === "CAD",
      );
      const usdGroup = dashboard.byCurrency.find(
        (group) => group.currency === "USD",
      );
      expect(cadGroup?.balances.map((balance) => balance.cash)).toEqual([1000]);
      expect(usdGroup?.balances.map((balance) => balance.cash)).toEqual([500]);
      expect(
        cadGroup?.balances.every((balance) => balance.currency === "CAD"),
      ).toBe(true);
      expect(
        usdGroup?.balances.every((balance) => balance.currency === "USD"),
      ).toBe(true);

      // The legacy portfolio view aggregates a single base currency (USD) and
      // must not add the CAD 1000 into the USD total.
      const portfolioResponse = await app.request("/v1/finance/portfolio");
      expect(portfolioResponse.status).toBe(200);
      const portfolio = (await portfolioResponse.json()) as {
        portfolio: { cash: number; equity: number } | null;
      };
      expect(portfolio.portfolio?.cash).toBe(500);
      expect(portfolio.portfolio?.equity).toBe(500);
    });
  });

  test("a CSV transaction with an unparseable date rejects the whole import and persists nothing", async () => {
    await withIsolatedGateway(async (app) => {
      const accountId = await createFinanceAccountViaApi(app, {
        name: "Everyday Checking",
        type: "checking",
        currency: "USD",
      });
      const response = await app.request("/v1/finance/imports/csv", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "chase_checking",
          accountId,
          balance: 250,
          transactions: [
            {
              fingerprint: "ok-row",
              date: "2026-07-01",
              description: "Payroll",
              amount: 2000,
              category: "income",
              currency: "USD",
            },
            {
              fingerprint: "bad-row",
              date: "not-a-date",
              description: "Broken",
              amount: -10,
              category: "spending",
              currency: "USD",
            },
          ],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid finance import",
      });

      // The bad date rejects the whole import before any write: no balance
      // update, no balance row, and no transaction leaks in. Only the manually
      // created account remains, with its balance still unset.
      const dashboard = getFinanceDashboard();
      expect(dashboard.accounts).toHaveLength(1);
      expect(dashboard.accounts[0].id).toBe(accountId);
      expect(dashboard.accounts[0].balance).toBeNull();
      expect(dashboard.balances).toEqual([]);
      expect(dashboard.transactions).toEqual([]);
    });
  });

  test("integration catalog, Hevy settings, sync, and overview expose persisted domain state", async () => {
    await withIsolatedGateway(async (app) => {
      const mealResponse = await app.request("/v1/health/meals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Overview breakfast",
          mealType: "breakfast",
          loggedAt: new Date().toISOString(),
          calories: 410,
          proteinGrams: 30,
          carbsGrams: 44,
          fatGrams: 12,
          source: "overview-test",
          notes: null,
        }),
      });
      expect(mealResponse.status).toBe(201);

      const taskResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Review overview contracts",
          dueAt: currentWeekDate(10, 16).toISOString(),
          priority: "high",
          source: "overview-test",
        }),
      });
      expect(taskResponse.status).toBe(201);

      await createFinanceAccountViaApi(app, {
        name: "Manual Cash",
        type: "checking",
        currency: "USD",
        balance: 500,
      });

      const catalogResponse = await app.request("/v1/integrations");
      expect(catalogResponse.status).toBe(200);
      const catalog = (await catalogResponse.json()) as {
        integrations: Array<{
          id: string;
          displayName: string;
          category: string;
          capabilities: string[];
          authType: string;
          status: string;
          setupHint?: string;
        }>;
      };
      expect(catalog.integrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "hevy",
            displayName: "Hevy",
            category: "health",
            capabilities: ["workouts.sync"],
            authType: "token",
            status: "available",
            setupHint: "Save API key to sync workouts.",
          }),
        ]),
      );

      const settingsResponse = await app.request(
        "/v1/integrations/hevy/settings",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: "hevy_contract_token" }),
        },
      );
      expect(settingsResponse.status).toBe(200);
      expect(await settingsResponse.json()).toEqual(
        expect.objectContaining({
          ok: true,
          status: "connected",
          connected: true,
          hasApiKey: true,
          secretProvider: "local",
        }),
      );

      const connectedCatalogResponse = await app.request("/v1/integrations");
      const connectedCatalog = (await connectedCatalogResponse.json()) as {
        integrations: Array<{ id: string; status: string }>;
      };
      expect(connectedCatalog.integrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "hevy", status: "connected" }),
        ]),
      );

      const hevyFetch = withFakeHevyFetch(() => ({
        payload: { workouts: [], page_count: 1 },
      }));
      try {
        const syncResponse = await app.request("/v1/integrations/hevy/sync", {
          method: "POST",
        });
        expect(syncResponse.status).toBe(200);
        expect(await syncResponse.json()).toEqual({
          fetched: 0,
          created: 0,
          updated: 0,
        });
      } finally {
        hevyFetch.restore();
      }

      const overviewResponse = await app.request("/v1/overview");
      expect(overviewResponse.status).toBe(200);
      const overview = (await overviewResponse.json()) as {
        health: { status: string; nudge: string; confidence: string };
        life: { status: string; doNow: string; todayEventCount: number };
        finance: { status: string; equity: number | null; cash: number | null };
        integrations: Array<{ id: string; status: string }>;
      };
      expect(overview.health).toEqual(
        expect.objectContaining({
          status: "partial",
          nudge: "Meals logged today.",
          confidence: "medium",
        }),
      );
      expect(overview.life).toEqual(
        expect.objectContaining({
          status: "partial",
          doNow: "Review overview contracts",
          todayEventCount: 0,
        }),
      );
      expect(overview.finance).toEqual(
        expect.objectContaining({ status: "partial", equity: 500, cash: 500 }),
      );
      expect(overview.integrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "hevy", status: "connected" }),
        ]),
      );
    });
  });

  test("events stream sends SSE headers and backfills changed events emitted by writes", async () => {
    await withIsolatedGateway(async (app) => {
      const taskResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Trigger event stream",
          priority: "normal",
        }),
      });
      expect(taskResponse.status).toBe(201);
      const task = (await taskResponse.json()) as { id: string };

      const eventsResponse = await app.request("/v1/events?lastEventId=0");
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.headers.get("content-type")).toBe(
        "text/event-stream",
      );
      expect(eventsResponse.headers.get("cache-control")).toBe("no-cache");
      expect(eventsResponse.headers.get("connection")).toBe("keep-alive");

      const sseChunk = await readFirstSseChunk(eventsResponse);
      expect(sseChunk).toContain("event: task.changed\n");
      expect(sseChunk).toContain(`"entityId":"${task.id}"`);
      expect(sseChunk).toContain('"domain":"life"');
    });
  });
});
