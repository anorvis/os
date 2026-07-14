import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { readLocalAuthorityConfig } from "../src/core/config/local-authority";
import { createServiceRegistry, type ServiceFactory } from "../src/core/service/service";
import { resetDatabaseForTests } from "../src/core/db/database";
import { createApp } from "../src/platform/gateway/app";

describe("service registry", () => {
  test("flattens route registrars in factory order", () => {
    const calls: string[] = [];
    const factories: ServiceFactory[] = [
      () => ({ id: "first", routes: [() => { calls.push("first"); }] }),
      () => ({ id: "second", routes: [() => { calls.push("second"); }] }),
    ];
    const registry = createServiceRegistry({ config: readLocalAuthorityConfig(), now: () => new Date("2026-07-07T00:00:00.000Z") }, factories);
    const app = new Hono();
    for (const register of registry.routes) register(app);

    expect(calls).toEqual(["first", "second"]);
    expect(registry.serviceIds).toEqual(["first", "second"]);
  });

  test("rejects duplicate service ids", () => {
    const factories: ServiceFactory[] = [
      () => ({ id: "same", routes: [] }),
      () => ({ id: "same", routes: [] }),
    ];

    expect(() => createServiceRegistry({ config: readLocalAuthorityConfig(), now: () => new Date() }, factories)).toThrow("duplicate_service_id:same");
  });

  test("os status lists registry service ids", async () => {
    const environment = captureEnvironment("HOME", "ANORVIS_DB_PATH", "ANORVIS_OS_API_TOKEN", "ANORVIS_OS_API_TOKEN_PATH", "ANORVIS_OS_HOST");
    const home = mkdtempSync(join(tmpdir(), "anorvis-registry-"));
    process.env.HOME = home;
    process.env.ANORVIS_DB_PATH = join(home, "data.sqlite");
    process.env.ANORVIS_OS_HOST = "127.0.0.1";
    delete process.env.ANORVIS_OS_API_TOKEN;
    process.env.ANORVIS_OS_API_TOKEN_PATH = join(home, "missing-token");
    resetDatabaseForTests();
    try {
      const response = await createApp().request("/v1/os/status");
      expect(response.status).toBe(200);
      const body = await response.json() as { services: string[]; storage: { sqlite: string; sync: string } };
      expect(body.services).toEqual(["llm-wiki", "toolkit", "os"]);
      expect(body.storage).toEqual({ sqlite: "disabled", sync: "files-only" });
    } finally {
      resetDatabaseForTests();
      restoreEnvironment(environment);
    }
  });
});

function captureEnvironment(...keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(environment: Map<string, string | undefined>): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
