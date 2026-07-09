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

      const syncResponse = await app.request("/v1/integrations/hevy/sync", { method: "POST" });
      expect(syncResponse.status).toBe(200);
      expect(await syncResponse.json()).toEqual({ fetched: 0, created: 0, updated: 0 });
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
