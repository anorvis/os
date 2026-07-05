import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { initCache, initIndex, initLog, initOverview, initRules, OBSIDIAN_APP_JSON } from "./initial-files";
import { llmWikiRoot } from "./paths";

export type InitLlmWikiResult = {
  rootDir: string;
  created: string[];
  existing: string[];
};

const REQUIRED_DIRS = [
  ".obsidian",
  "raw",
  "raw/sessions",
  "raw/vaults",
  "raw/web",
  "raw/email",
  "raw/files",
  "raw/notes",
  "wiki",
  "wiki/sources",
  "wiki/entities",
  "wiki/concepts",
  "wiki/comparisons",
  "wiki/queries",
  "wiki/projects",
  "wiki/preferences",
  "wiki/workflows",
  "wiki/decisions",
  ".index",
];

export function initLlmWiki(input: { rootDir?: string; now?: Date } = {}): InitLlmWikiResult {
  const rootDir = input.rootDir ?? llmWikiRoot();
  const now = input.now ?? new Date();
  const created: string[] = [];
  const existing: string[] = [];

  for (const dir of REQUIRED_DIRS) ensureDir(join(rootDir, dir), rootDir, created, existing);

  writeFileIfMissing(join(rootDir, ".obsidian", "app.json"), OBSIDIAN_APP_JSON, rootDir, created, existing);
  writeFileIfMissing(join(rootDir, "AGENTS.md"), initRules(now), rootDir, created, existing);
  writeFileIfMissing(join(rootDir, "index.md"), initIndex(now), rootDir, created, existing);
  writeFileIfMissing(join(rootDir, "log.md"), initLog(now), rootDir, created, existing);
  writeFileIfMissing(join(rootDir, "cache.md"), initCache(now), rootDir, created, existing);
  writeFileIfMissing(join(rootDir, "overview.md"), initOverview(now), rootDir, created, existing);

  return { rootDir, created, existing };
}

function ensureDir(path: string, rootDir: string, created: string[], existing: string[]): void {
  const rel = relative(rootDir, path) || ".";
  if (existsSync(path)) {
    existing.push(rel);
    return;
  }
  mkdirSync(path, { recursive: true });
  created.push(rel);
}

function writeFileIfMissing(path: string, content: string, rootDir: string, created: string[], existing: string[]): void {
  const rel = relative(rootDir, path);
  if (existsSync(path)) {
    existing.push(rel);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: "wx" });
  created.push(rel);
}
