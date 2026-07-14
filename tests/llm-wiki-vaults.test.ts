import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/platform/gateway/app";

describe("LLM Wiki vault registry routes", () => {
  test("registers Obsidian vault directories and rejects duplicate realpaths", async () => {
    await withIsolatedGateway(async (app, home) => {
      const vaultPath = join(home, "Vault");
      mkdirSync(join(vaultPath, ".obsidian"), { recursive: true });
      const realVaultPath = realpathSync(vaultPath);

      const empty = await app.request("/v1/llm-wiki/vaults");
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ vaults: [] });

      const created = await app.request("/v1/llm-wiki/vaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Primary", path: vaultPath }),
      });
      expect(created.status).toBe(201);
      const body = await created.json() as { vault: { name: string; path: string }; vaults: Array<{ path: string }> };
      expect(body.vault.name).toBe("Primary");
      expect(body.vault.path).toBe(realVaultPath);
      expect(body.vaults).toHaveLength(1);

      const duplicate = await app.request("/v1/llm-wiki/vaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: vaultPath }),
      });
      expect(duplicate.status).toBe(400);
      expect(await duplicate.json()).toEqual({ error: "vault already registered" });
    });
  });
});

async function withIsolatedGateway(run: (app: App, home: string) => Promise<void>): Promise<void> {
  const environment = captureEnvironment("HOME", "ANORVIS_OS_API_TOKEN", "ANORVIS_OS_API_TOKEN_PATH");
  const home = mkdtempSync(join(tmpdir(), "anorvis-vaults-"));
  process.env.HOME = home;
  process.env.ANORVIS_OS_API_TOKEN_PATH = join(home, "missing-token");
  delete process.env.ANORVIS_OS_API_TOKEN;
  try {
    await run(createApp(), home);
  } finally {
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
