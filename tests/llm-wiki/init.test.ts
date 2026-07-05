import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { initLlmWiki } from "../../src/llm-wiki";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "anorvis-llm-wiki-"));
}

describe("initLlmWiki", () => {
  test("creates the canonical scaffold idempotently", () => {
    const rootDir = tmpRoot();
    const first = initLlmWiki({ rootDir, now: new Date("2026-07-03T00:00:00.000Z") });
    expect(first.created).toContain("AGENTS.md");
    expect(first.created).toContain("wiki/projects");
    expect(first.created).toContain("raw/web");
    expect(readFileSync(join(rootDir, "AGENTS.md"), "utf8")).toContain("Anorvis LLM Wiki");

    writeFileSync(join(rootDir, "cache.md"), "custom cache\n");
    const second = initLlmWiki({ rootDir });
    expect(second.existing).toContain("cache.md");
    expect(readFileSync(join(rootDir, "cache.md"), "utf8")).toBe("custom cache\n");
  });
});
