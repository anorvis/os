import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lint as markdownlint } from "markdownlint/promise";
import { initLlmWiki } from "./init";
import { rebuildManifest } from "./manifest";
import { llmWikiRoot } from "./paths";
import { extractWikiLinks, listMarkdownFiles, parseFrontmatter, readMarkdown } from "./utils";

export type WikiLintSource = "markdownlint" | "anorvis";
export type WikiLintSeverity = "error" | "warn" | "info";
export type WikiLintIssue = {
  source: WikiLintSource;
  code: string;
  severity: WikiLintSeverity;
  path: string;
  line?: number;
  column?: number;
  message: string;
  fixHint?: string;
};
export type WikiLintResult = { ok: boolean; issues: WikiLintIssue[] };

const VALID_TYPES = new Set(["source", "entity", "concept", "comparison", "query", "project", "preference", "workflow", "decision"]);
const VALID_STATUSES = new Set(["seed", "developing", "mature", "stale"]);

export async function lintLlmWiki(input: { rootDir?: string; changedPaths?: string[] } = {}): Promise<WikiLintResult> {
  const rootDir = input.rootDir ?? llmWikiRoot();
  initLlmWiki({ rootDir });
  const issues = [...await runMarkdownlint(rootDir), ...runAnorvisLint(rootDir)];
  return { ok: !issues.some((issue) => issue.severity === "error"), issues };
}

async function runMarkdownlint(rootDir: string): Promise<WikiLintIssue[]> {
  const files = [...listMarkdownFiles(rootDir, "wiki"), "AGENTS.md", "index.md", "cache.md", "overview.md"].filter((path) => existsSync(join(rootDir, path)));
  const result = await markdownlint({ files: files.map((path) => join(rootDir, path)), config: { default: true, MD013: false, MD033: false, MD041: false } });
  const issues: WikiLintIssue[] = [];
  for (const [file, errors] of Object.entries(result)) {
    for (const error of errors) {
      issues.push({ source: "markdownlint", code: error.ruleNames[0] ?? "markdownlint", severity: "warn", path: file.replace(`${rootDir}/`, ""), line: error.lineNumber, message: error.ruleDescription, fixHint: error.errorDetail ?? undefined });
    }
  }
  return issues;
}

function runAnorvisLint(rootDir: string): WikiLintIssue[] {
  const issues: WikiLintIssue[] = [];
  const wikiPages = listMarkdownFiles(rootDir, "wiki");
  const rawPages = listMarkdownFiles(rootDir, "raw");
  const allPages = new Set([...wikiPages, ...rawPages, "AGENTS.md", "index.md", "cache.md", "log.md", "overview.md"]);
  const titleToPath = new Map(wikiPages.map((path) => [path.replace(/^wiki\//, "").replace(/\.md$/, ""), path]));

  for (const path of wikiPages) {
    const markdown = readMarkdown(rootDir, path);
    const { frontmatter } = parseFrontmatter(markdown);
    for (const key of ["type", "title", "created", "updated", "status", "tags", "related", "sources"]) {
      if (!(key in frontmatter)) issues.push(issue("frontmatter.required_fields", path, `Missing frontmatter field: ${key}`));
    }
    if (typeof frontmatter.type === "string" && !VALID_TYPES.has(frontmatter.type)) issues.push(issue("frontmatter.valid_type", path, `Invalid type: ${frontmatter.type}`));
    if (typeof frontmatter.status === "string" && !VALID_STATUSES.has(frontmatter.status)) issues.push(issue("frontmatter.valid_status", path, `Invalid status: ${frontmatter.status}`));
    if (frontmatter.sources !== undefined && !Array.isArray(frontmatter.sources)) issues.push(issue("frontmatter.sources_are_arrays", path, "sources must be an array"));
    const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
    for (const source of sources) {
      if (!allPages.has(source)) issues.push(issue("sources.raw_paths_exist", path, `Missing source path: ${source}`));
    }
    for (const link of extractWikiLinks(markdown)) {
      const target = link.endsWith(".md") ? link : titleToPath.get(link) ?? `wiki/${link}.md`;
      if (!allPages.has(target)) issues.push(issue("wikilinks.targets_exist", path, `Missing wikilink target: ${link}`, "Create the linked page or update the link."));
    }
  }

  for (const path of rawPages) {
    const markdown = readMarkdown(rootDir, path);
    const { frontmatter } = parseFrontmatter(markdown);
    for (const key of ["type", "sourceId", "kind", "captured", "hash"]) {
      if (!(key in frontmatter)) issues.push(issue("raw.valid_source_files", path, `Missing raw source field: ${key}`));
    }
    if (frontmatter.type !== "raw-source") issues.push(issue("raw.valid_source_files", path, "Raw source type must be raw-source"));
  }

  const manifest = rebuildManifest(rootDir);
  if (manifest.pages.length !== wikiPages.length) issues.push(issue("manifest.matches_wiki_pages", ".index/manifest.json", "Manifest page count does not match wiki pages"));
  const cache = readFileSync(join(rootDir, "cache.md"), "utf8");
  if (cache.length > 12_000) issues.push(issue("cache.within_budget", "cache.md", "cache.md is over 12KB", "Summarize recent context."));
  return issues;
}

function issue(code: string, path: string, message: string, fixHint?: string): WikiLintIssue {
  return { source: "anorvis", code, severity: "error", path, message, fixHint };
}

export function applyDeterministicLintFixes(input: { rootDir?: string } = {}): void {
  const rootDir = input.rootDir ?? llmWikiRoot();
  rebuildManifest(rootDir);
  const cachePath = join(rootDir, "cache.md");
  if (existsSync(cachePath)) {
    const cache = readFileSync(cachePath, "utf8");
    if (cache.length > 12_000) writeFileSync(cachePath, `${cache.slice(0, 11_500)}\n\n<!-- trimmed by Anorvis lint -->\n`);
  }
}

if (import.meta.main) {
  const result = await lintLlmWiki();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
