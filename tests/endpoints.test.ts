import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDatabaseForTests } from "../src/core/db/database";
import {
  createApp,
  type App,
  type CreateAppOptions,
} from "../src/platform/gateway/app";
import type { AnorvisWikiResult } from "../src/llm-wiki";

type EndpointFixture = {
  app: App;
  home: string;
};

async function withIsolatedGateway(
  run: (fixture: EndpointFixture) => Promise<void>,
): Promise<void> {
  const environment = captureEnvironment(
    "HOME",
    "ANORVIS_DB_PATH",
    "ANORVIS_OS_API_TOKEN",
    "ANORVIS_SECRET_PROVIDER",
  );
  const home = mkdtempSync(join(tmpdir(), "anorvis-endpoints-"));
  process.env.HOME = home;
  process.env.ANORVIS_DB_PATH = join(home, ".anorvis", "data", "test.sqlite");
  process.env.ANORVIS_SECRET_PROVIDER = "local";
  delete process.env.ANORVIS_OS_API_TOKEN;
  resetDatabaseForTests();

  try {
    await run({ app: createApp({ wikiAgent: fakeWikiAgent }), home });
  } finally {
    restoreEnvironment(environment);
    resetDatabaseForTests();
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

function fakeWikiAgent(
  input: Parameters<NonNullable<CreateAppOptions["wikiAgent"]>>[0],
): Promise<AnorvisWikiResult> {
  return Promise.resolve({
    task: input.task,
    answer: "ok",
    confidence: "high",
    sources: [],
    changed: [],
    readNext: [],
    contradictions: [],
    gaps: [],
    warnings: [],
  });
}

function jsonRequest(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function expectJson(
  app: App,
  path: string,
  init: RequestInit | undefined,
  expectedStatus: number,
): Promise<unknown> {
  const response = await app.request(path, init);
  expect(response.status, `${init?.method ?? "GET"} ${path}`).toBe(
    expectedStatus,
  );
  return response.json();
}

function expectObject(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function expectString(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

const HEVY_WORKOUTS_URL = "https://api.hevyapp.com/v1/workouts";
const HEVY_BODY_MEASUREMENTS_URL =
  "https://api.hevyapp.com/v1/body_measurements";

// Mirrors os/tests/web-contract.test.ts and hevy-secrets.test.ts: swap globalThis.fetch so the
// Hevy sync contract runs deterministically offline (empty workouts and body measurements)
// instead of reaching the live api.hevyapp.com and failing on the fake token.
function withFakeHevyFetch(): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let payload: unknown;
    if (url.startsWith(HEVY_WORKOUTS_URL)) {
      payload = { workouts: [], page_count: 1 };
    } else if (url.startsWith(HEVY_BODY_MEASUREMENTS_URL)) {
      payload = { body_measurements: [], page_count: 1 };
    } else {
      return Promise.reject(
        new Error(`unexpected network fetch in test: ${url}`),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { restore: () => void (globalThis.fetch = original) };
}

describe("Anorvis OS endpoint coverage", () => {
  test("core health, auth, status, overview, life, events, and wiki endpoints respond", async () => {
    await withIsolatedGateway(async ({ app, home }) => {
      expect(await expectJson(app, "/health", undefined, 200)).toMatchObject({
        ok: true,
      });
      expect(
        await expectJson(app, "/v1/os/status", undefined, 200),
      ).toMatchObject({ ok: true, storage: { sqlite: "centralized" } });
      const overview = expectObject(
        await expectJson(app, "/v1/overview", undefined, 200),
      );
      expectObject(overview.life);
      expectObject(overview.health);
      expectObject(overview.finance);
      expect(Array.isArray(overview.integrations)).toBe(true);
      const life = expectObject(
        await expectJson(app, "/v1/life/snapshot", undefined, 200),
      );
      expect(Array.isArray(life.queue)).toBe(true);

      const eventResponse = await app.request("/v1/events");
      expect(eventResponse.status).toBe(200);
      expect(eventResponse.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      await eventResponse.body?.cancel().catch(() => undefined);

      const initResult = expectObject(
        await expectJson(app, "/v1/llm-wiki/init", { method: "POST" }, 200),
      );
      expect(typeof initResult.rootDir).toBe("string");
      expect(
        await expectJson(app, "/v1/llm-wiki/vaults", undefined, 200),
      ).toEqual({ vaults: [] });

      const vaultPath = join(home, "vault");
      mkdirSync(join(vaultPath, ".obsidian"), { recursive: true });
      const vaultResult = expectObject(
        await expectJson(
          app,
          "/v1/llm-wiki/vaults",
          jsonRequest({ name: "local", path: vaultPath }),
          201,
        ),
      );
      const vault = expectObject(vaultResult.vault);
      expect(vault.name).toBe("local");
      expect(expectString(vault.path)).toContain("/vault");
      expect(
        await expectJson(
          app,
          "/v1/llm-wiki/wiki",
          jsonRequest({ task: "summarize", dryRun: true }),
          200,
        ),
      ).toEqual(expect.objectContaining({ task: "summarize", answer: "ok" }));
      expect(
        await expectJson(
          app,
          "/v1/llm-wiki/interaction",
          jsonRequest({ sessionId: "s1", prompt: "hello" }),
          200,
        ),
      ).toEqual(expect.objectContaining({ ok: true }));
      const lintResult = expectObject(
        await expectJson(app, "/v1/llm-wiki/lint", undefined, 200),
      );
      expect(typeof lintResult.ok).toBe("boolean");
      expect(
        await expectJson(
          app,
          "/v1/auth/handshake",
          jsonRequest({ token: "browser-token-123456" }),
          201,
        ),
      ).toMatchObject({ ok: true });
    });
  });

  test("calendar and task endpoints cover create, list, update, complete, session, and delete", async () => {
    await withIsolatedGateway(async ({ app }) => {
      expect(
        await expectJson(app, "/v1/calendar/events", undefined, 200),
      ).toEqual({ events: [], items: [] });
      const event = (await expectJson(
        app,
        "/v1/calendar/events",
        jsonRequest({
          summary: "focus",
          startAt: "2026-07-08T09:00:00.000Z",
          endAt: "2026-07-08T10:00:00.000Z",
          source: "manual",
        }),
        201,
      )) as { id: string };
      expect(
        await expectJson(
          app,
          `/v1/calendar/events/${encodeURIComponent(event.id)}`,
          jsonRequest({ summary: "deep focus" }, "PATCH"),
          200,
        ),
      ).toEqual(expect.objectContaining({ summary: "deep focus" }));
      expect(
        await expectJson(
          app,
          `/v1/calendar/events/${encodeURIComponent(event.id)}`,
          { method: "DELETE" },
          200,
        ),
      ).toEqual({ ok: true });

      expect(await expectJson(app, "/v1/tasks", undefined, 200)).toEqual({
        tasks: [],
      });
      const task = expectObject(
        await expectJson(
          app,
          "/v1/tasks",
          jsonRequest({
            title: "Ship endpoint tests",
            status: "todo",
            dueAt: "2026-07-08T12:00:00.000Z",
          }),
          201,
        ),
      );
      const taskId = expectString(task.id);
      const taskPlan = expectObject(
        await expectJson(app, "/v1/tasks/plan", undefined, 200),
      );
      expect(Array.isArray(taskPlan.tasks)).toBe(true);
      expect(taskPlan.sessions).toEqual([]);
      expect(
        await expectJson(
          app,
          `/v1/tasks/${encodeURIComponent(taskId)}`,
          jsonRequest({ priority: "high" }, "PATCH"),
          200,
        ),
      ).toEqual(expect.objectContaining({ priority: "high" }));
      expect(
        await expectJson(
          app,
          `/v1/tasks/sessions/${encodeURIComponent(taskId)}`,
          jsonRequest(
            {
              startAt: "2026-07-08T12:00:00.000Z",
              endAt: "2026-07-08T12:30:00.000Z",
            },
            "PATCH",
          ),
          200,
        ),
      ).toEqual(expect.objectContaining({ taskId }));
      expect(
        await expectJson(
          app,
          `/v1/tasks/${encodeURIComponent(taskId)}/complete`,
          { method: "PATCH" },
          200,
        ),
      ).toEqual(expect.objectContaining({ status: "completed" }));
      expect(
        await expectJson(
          app,
          `/v1/tasks/${encodeURIComponent(taskId)}`,
          { method: "DELETE" },
          200,
        ),
      ).toEqual({ ok: true });
    });
  });

  test("task create accepts dueAt and rejects retired date input", async () => {
    await withIsolatedGateway(async ({ app }) => {
      const dueAt = "2026-07-08T14:30:00.000Z";

      const created = expectObject(
        await expectJson(
          app,
          "/v1/tasks",
          jsonRequest({ title: "dueAt iso", dueAt }),
          201,
        ),
      );
      expect(created.dueAt).toBe(dueAt);

      expect(
        await expectJson(
          app,
          "/v1/tasks",
          jsonRequest({ title: "retired date", date: "2026-07-08" }),
          400,
        ),
      ).toEqual({ error: "invalid task input" });
    });
  });

  test("task patch clears dueAt and rejects retired date input", async () => {
    await withIsolatedGateway(async ({ app }) => {
      const created = expectObject(
        await expectJson(
          app,
          "/v1/tasks",
          jsonRequest({
            title: "patch target",
            dueAt: "2026-07-01T09:00:00.000Z",
          }),
          201,
        ),
      );
      const path = `/v1/tasks/${encodeURIComponent(expectString(created.id))}`;

      const cleared = expectObject(
        await expectJson(app, path, jsonRequest({ dueAt: null }, "PATCH"), 200),
      );
      expect(cleared.dueAt).toBeNull();

      const patchedDueAt = expectObject(
        await expectJson(
          app,
          path,
          jsonRequest({ dueAt: "2026-07-09T10:00:00.000Z" }, "PATCH"),
          200,
        ),
      );
      expect(patchedDueAt.dueAt).toBe("2026-07-09T10:00:00.000Z");

      expect(
        await expectJson(
          app,
          path,
          jsonRequest({ date: "2026-07-10T18:45:00.000Z" }, "PATCH"),
          400,
        ),
      ).toEqual({ error: "invalid task patch" });
    });
  });

  test("health and finance endpoints cover dashboard, CRUD writes, profile, workout, and import", async () => {
    await withIsolatedGateway(async ({ app }) => {
      expect(
        await expectJson(app, "/v1/health/dashboard", undefined, 200),
      ).toEqual(
        expect.objectContaining({ todayMeals: [], recentWorkouts: [] }),
      );
      const meal = (await expectJson(
        app,
        "/v1/health/meals",
        jsonRequest({
          name: "eggs",
          mealType: "breakfast",
          loggedAt: "2026-07-08T08:00:00.000Z",
          calories: 300,
          proteinGrams: 24,
          carbsGrams: 2,
          fatGrams: 20,
          source: "manual",
          notes: "local",
        }),
        201,
      )) as { id: string };
      expect(
        await expectJson(
          app,
          `/v1/health/meals/${encodeURIComponent(meal.id)}`,
          jsonRequest(
            {
              name: "eggs and toast",
              mealType: "breakfast",
              loggedAt: "2026-07-08T08:00:00.000Z",
              calories: 420,
              proteinGrams: 28,
              carbsGrams: 32,
              fatGrams: 22,
              source: "manual",
              notes: "updated",
            },
            "PUT",
          ),
          200,
        ),
      ).toEqual(expect.objectContaining({ name: "eggs and toast" }));
      expect(
        await expectJson(
          app,
          "/v1/health/macro-profile",
          jsonRequest({
            goal: "maintain",
            sex: "male",
            age: 35,
            heightCm: 180,
            weightKg: 80,
            bodyFatPercent: 18,
            activityLevel: "moderate",
            birthdate: "1991-01-01",
            trainingDaysPerWeek: 4,
            targetCalories: 2400,
            proteinGrams: 160,
            carbsGrams: 260,
            fatGrams: 80,
          }),
          201,
        ),
      ).toEqual(expect.objectContaining({ targetCalories: 2400 }));
      const workout = (await expectJson(
        app,
        "/v1/health/workouts",
        jsonRequest({
          title: "lift",
          startedAt: "2026-07-08T17:00:00.000Z",
          durationSeconds: 1800,
          notes: "",
          source: "manual",
          exercises: [
            {
              title: "squat",
              muscleGroups: ["legs"],
              sets: [{ setType: "normal", reps: 5, weightKg: 100 }],
            },
          ],
        }),
        201,
      )) as { id: string };
      expect(
        await expectJson(
          app,
          `/v1/health/workouts/${encodeURIComponent(workout.id)}`,
          jsonRequest(
            {
              title: "heavy lift",
              startedAt: "2026-07-08T17:00:00.000Z",
              durationSeconds: 2100,
              notes: "updated",
              source: "manual",
              exercises: [
                {
                  title: "squat",
                  muscleGroups: ["legs"],
                  sets: [{ setType: "normal", reps: 5, weightKg: 105 }],
                },
              ],
            },
            "PUT",
          ),
          200,
        ),
      ).toEqual(expect.objectContaining({ title: "heavy lift" }));
      expect(
        await expectJson(
          app,
          `/v1/health/meals/${encodeURIComponent(meal.id)}`,
          { method: "DELETE" },
          200,
        ),
      ).toEqual({ ok: true });

      expect(
        await expectJson(app, "/v1/finance/portfolio", undefined, 200),
      ).toEqual(expect.objectContaining({ portfolio: null, history: [] }));
      const account = (await expectJson(
        app,
        "/v1/finance/accounts",
        jsonRequest({ name: "Checking", type: "checking", currency: "USD" }),
        201,
      )) as { account: { id: string } };
      expect(
        await expectJson(
          app,
          "/v1/finance/imports/csv",
          jsonRequest({
            source: "manual",
            accountId: account.account.id,
            balance: 1250,
            transactions: [
              {
                fingerprint: "checking-1",
                date: "2026-07-08",
                description: "deposit",
                amount: 1250,
                category: "income",
                currency: "USD",
              },
            ],
          }),
          201,
        ),
      ).toEqual(expect.objectContaining({ imported: 1, skippedDuplicates: 0 }));
    });
  });

  test("integration and provider endpoints cover catalog, definitions, connections, settings, sync, and disconnect", async () => {
    await withIsolatedGateway(async ({ app }) => {
      const integrations = expectObject(
        await expectJson(app, "/v1/integrations", undefined, 200),
      );
      expect(Array.isArray(integrations.integrations)).toBe(true);
      const providers = expectObject(
        await expectJson(app, "/v1/providers", undefined, 200),
      );
      expect(Array.isArray(providers.providers)).toBe(true);
      expect(
        await expectJson(
          app,
          "/v1/providers",
          jsonRequest({
            id: "local.notes",
            displayName: "Local Notes",
            category: "productivity",
            capabilities: ["notes"],
            authType: "token",
          }),
          201,
        ),
      ).toEqual(expect.objectContaining({ id: "local.notes" }));
      expect(
        await expectJson(
          app,
          "/v1/providers/local.notes/connection",
          jsonRequest({
            settings: { enabled: true },
            secrets: { token: "secret" },
          }),
          200,
        ),
      ).toEqual(expect.objectContaining({ status: "connected" }));
      expect(
        await expectJson(
          app,
          "/v1/providers/local.notes/connection",
          { method: "DELETE" },
          200,
        ),
      ).toEqual({ ok: true });
      expect(
        await expectJson(app, "/v1/integrations/hevy/settings", undefined, 200),
      ).toEqual(expect.objectContaining({ connected: false }));
      expect(
        await expectJson(
          app,
          "/v1/integrations/hevy/settings",
          jsonRequest({ apiKey: "hevy-token" }),
          200,
        ),
      ).toEqual(expect.objectContaining({ ok: true, status: "connected" }));
      const hevyFetch = withFakeHevyFetch();
      try {
        expect(
          await expectJson(
            app,
            "/v1/integrations/hevy/sync",
            { method: "POST" },
            200,
          ),
        ).toEqual(
          expect.objectContaining({ fetched: 0, created: 0, updated: 0 }),
        );
      } finally {
        hevyFetch.restore();
      }
      expect(
        await expectJson(
          app,
          "/v1/integrations/hevy/disconnect",
          { method: "POST" },
          200,
        ),
      ).toEqual({ ok: true });
    });
  });

  test("invalid payloads return endpoint-specific 400 errors without writes", async () => {
    await withIsolatedGateway(async ({ app }) => {
      expect(await expectJson(app, "/v1/tasks", jsonRequest({}), 400)).toEqual({
        error: "title is required",
      });
      expect(
        await expectJson(
          app,
          "/v1/tasks/sessions/missing",
          jsonRequest({ startAt: "2026-07-08T12:00:00.000Z" }, "PATCH"),
          400,
        ),
      ).toEqual({ error: "startAt and endAt are required" });
      expect(
        await expectJson(
          app,
          "/v1/calendar/events",
          jsonRequest({ summary: "missing times" }),
          400,
        ),
      ).toEqual({ error: "summary, startAt, and endAt are required" });
      expect(
        await expectJson(app, "/v1/health/meals", jsonRequest({}), 400),
      ).toEqual({ error: "invalid meal input" });
      expect(
        await expectJson(app, "/v1/health/macro-profile", jsonRequest([]), 400),
      ).toEqual({ error: "invalid macro profile input" });
      expect(
        await expectJson(app, "/v1/health/workouts", jsonRequest({}), 400),
      ).toEqual({ error: "invalid workout input" });
      expect(
        await expectJson(
          app,
          "/v1/finance/imports/csv",
          jsonRequest({ source: "manual" }),
          400,
        ),
      ).toEqual({ error: "invalid finance import" });
      const providerError = expectObject(
        await expectJson(app, "/v1/providers", jsonRequest({ id: "bad" }), 400),
      );
      expect(expectString(providerError.error)).toContain("displayName");
      expect(
        await expectJson(
          app,
          "/v1/providers/missing/connection",
          jsonRequest({ secrets: { token: "x" } }),
          404,
        ),
      ).toEqual({ error: "provider not found" });
      expect(
        await expectJson(
          app,
          "/v1/llm-wiki/vaults",
          jsonRequest({ path: "/definitely/missing/vault" }),
          400,
        ),
      ).toEqual({ error: "path is required" });
      expect(
        await expectJson(app, "/v1/llm-wiki/interaction", jsonRequest({}), 400),
      ).toEqual({ error: "prompt, assistant, or interaction is required" });
    });
  });

  test("protected non-loopback routes reject missing and bad auth", async () => {
    await withIsolatedGateway(async ({ home }) => {
      const config = {
        baseUrl: "http://0.0.0.0:8787",
        bindHost: "0.0.0.0",
        port: 8787,
        dataRoot: join(home, ".anorvis"),
        databasePath: join(home, ".anorvis", "data", "test.sqlite"),
        storageMode: "centralized" as const,
        tailnetName: null,
      };

      const missingTokenApp = createApp({ config });
      const missingToken = await missingTokenApp.request("/v1/overview");
      expect(missingToken.status).toBe(503);
      expect(await missingToken.json()).toEqual({
        error: "auth_token_required",
      });

      process.env.ANORVIS_OS_API_TOKEN = "configured-token";
      const protectedApp = createApp({ config });
      const badAuth = await protectedApp.request("/v1/overview", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(badAuth.status).toBe(401);
      expect(await badAuth.text()).toBe("Unauthorized");

      const goodAuth = expectObject(
        await expectJson(
          protectedApp,
          "/v1/overview",
          { headers: { authorization: "Bearer configured-token" } },
          200,
        ),
      );
      expectObject(goodAuth.life);
    });
  });

  test("calendar event creation returns JSON 400 for malformed dates and inverted ranges", async () => {
    await withIsolatedGateway(async ({ app }) => {
      const malformed = expectObject(
        await expectJson(
          app,
          "/v1/calendar/events",
          jsonRequest({
            summary: "bad date",
            startAt: "not-a-real-date",
            endAt: "2026-07-08T10:00:00.000Z",
          }),
          400,
        ),
      );
      expectString(malformed.error);

      const inverted = expectObject(
        await expectJson(
          app,
          "/v1/calendar/events",
          jsonRequest({
            summary: "backwards",
            startAt: "2026-07-08T10:00:00.000Z",
            endAt: "2026-07-08T09:00:00.000Z",
          }),
          400,
        ),
      );
      expectString(inverted.error);

      expect(
        await expectJson(app, "/v1/calendar/events", undefined, 200),
      ).toEqual({ events: [], items: [] });
    });
  });

  test("unknown routes resolve to a JSON 404 error", async () => {
    await withIsolatedGateway(async ({ app }) => {
      expect(
        await expectJson(app, "/v1/does-not-exist", undefined, 404),
      ).toEqual({ error: "not_found" });
    });
  });
});
