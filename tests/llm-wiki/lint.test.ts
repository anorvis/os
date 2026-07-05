import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { initLlmWiki, lintLlmWiki } from "../../src/llm-wiki";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "anorvis-lint-"));
}

describe("lintLlmWiki", () => {
  test("reports invalid frontmatter and missing wikilinks", async () => {
    const rootDir = tmpRoot();
    initLlmWiki({ rootDir });
    mkdirSync(join(rootDir, "wiki", "concepts"), { recursive: true });
    writeFileSync(join(rootDir, "wiki", "concepts", "bad.md"), `---\ntype: nope\ntitle: Bad\ncreated: 2026-07-03\nupdated: 2026-07-03\nstatus: unknown\ntags: []\nrelated: []\nsources: []\n---\n\n# Bad\n\n[[missing]]\n`);
    const result = await lintLlmWiki({ rootDir });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("frontmatter.valid_type");
    expect(result.issues.map((i) => i.code)).toContain("wikilinks.targets_exist");
  });
});
