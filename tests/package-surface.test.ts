import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type PackageJson = {
  scripts?: Record<string, string>;
  exports?: Record<string, string>;
};

describe("OS package surface after Convex cutover", () => {
  test("default development command starts Convex instead of the local gateway", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as PackageJson;

    expect(pkg.scripts?.dev).toBe("bun src/tools/dev.ts");
    expect(pkg.scripts?.dev).not.toContain("platform/gateway/server");
    expect(pkg.scripts?.["dev:wiki-gateway"]).toBe(
      "bun src/platform/gateway/server.ts",
    );
    expect(pkg.exports).toEqual({
      "./agent-process": "./src/core/agent/process.ts",
      "./maintenance": "./src/capability/maintenance/index.ts",
      "./package.json": "./package.json",
    });
  });

  test("wiki gateway entrypoint does not start canonical SQLite sync loops", () => {
    const serverSource = readFileSync(
      join(import.meta.dir, "..", "src", "platform", "gateway", "server.ts"),
      "utf8",
    );

    expect(serverSource).not.toContain("createSnapTradeAutoSync");
    expect(serverSource).not.toContain(".start()");
  });
});
