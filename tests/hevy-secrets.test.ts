import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabaseForTests } from "../src/core/db/database";
import { createApp } from "../src/platform/gateway/app";

type GatewayApp = {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

type HevySettingsResponse = {
  ok?: boolean;
  status?: string;
  connected: boolean;
  hasApiKey: boolean;
  secretProvider: string | null;
};

type HevyConnectionRow = {
  status: string;
  settings_json: string | null;
  secret_refs_json: string | null;
};

async function withIsolatedGateway(run: (app: GatewayApp) => Promise<void>): Promise<void> {
  const oldHome = process.env.HOME;
  const oldToken = process.env.ANORVIS_OS_API_TOKEN;
  const oldDbPath = process.env.ANORVIS_DB_PATH;
  const oldSecretProvider = process.env.ANORVIS_SECRET_PROVIDER;
  const oldSecretKeyPath = process.env.ANORVIS_SECRET_KEY_PATH;
  process.env.HOME = mkdtempSync(join(tmpdir(), "anorvis-hevy-secrets-"));
  delete process.env.ANORVIS_OS_API_TOKEN;
  delete process.env.ANORVIS_DB_PATH;
  process.env.ANORVIS_SECRET_PROVIDER = "local";
  delete process.env.ANORVIS_SECRET_KEY_PATH;
  resetDatabaseForTests();

  try {
    await run(createApp());
  } finally {
    resetDatabaseForTests();
    process.env.HOME = oldHome;
    if (oldToken === undefined) delete process.env.ANORVIS_OS_API_TOKEN;
    else process.env.ANORVIS_OS_API_TOKEN = oldToken;
    if (oldDbPath === undefined) delete process.env.ANORVIS_DB_PATH;
    else process.env.ANORVIS_DB_PATH = oldDbPath;
    if (oldSecretProvider === undefined) delete process.env.ANORVIS_SECRET_PROVIDER;
    else process.env.ANORVIS_SECRET_PROVIDER = oldSecretProvider;
    if (oldSecretKeyPath === undefined) delete process.env.ANORVIS_SECRET_KEY_PATH;
    else process.env.ANORVIS_SECRET_KEY_PATH = oldSecretKeyPath;
  }
}

function hevyConnection(): HevyConnectionRow | null {
  return getDatabase().query<HevyConnectionRow, []>(`
    SELECT status, settings_json, secret_refs_json
    FROM provider_connections
    WHERE provider_id = 'hevy'
  `).get() ?? null;
}

function hevySecretRef(row: HevyConnectionRow | null): string | undefined {
  const refs = JSON.parse(row?.secret_refs_json ?? "{}") as { token?: string };
  return refs.token;
}

function localSecretRecordExists(secretRef: string): boolean {
  const id = secretRef.startsWith("secret:") ? secretRef.slice("secret:".length) : secretRef;
  return getDatabase().query<{ present: number }, [string]>("SELECT 1 AS present FROM secret_records WHERE id = ?1").get(id)?.present === 1;
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

const HEVY_WORKOUTS_URL = "https://api.hevyapp.com/v1/workouts";

const CALENDAR_RANGE =
  "/v1/calendar/events?timeMin=2032-05-01T00:00:00.000Z&timeMax=2032-05-31T00:00:00.000Z";

type SyncSummary = { fetched: number; created: number; updated: number };

type CalendarItem = {
  id: string;
  summary: string;
  startAt: string;
  endAt: string;
  tag?: string;
  source?: string;
  calendarId?: string;
  readOnly?: boolean;
  allDay?: boolean;
  providerEventId?: string;
};

type HevyFetchResult = { status?: number; payload: unknown };

// One timed Hevy workout so the derived calendar start/end are exact and assertable.
const HEVY_WORKOUT = {
  id: "workout-abc-123",
  title: "Morning Push",
  description: "Chest and triceps",
  start_time: "2032-05-10T08:00:00.000Z",
  end_time: "2032-05-10T09:00:00.000Z",
  exercises: [{ title: "Bench Press", sets: [{ type: "normal", reps: 8, weight_kg: 60 }] }],
};

function withFakeHevyFetch(handler: () => HevyFetchResult): {
  apiKeys: string[];
  requestedUrls: string[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const apiKeys: string[] = [];
  const requestedUrls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(HEVY_WORKOUTS_URL)) {
      return Promise.reject(new Error(`unexpected network fetch in test: ${url}`));
    }
    requestedUrls.push(url);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const apiKey = headers.get("api-key");
    if (apiKey !== null) apiKeys.push(apiKey);
    const { status = 200, payload } = handler();
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { apiKeys, requestedUrls, restore: () => void (globalThis.fetch = original) };
}

const HEVY_ROUTINES_URL = "https://api.hevyapp.com/v1/routines";

// Like withFakeHevyFetch, but scoped to GET /v1/routines and keyed by page so a test can
// serve a distinct payload per page and observe exactly which pages were fetched.
function withFakeHevyRoutinesFetch(handler: (page: number) => HevyFetchResult): {
  apiKeys: string[];
  requestedPages: number[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const apiKeys: string[] = [];
  const requestedPages: number[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(HEVY_ROUTINES_URL)) {
      return Promise.reject(new Error(`unexpected network fetch in test: ${url}`));
    }
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    requestedPages.push(page);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const apiKey = headers.get("api-key");
    if (apiKey !== null) apiKeys.push(apiKey);
    const { status = 200, payload } = handler(page);
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { apiKeys, requestedPages, restore: () => void (globalThis.fetch = original) };
}

describe("Hevy secret gateway contracts", () => {
  test("rejects blank Hevy apiKey without connecting the integration", async () => {
    await withIsolatedGateway(async (app) => {
      const response = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "   \t\n" }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "apiKey is required" });
      expect(hevyConnection()).toBeNull();

      const settingsResponse = await app.request("/v1/integrations/hevy/settings");
      expect(settingsResponse.status).toBe(200);
      expect(await settingsResponse.json()).toEqual({ connected: false, hasApiKey: false, lastCheckedAt: null, secretProvider: null });
    });
  });

  test("forbids Hevy sync until an API key is connected", async () => {
    await withIsolatedGateway(async (app) => {
      const response = await app.request("/v1/integrations/hevy/sync", { method: "POST" });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        ok: false,
        error: "integration not connected",
        code: "integration_not_connected",
        provider: "hevy",
      });
    });
  });

  test("stores an opaque Hevy secret_ref instead of the API token or its base64 encoding", async () => {
    await withIsolatedGateway(async (app) => {
      const apiKey = "hevy_live_token:secret-value/with+symbols";
      const base64ApiKey = Buffer.from(apiKey).toString("base64");

      const response = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      expect(response.status).toBe(200);
      const settings = await response.json() as HevySettingsResponse;
      expect(settings.ok).toBe(true);
      expect(settings.status).toBe("connected");
      expect(settings.connected).toBe(true);
      expect(settings.hasApiKey).toBe(true);
      expect(settings.secretProvider).toBe("local");

      const row = hevyConnection();
      expect(row?.status).toBe("connected");
      const secretRef = hevySecretRef(row);
      if (typeof secretRef !== "string") throw new Error("Expected a stored secret reference.");
      expect(secretRef).not.toContain(apiKey);
      expect(secretRef).not.toContain(base64ApiKey);
      expect(row?.settings_json ?? "").not.toContain(apiKey);
      expect(row?.settings_json ?? "").not.toContain(base64ApiKey);

      const fetchFake = withFakeHevyFetch(() => ({ payload: { workouts: [] } }));
      try {
        const syncResponse = await app.request("/v1/integrations/hevy/sync", { method: "POST" });
        expect(syncResponse.status).toBe(200);
        expect(await syncResponse.json()).toEqual({ fetched: 0, created: 0, updated: 0 });
      } finally {
        fetchFake.restore();
      }
    });
  });

  test("disconnect clears Hevy route state and removes the stored secret reference", async () => {
    await withIsolatedGateway(async (app) => {
      const apiKey = "hevy_disconnect_token";
      const saveResponse = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      expect(saveResponse.status).toBe(200);
      const secretRef = hevySecretRef(hevyConnection());
      if (typeof secretRef !== "string") throw new Error("Expected a stored secret reference.");
      expect(localSecretRecordExists(secretRef)).toBe(true);

      const disconnectResponse = await app.request("/v1/integrations/hevy/disconnect", { method: "POST" });
      expect(disconnectResponse.status).toBe(200);
      expect(await disconnectResponse.json()).toEqual({ ok: true });

      const settingsResponse = await app.request("/v1/integrations/hevy/settings");
      expect(settingsResponse.status).toBe(200);
      const disconnectedSettings = await settingsResponse.json() as HevySettingsResponse;
      expect(disconnectedSettings.connected).toBe(false);
      expect(disconnectedSettings.hasApiKey).toBe(false);
      expect(disconnectedSettings.secretProvider).toBeNull();

      const disconnected = hevyConnection();
      expect(disconnected?.status).toBe("available");
      expect(disconnected?.settings_json).toBe("{}");
      expect(disconnected?.secret_refs_json).toBe("{}");
      expect(localSecretRecordExists(secretRef)).toBe(false);

      const syncResponse = await app.request("/v1/integrations/hevy/sync", { method: "POST" });
      expect(syncResponse.status).toBe(403);
      expect(await syncResponse.json()).toEqual({
        ok: false,
        error: "integration not connected",
        code: "integration_not_connected",
        provider: "hevy",
      });
    });
  });


  test("forbids Hevy sync when the stored secret reference is stale", async () => {
    await withIsolatedGateway(async (app) => {
      const saveResponse = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "hevy_stale_token" }),
      });
      expect(saveResponse.status).toBe(200);
      const secretRef = hevySecretRef(hevyConnection());
      if (typeof secretRef !== "string") throw new Error("Expected a stored secret reference.");
      const id = secretRef.startsWith("secret:") ? secretRef.slice("secret:".length) : secretRef;
      getDatabase().query("DELETE FROM secret_records WHERE id = ?1").run(id);

      const response = await app.request("/v1/integrations/hevy/sync", { method: "POST" });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        ok: false,
        error: "integration not connected",
        code: "integration_not_connected",
        provider: "hevy",
      });
    });
  });

  test("events stream backfills only events after the Last-Event-ID header", async () => {
    await withIsolatedGateway(async (app) => {
      const firstResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Already received before reconnect" }),
      });
      expect(firstResponse.status).toBe(201);
      const firstTask = await firstResponse.json() as { id: string };

      const secondResponse = await app.request("/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Created while disconnected" }),
      });
      expect(secondResponse.status).toBe(201);
      const secondTask = await secondResponse.json() as { id: string };

      const eventsResponse = await app.request("/v1/events", { headers: { "Last-Event-ID": "1" } });
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.headers.get("content-type")).toBe("text/event-stream");

      const sseChunk = await readFirstSseChunk(eventsResponse);
      expect(sseChunk).toContain("event: task.changed\n");
      expect(sseChunk).toContain(`"entityId":"${secondTask.id}"`);
      expect(sseChunk).not.toContain(`"entityId":"${firstTask.id}"`);
    });
  });
});

describe("Hevy sync surfaces workouts on the life calendar", () => {
  test("sync stores fetched workouts and /v1/calendar/events yields a read-only hevy event with exact time, tag, and source", async () => {
    await withIsolatedGateway(async (app) => {
      const apiKey = "hevy_live_sync_token";
      const saveResponse = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      expect(saveResponse.status).toBe(200);

      const fetchFake = withFakeHevyFetch(() => ({ payload: { workouts: [HEVY_WORKOUT], page_count: 1 } }));
      try {
        const syncResponse = await app.request("/v1/integrations/hevy/sync", { method: "POST" });
        expect(syncResponse.status).toBe(200);
        const summary = (await syncResponse.json()) as SyncSummary;
        expect(summary).toEqual({ fetched: 1, created: 1, updated: 0 });
        // The stored secret is retrieved and forwarded as the Hevy auth header.
        expect(fetchFake.apiKeys).toEqual([apiKey]);
        expect(fetchFake.requestedUrls).toHaveLength(1);
      } finally {
        fetchFake.restore();
      }

      // The calendar surfaces the stored workout with no live provider fetch.
      const guard = withFakeHevyFetch(() => {
        throw new Error("calendar aggregation must read stored workouts, not hit the Hevy API");
      });
      try {
        const calendarResponse = await app.request(CALENDAR_RANGE);
        expect(calendarResponse.status).toBe(200);
        const body = (await calendarResponse.json()) as { items: CalendarItem[] };
        const hevyEvent = body.items.find((item) => item.id === "workout:hevy:workout-abc-123");
        expect(hevyEvent).toBeDefined();
        expect(hevyEvent).toMatchObject({
          summary: "Morning Push",
          startAt: "2032-05-10T08:00:00.000Z",
          endAt: "2032-05-10T09:00:00.000Z",
          tag: "hevy",
          source: "hevy",
          calendarId: "hevy",
          readOnly: true,
          allDay: false,
          providerEventId: "hevy:workout-abc-123",
        });
      } finally {
        guard.restore();
      }
    });
  });

  test("re-syncing the same workout reports it updated (not created) and does not duplicate the calendar event", async () => {
    await withIsolatedGateway(async (app) => {
      const saveResponse = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "hevy_resync_token" }),
      });
      expect(saveResponse.status).toBe(200);

      const fetchFake = withFakeHevyFetch(() => ({ payload: { workouts: [HEVY_WORKOUT], page_count: 1 } }));
      try {
        const first = await app.request("/v1/integrations/hevy/sync", { method: "POST" });
        expect(first.status).toBe(200);
        const firstSummary = (await first.json()) as SyncSummary;
        expect(firstSummary).toEqual({ fetched: 1, created: 1, updated: 0 });

        const second = await app.request("/v1/integrations/hevy/sync", { method: "POST" });
        expect(second.status).toBe(200);
        const secondSummary = (await second.json()) as SyncSummary;
        expect(secondSummary).toEqual({ fetched: 1, created: 0, updated: 1 });
      } finally {
        fetchFake.restore();
      }

      const guard = withFakeHevyFetch(() => {
        throw new Error("calendar aggregation must read stored workouts, not hit the Hevy API");
      });
      try {
        const calendarResponse = await app.request(CALENDAR_RANGE);
        expect(calendarResponse.status).toBe(200);
        const body = (await calendarResponse.json()) as { items: CalendarItem[] };
        const hevyEvents = body.items.filter((item) => item.source === "hevy");
        expect(hevyEvents).toHaveLength(1);
        expect(hevyEvents[0]?.id).toBe("workout:hevy:workout-abc-123");
      } finally {
        guard.restore();
      }
    });
  });
});

describe("Hevy routine listing pages past a filtered raw routine", () => {
  test("keeps paging on raw page-fill even when a page-1 routine is unparseable, returning valid routines from both pages", async () => {
    await withIsolatedGateway(async (app) => {
      const apiKey = "hevy_routines_pagination_token";
      const saveResponse = await app.request("/v1/integrations/hevy/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      expect(saveResponse.status).toBe(200);

      // Page 1 is full (10 raw routines, the max GET /v1/routines pageSize) but one has a
      // blank title and is dropped during parsing, so only 9 survive. page_count declares a
      // second page that holds the tenth valid routine — reachable only if the loop keeps
      // paging on the raw page fill rather than the smaller post-parse count.
      const pageOneRaw = [
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `routine-p1-${index + 1}`,
          title: `Routine P1 ${index + 1}`,
        })),
        { id: "routine-p1-invalid", title: "   " },
      ];
      const pageTwoRaw = [{ id: "routine-p2-1", title: "Routine P2 1" }];

      const fetchFake = withFakeHevyRoutinesFetch((page) => {
        if (page === 1) return { payload: { routines: pageOneRaw, page_count: 2 } };
        if (page === 2) return { payload: { routines: pageTwoRaw, page_count: 2 } };
        throw new Error(`unexpected routines page requested: ${page}`);
      });

      try {
        const response = await app.request("/v1/integrations/hevy/routines");
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          routines: Array<{ id: string; title: string }>;
        };
        const ids = body.routines.map((routine) => routine.id);

        // Page 2 is fetched exactly once, and paging stops at page_count without over-fetching.
        expect(fetchFake.requestedPages).toEqual([1, 2]);
        // The stored secret is forwarded (and stays the same opaque token) on every page.
        expect(fetchFake.apiKeys).toEqual([apiKey, apiKey]);
        // The unparseable routine is dropped; the valid routine that only lived on page 2 is
        // present, proving pagination did not stop early on the shortened page-1 result.
        expect(ids).not.toContain("routine-p1-invalid");
        expect(ids).toContain("routine-p2-1");
        expect(ids.filter((id) => id.startsWith("routine-p1-"))).toHaveLength(9);
        expect(ids).toHaveLength(10);
      } finally {
        fetchFake.restore();
      }
    });
  });
});
