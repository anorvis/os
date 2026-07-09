import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabaseForTests } from "../src/core/db/database";
import { createApp, type App } from "../src/platform/gateway/app";

type ProviderConnectionRow = {
  status: string;
  settings_json: string;
  secret_refs_json: string;
};

describe("provider registry", () => {
  test("creates, connects, hides secrets, and disconnects a token provider", async () => {
    await withIsolatedGateway(async (app) => {
      const createResponse = await app.request("/v1/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "demo-token",
          displayName: "Demo Token",
          category: "productivity",
          capabilities: ["demo.read"],
          authType: "token",
        }),
      });
      expect(createResponse.status).toBe(201);

      const rawToken = "super-secret-token";
      const base64Token = Buffer.from(rawToken).toString("base64");
      const connectResponse = await app.request("/v1/providers/demo-token/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { providerName: "demo" }, secrets: { token: rawToken } }),
      });
      expect(connectResponse.status).toBe(200);
      expect(await connectResponse.json()).toEqual({ ok: true, providerId: "demo-token", status: "connected", secretProvider: "local" });

      const row = providerConnection("demo-token");
      expect(row?.status).toBe("connected");
      expect(row?.settings_json).toBe(JSON.stringify({ providerName: "demo" }));
      expect(row?.settings_json).not.toContain(rawToken);
      expect(row?.settings_json).not.toContain(base64Token);
      const refs = JSON.parse(row?.secret_refs_json ?? "{}") as Record<string, string>;
      expect(refs.token?.startsWith("secret:")).toBe(true);
      expect(row?.secret_refs_json).not.toContain(rawToken);
      expect(row?.secret_refs_json).not.toContain(base64Token);

      const listResponse = await app.request("/v1/providers");
      const listText = await listResponse.text();
      expect(listResponse.status).toBe(200);
      expect(listText).toContain("demo-token");
      expect(listText).toContain("connected");
      expect(listText).not.toContain(rawToken);
      expect(listText).not.toContain(base64Token);

      const disconnectResponse = await app.request("/v1/providers/demo-token/connection", { method: "DELETE" });
      expect(disconnectResponse.status).toBe(200);
      expect(await disconnectResponse.json()).toEqual({ ok: true });
      const disconnected = providerConnection("demo-token");
      expect(disconnected?.status).toBe("available");
      expect(disconnected?.secret_refs_json).toBe("{}");
    });
  });
});

async function withIsolatedGateway(run: (app: App) => Promise<void>): Promise<void> {
  const environment = captureEnvironment("HOME", "ANORVIS_DB_PATH", "ANORVIS_OS_API_TOKEN", "ANORVIS_OS_API_TOKEN_PATH", "ANORVIS_SECRET_PROVIDER", "ANORVIS_SECRET_KEY_PATH");
  const home = mkdtempSync(join(tmpdir(), "anorvis-providers-"));
  process.env.HOME = home;
  process.env.ANORVIS_DB_PATH = join(home, "anorvis.sqlite");
  process.env.ANORVIS_OS_API_TOKEN_PATH = join(home, "missing-token");
  delete process.env.ANORVIS_OS_API_TOKEN;
  process.env.ANORVIS_SECRET_PROVIDER = "local";
  delete process.env.ANORVIS_SECRET_KEY_PATH;
  resetDatabaseForTests();
  try {
    await run(createApp());
  } finally {
    resetDatabaseForTests();
    restoreEnvironment(environment);
  }
}

function providerConnection(providerId: string): ProviderConnectionRow | null {
  return getDatabase().query<ProviderConnectionRow, [string]>("SELECT status, settings_json, secret_refs_json FROM provider_connections WHERE provider_id = ?1").get(providerId) ?? null;
}

function captureEnvironment(...keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(environment: Map<string, string | undefined>): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
