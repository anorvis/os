import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDatabaseForTests } from "../src/core/db/database";
import { createApp } from "../src/platform/gateway/app";

describe("OS status and auth", () => {
  test("non-loopback with configured token returns Tailnet config", async () => {
    await withEnv({ host: "0.0.0.0", token: "tailnet-token", tailnetName: "pi-tailnet" }, async () => {
      const response = await createApp().request("/v1/os/status", { headers: { authorization: "Bearer tailnet-token" } });
      expect(response.status).toBe(200);
      const body = await response.json() as { authority: { bindHost: string; tailnetName: string | null; storageMode: string }; storage: { sqlite: string; sync: string } };
      expect(body.authority.bindHost).toBe("0.0.0.0");
      expect(body.authority.tailnetName).toBe("pi-tailnet");
      expect(body.authority.storageMode).toBe("centralized");
      expect(body.storage).toEqual({ sqlite: "disabled", sync: "files-only" });
    });
  });

  test("non-loopback without token rejects protected routes but leaves public routes reachable", async () => {
    await withEnv({ host: "0.0.0.0" }, async () => {
      const app = createApp();
      const status = await app.request("/v1/os/status");
      expect(status.status).toBe(503);
      expect(await status.json()).toEqual({ error: "auth_token_required" });

      const health = await app.request("/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const handshake = await app.request("/v1/auth/handshake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "1234567890123456" }),
      });
      expect(handshake.status).toBe(201);
    });
  });

  test("loopback without token allows protected same-device routes", async () => {
    await withEnv({ host: "127.0.0.1" }, async () => {
      const response = await createApp().request("/v1/os/status");
      expect(response.status).toBe(200);
    });
  });
});

type EnvOptions = { host: string; token?: string; tailnetName?: string };

async function withEnv(options: EnvOptions, run: () => Promise<void>): Promise<void> {
  const environment = captureEnvironment(
    "HOME",
    "ANORVIS_DB_PATH",
    "ANORVIS_OS_API_TOKEN",
    "ANORVIS_OS_API_TOKEN_PATH",
    "ANORVIS_OS_HOST",
    "ANORVIS_TAILNET_NAME",
  );
  const home = mkdtempSync(join(tmpdir(), "anorvis-auth-"));
  process.env.HOME = home;
  process.env.ANORVIS_DB_PATH = join(home, "anorvis.sqlite");
  process.env.ANORVIS_OS_API_TOKEN_PATH = join(home, "missing-token");
  process.env.ANORVIS_OS_HOST = options.host;
  if (options.token) process.env.ANORVIS_OS_API_TOKEN = options.token;
  else delete process.env.ANORVIS_OS_API_TOKEN;
  if (options.tailnetName) process.env.ANORVIS_TAILNET_NAME = options.tailnetName;
  else delete process.env.ANORVIS_TAILNET_NAME;
  resetDatabaseForTests();
  try {
    await run();
  } finally {
    resetDatabaseForTests();
    restoreEnvironment(environment);
  }
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
