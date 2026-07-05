import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractWikiLinks, firstParagraph, listMarkdownFiles, parseFrontmatter, readMarkdown, titleFromMarkdown } from "./utils";

export type ManifestPage = {
  path: string;
  title: string;
  type?: string;
  summary: string;
  links: string[];
  sources: string[];
};

export type LlmWikiManifest = {
  version: 1;
  updatedAt: string;
  pages: ManifestPage[];
};

export function rebuildManifest(rootDir: string, now: Date = new Date()): LlmWikiManifest {
  const pages = listMarkdownFiles(rootDir, "wiki").map((path) => {
    const markdown = readMarkdown(rootDir, path);
    const { frontmatter } = parseFrontmatter(markdown);
    const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
    return {
      path,
      title: titleFromMarkdown(markdown, path.split("/").pop() ?? path),
      type: typeof frontmatter.type === "string" ? frontmatter.type : undefined,
      summary: firstParagraph(markdown),
      links: extractWikiLinks(markdown),
      sources,
    };
  });
  const manifest = { version: 1 as const, updatedAt: now.toISOString(), pages };
  const path = join(rootDir, ".index", "manifest.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function readManifest(rootDir: string): LlmWikiManifest {
  const path = join(rootDir, ".index", "manifest.json");
  if (!existsSync(path)) return rebuildManifest(rootDir);
  return JSON.parse(readFileSync(path, "utf8")) as LlmWikiManifest;
}
