import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDatabaseForTests } from "../src/core/db/database";
import { createApp } from "../src/platform/gateway/app";
import { toolkitManifest } from "../src/platform/toolkit/manifest";

function captureEnvironment(...keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(environment: Map<string, string | undefined>): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("platform toolkit", () => {
  test("exposes curated agent tools", async () => {
    const environment = captureEnvironment("HOME", "ANORVIS_DB_PATH", "ANORVIS_OS_API_TOKEN", "ANORVIS_SECRET_PROVIDER");
    const home = mkdtempSync(join(tmpdir(), "anorvis-toolkit-"));
    process.env.HOME = home;
    process.env.ANORVIS_DB_PATH = join(home, "data.sqlite");
    process.env.ANORVIS_SECRET_PROVIDER = "local";
    delete process.env.ANORVIS_OS_API_TOKEN;
    resetDatabaseForTests();
    try {
      const response = await createApp().request("/v1/os/toolkit");
      expect(response.status).toBe(200);
      const body = await response.json() as { version: number; tools: Array<{ name: string; operation: string; resource: string; parameters: Record<string, unknown> }> };
      expect(body.version).toBe(1);
      expect(body.tools.map((tool) => tool.name)).toContain("anorvis_create_task");
      expect(body.tools.map((tool) => tool.name)).toContain("anorvis_list_calendar_events");
      for (const tool of body.tools) {
        expect(tool.name.startsWith("anorvis_life_")).toBe(false);
        expect(tool.name.includes("upsert")).toBe(false);
        expect(typeof tool.operation).toBe("string");
        expect(typeof tool.resource).toBe("string");
        expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
      }
    } finally {
      resetDatabaseForTests();
      restoreEnvironment(environment);
    }
  });

  test("manifest has unique tool names and described fields", () => {
    const tools = toolkitManifest().tools;
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    const createTask = tools.find((tool) => tool.name === "anorvis_create_task");
    const properties = createTask?.parameters.properties as Record<string, Record<string, unknown>> | undefined;
    expect(properties?.dueAt?.description).toContain("ISO");
  });
});
